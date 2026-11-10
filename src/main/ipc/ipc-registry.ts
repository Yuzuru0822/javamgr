/**
 * IPC 注册中心（计划 §2.5 / §3 S1.3）。
 *
 * 职责边界：本文件只做「入参 zod 校验 + 转发服务层（config-store / 后续各服务）」，
 * 不含配置 CRUD、扫描、进程、日志的业务逻辑。
 *
 * S1 实现状态：
 * - 真逻辑：projects:list/create/update/delete、settings:get/set、app:getMcpInfo
 * - S2 接通：jdk:list/scan/validate/add/update/remove（jdk-scanner + config-store；
 *   scan 进度经 jdk:scanProgress 事件推送；add/update 路径由主进程校验派生版本信息）
 * - 显式 NOT_IMPLEMENTED（校验参数后返回结构化错误，后续阶段逐个替换）：
 *   projects:start/stop/restart/startAll/stopAll → S3；logs:readHistory/search → S4
 *
 * delete 语义（§2.5）：confirm=true 先 stop（等待进程树死亡）再删配置；运行中且
 * confirm=false 拒绝。S1 无进程概念，ProcessControl 缺省视为全部 STOPPED（直接删）；
 * S3 由 process-manager 注入实现。
 *
 * 错误协议：所有异常（含 zod 校验失败）转 {@link StructuredIpcError} JSON 塞进
 * Error.message 抛出（IPC 只传 message），渲染端 api/ipc.ts 还原为带 .code 的 Error。
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { ZodError } from 'zod'
import { IPC_EVENTS, IPC_REQUESTS } from '../../shared/ipc-channels'
import { encodeIpcErrorPayload } from '../../shared/ipc-error'
import type { IpcErrorCode, StructuredIpcError } from '../../shared/ipc-error'
import type {
  BatchResult,
  EventLoopMetrics,
  Jdk,
  JdkValidation,
  McpInfo,
  OpResult,
  ProjectRuntimeState,
  ProjectWithRuntime,
  ReadHistoryParams,
  ReadHistoryResult,
  ScanProgressEvent,
  SearchParams,
  SearchResult
} from '../../shared/types'
import { ConfigError } from '../config/config-store'
import type { ConfigStore } from '../config/config-store'
import {
  DEFAULT_SCAN_ROOTS,
  mergeJdks,
  normalizeHomePath,
  scanJdks,
  validateJdkPath
} from '../jdk/jdk-scanner'
import type { McpHostStatus } from '../mcp/mcp-host'
import * as S from './schemas'

// ---------- S3 注入点：进程控制 ----------

/**
 * S3 由 process-manager 注入（GUI 与 MCP S5 同源调用同一实例）；
 * 缺省 = 无进程概念（全部视为 STOPPED，delete 直接删；启停通道 NOT_IMPLEMENTED）。
 */
export interface ProcessControl {
  /** projectId → 实时状态快照（undefined = 无运行记录） */
  getRuntimeState(projectId: string): ProjectRuntimeState | undefined
  startProject(projectId: string): Promise<OpResult>
  /** timeoutMs：本次停止树终止预算（MCP stop_project 契约；IPC 侧缺省用服务层默认 8000） */
  stopProject(projectId: string, timeoutMs?: number): Promise<OpResult>
  /** stopTimeoutMs：组合内 stop 预算（MCP restart_project 契约；缺省用服务层默认 8000） */
  restartProject(projectId: string, stopTimeoutMs?: number): Promise<OpResult>
  startAllProjects(): Promise<BatchResult>
  stopAllProjects(): Promise<BatchResult>
}

export interface IpcDependencies {
  store: ConfigStore
  /** 缺省视为所有项目 STOPPED */
  processControl?: ProcessControl
  /** S4 日志服务（log-manager 注入；缺省 logs 通道 NOT_IMPLEMENTED） */
  logService?: LogControl
  /** S5 MCP 运行状态（mcp-host 注入；缺省 app:getMcpInfo 按设置派生、enabled=false） */
  mcpStatus?: { getMcpStatus(): McpHostStatus }
  /** N-6 事件循环打点（index.ts 注入 EventLoopMonitor；缺省返回零值指标） */
  eventLoop?: { getMetrics(): EventLoopMetrics }
}

// ---------- S4 注入点：日志服务 ----------

/**
 * S4 由 log-manager 注入（IPC 与 MCP search_logs/read_logs S5 同源调用）；
 * switchRoute 由 projects:update 的 logFilePath diff 触发（即时切换路由 + 重置游标）。
 */
export interface LogControl {
  readHistory(params: ReadHistoryParams): Promise<ReadHistoryResult>
  search(params: SearchParams): Promise<SearchResult>
  /** logFilePath 变更即时切换日志路由（运行中生效） */
  switchRoute(projectId: string): void
}

// ---------- 结构化错误 ----------

/** 内部信封：携带结构化载荷穿越 register() 统一出口 */
class IpcFailure extends Error {
  constructor(readonly payload: StructuredIpcError) {
    super(payload.message)
    this.name = 'IpcFailure'
  }
}

function fail(code: IpcErrorCode, message: string, details?: unknown): never {
  throw new IpcFailure({ code, message, ...(details !== undefined ? { details } : {}) })
}

function toStructuredError(err: unknown, channel: string): StructuredIpcError {
  if (err instanceof IpcFailure) return err.payload
  if (err instanceof ConfigError) return { code: err.code, message: err.message }
  if (err instanceof ZodError) {
    const issues = err.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('；')
    return {
      code: 'VALIDATION_ERROR',
      message: `参数校验失败（${channel}）：${issues}`,
      details: err.issues
    }
  }
  return {
    code: 'INTERNAL',
    message: `主进程内部错误（${channel}）：${err instanceof Error ? err.message : String(err)}`
  }
}

// ---------- 注册基建 ----------

function register(channel: string, handler: (raw: unknown) => unknown): void {
  ipcMain.handle(channel, async (_event, raw: unknown) => {
    try {
      return await handler(raw)
    } catch (err) {
      const structured = toStructuredError(err, channel)
      if (structured.code === 'INTERNAL') {
        console.error(`[ipc] ${channel} 未预期异常：`, err)
      }
      throw new Error(encodeIpcErrorPayload(structured))
    }
  })
}

/** 主进程 → 渲染进程事件广播（§2.5 Events；无窗口时静默丢弃）。导出供装配层（index.ts）接 process-manager 广播复用。 */
export function broadcastEvent(channel: typeof IPC_EVENTS[keyof typeof IPC_EVENTS], payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

const RUNNING_STATES = new Set(['RUNNING', 'STARTING'])

// ---------- 注册入口 ----------

export function registerIpcHandlers(deps: IpcDependencies): void {
  const { store } = deps
  const runtimeOf = (projectId: string): ProjectRuntimeState =>
    deps.processControl?.getRuntimeState(projectId) ?? { status: 'STOPPED' }

  /** 启停通道统一守卫：未注入 processControl（装配异常）时显式报错而非静默 */
  const requireProcessControl = (channel: string): ProcessControl => {
    if (!deps.processControl) {
      fail('INTERNAL', `通道 ${channel} 不可用：主进程未装配进程管理器（processControl 缺失）`)
    }
    return deps.processControl
  }

  // ===== projects：真逻辑（config-store） =====

  register(IPC_REQUESTS.PROJECTS_LIST, () =>
    store.listProjects().map<ProjectWithRuntime>((p) => ({ ...p, ...runtimeOf(p.id) }))
  )

  register(IPC_REQUESTS.PROJECTS_CREATE, (raw) => store.createProject(S.projectCreateSchema.parse(raw)))

  register(IPC_REQUESTS.PROJECTS_UPDATE, async (raw) => {
    const input = S.projectUpdateSchema.parse(raw)
    const before = store.listProjects().find((p) => p.id === input.id)
    const updated = await store.updateProject(input)
    // logFilePath 变更例外：即时切换日志路由 + 重置游标（§2.5 update 语义；S4 接通）
    const beforePath = before?.logFilePath ?? ''
    if (before && (beforePath ?? '') !== (updated.logFilePath ?? '')) {
      deps.logService?.switchRoute(input.id)
    }
    // TODO(P3-9, phase4 审查)：encodingOverride 变更对运行中进程不即时生效——解码器按
    // run 持有（F3"锁定后按 run 缓存"），下次启动才应用；属有意设计，如需即时生效需
    // 重建该 run 的解码器（UI 提示也在待办）。
    return updated
  })

  register(IPC_REQUESTS.PROJECTS_DELETE, async (raw) => {
    const { id, confirm } = S.projectDeleteSchema.parse(raw)
    const status = deps.processControl?.getRuntimeState(id)?.status
    if (RUNNING_STATES.has(status ?? 'STOPPED') && !confirm) {
      fail(
        'CONFLICT',
        `项目正在运行（${status}），拒绝删除；确认删除将先停止进程并移除纳管，请携带 confirm=true 重试`,
        { id, status }
      )
    }
    if (confirm && RUNNING_STATES.has(status ?? 'STOPPED') && deps.processControl) {
      // S3：走操作队列等待进程树死亡后再删配置（§2.5 delete 语义）
      const stopResult = await deps.processControl.stopProject(id)
      if (!stopResult.ok) {
        fail('INTERNAL', `停止进程失败，已取消删除：${stopResult.error ?? '未知错误'}`, { id })
      }
    }
    await store.deleteProject(id) // 返回被删 Project，但通道契约返回 void
  })

  // ===== projects：启停（S3 process-manager；幂等/串行化语义见计划 §2.3-A） =====

  register(IPC_REQUESTS.PROJECTS_START, (raw) => {
    const { id } = S.projectIdSchema.parse(raw)
    return requireProcessControl(IPC_REQUESTS.PROJECTS_START).startProject(id)
  })
  register(IPC_REQUESTS.PROJECTS_STOP, (raw) => {
    const { id } = S.projectIdSchema.parse(raw)
    return requireProcessControl(IPC_REQUESTS.PROJECTS_STOP).stopProject(id)
  })
  register(IPC_REQUESTS.PROJECTS_RESTART, (raw) => {
    const { id } = S.projectIdSchema.parse(raw)
    return requireProcessControl(IPC_REQUESTS.PROJECTS_RESTART).restartProject(id)
  })
  register(IPC_REQUESTS.PROJECTS_START_ALL, () =>
    requireProcessControl(IPC_REQUESTS.PROJECTS_START_ALL).startAllProjects()
  )
  register(IPC_REQUESTS.PROJECTS_STOP_ALL, () =>
    requireProcessControl(IPC_REQUESTS.PROJECTS_STOP_ALL).stopAllProjects()
  )

  // ===== jdk：真逻辑（jdk-scanner + config-store，S2） =====

  register(IPC_REQUESTS.JDK_LIST, () => store.listJdks())

  register(IPC_REQUESTS.JDK_VALIDATE, async (raw): Promise<JdkValidation> => {
    const { homePath } = S.jdkValidateSchema.parse(raw)
    return validateJdkPath(homePath)
  })

  register(IPC_REQUESTS.JDK_ADD, async (raw) => {
    const { homePath, name } = S.jdkAddSchema.parse(raw)
    // 服务端复检（不信任渲染端自报信息）：路径判定 + 派生版本/发行方
    const validation = await validateJdkPath(homePath)
    if (!validation.ok || !validation.jdk) {
      fail('VALIDATION_ERROR', `JDK 添加失败：${validation.error}`, { homePath })
    }
    const draft = validation.jdk
    // 按 homePath 去重：重复添加给出明确冲突而非产生重复条目
    const dup = store
      .listJdks()
      .find((j) => normalizeHomePath(j.homePath) === normalizeHomePath(draft.homePath))
    if (dup) {
      fail('CONFLICT', `该路径已存在（${dup.name}）：${dup.homePath}`, { id: dup.id })
    }
    await store.addJdk({ ...draft, ...(name !== undefined ? { name } : {}) })
    return store.listJdks()
  })

  register(IPC_REQUESTS.JDK_UPDATE, async (raw) => {
    const { id, homePath, name } = S.jdkUpdateSchema.parse(raw)
    const existing = store.listJdks().find((j) => j.id === id)
    if (!existing) {
      fail('NOT_FOUND', `JDK 不存在：${id}`)
    }
    // 仅路径实际变化才重新校验派生（改自定义名称不触发探测）
    let base: Jdk = existing
    if (normalizeHomePath(homePath) !== normalizeHomePath(existing.homePath)) {
      const validation = await validateJdkPath(homePath)
      if (!validation.ok || !validation.jdk) {
        fail('VALIDATION_ERROR', `JDK 路径校验失败：${validation.error}`, { id, homePath })
      }
      base = { ...validation.jdk, id } // 保留原 id（项目 jdkId 引用不失效）
    }
    // 新路径不得与其他条目重复（按 homePath 规范化比对，排除自身）
    const dup = store
      .listJdks()
      .find(
        (j) => j.id !== id && normalizeHomePath(j.homePath) === normalizeHomePath(base.homePath)
      )
    if (dup) {
      fail('CONFLICT', `该路径已被「${dup.name}」使用：${dup.homePath}`, { id: dup.id })
    }
    await store.updateJdk({ ...base, ...(name !== undefined ? { name } : {}) })
    return store.listJdks()
  })

  register(IPC_REQUESTS.JDK_REMOVE, async (raw) => {
    const { id } = S.jdkRemoveSchema.parse(raw)
    await store.removeJdk(id) // 被项目引用 → ConfigError CONFLICT（含引用项目名，S1 已实现）
    return store.listJdks()
  })

  register(IPC_REQUESTS.JDK_SCAN, async () => {
    const settings = store.getSettings()
    const scanned = await scanJdks({
      roots: [...DEFAULT_SCAN_ROOTS, ...settings.scanRoots],
      onProgress: (progress: ScanProgressEvent) =>
        broadcastEvent(IPC_EVENTS.JDK_SCAN_PROGRESS, progress)
    })
    // 合并：手动条目原样保留；scan 条目刷新元数据保 id；新发现追加（jdk-scanner.mergeJdks）
    const merged = mergeJdks(store.listJdks(), scanned)
    await store.replaceJdks(merged)
    return merged
  })

  // ===== logs：S4 log-manager（IPC 与 MCP read_logs/search_logs 同源） =====

  const requireLogService = (channel: string): LogControl => {
    if (!deps.logService) {
      fail('NOT_IMPLEMENTED', `通道 ${channel} 不可用：主进程未装配日志管理器（logService 缺失）`)
    }
    return deps.logService
  }

  register(IPC_REQUESTS.LOGS_READ_HISTORY, (raw) => {
    const params = S.readHistorySchema.parse(raw)
    return requireLogService(IPC_REQUESTS.LOGS_READ_HISTORY).readHistory(params)
  })

  register(IPC_REQUESTS.LOGS_SEARCH, (raw) => {
    const params = S.searchSchema.parse(raw)
    return requireLogService(IPC_REQUESTS.LOGS_SEARCH).search(params)
  })

  // ===== settings：真逻辑 =====

  register(IPC_REQUESTS.SETTINGS_GET, () => store.getSettings())

  register(IPC_REQUESTS.SETTINGS_SET, (raw) => store.setSettings(S.settingsSetSchema.parse(raw)))

  // ===== app =====

  // ===== N-6：事件循环打点（设置页查看；未注入 monitor 时返回零值指标） =====
  register(IPC_REQUESTS.APP_GET_EVENT_LOOP_METRICS, (): EventLoopMetrics => {
    return (
      deps.eventLoop?.getMetrics() ?? {
        lastMs: 0,
        p95Ms: 0,
        samples: 0,
        windowMs: 30_000,
        sustainedHigh: false
      }
    )
  })

  register(IPC_REQUESTS.APP_GET_MCP_INFO, (): McpInfo => {
    const settings = store.getSettings()
    // S5：真实监听状态（mcp-host 注入；enabled=实际监听中，端口被占时显式携带错误与占用进程名）
    const status = deps.mcpStatus?.getMcpStatus()
    // 桥接命令不含端口（stdio 配置永远有效，主实例端口自动发现，§2.3-E）：
    // 打包后 execPath 即 javamgr.exe；开发期 electron.exe 需补应用目录参数
    const bridgeCommand = app.isPackaged
      ? `"${process.execPath}" --mcp-stdio`
      : `"${process.execPath}" "${app.getAppPath()}" --mcp-stdio`
    return {
      enabled: status?.enabled ?? false,
      port: status?.port ?? settings.mcpPort, // 契约端口：失败时也展示设定值（URL 契约锚点）
      url: `http://127.0.0.1:${status?.port ?? settings.mcpPort}/mcp`,
      bridgeCommand,
      ...(status?.error !== undefined ? { error: status.error } : {}),
      ...(status?.occupantName !== undefined ? { occupantName: status.occupantName } : {})
    }
  })

  register(IPC_REQUESTS.APP_PICK_FILE, async (raw): Promise<string | null> => {
    const { title, filters } = S.pickFileSchema.parse(raw)
    const result = await dialog.showOpenDialog({
      ...(title !== undefined ? { title } : {}),
      properties: ['openFile'],
      ...(filters !== undefined && filters.length > 0 ? { filters } : {})
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })
}
