/**
 * 日志路由与订阅分发（计划 §2.3-C / §3 S4.5，S-1 握手）。
 *
 * 单一编排点：
 * - **路由**：项目配置 logFilePath → FileTailer；否则 → StdoutCapture（stderr 并流）。
 *   两路互斥；**每 run 始终挂 StdoutCapture 消费管道**（file 路仅排空不转发），
 *   保证 logFilePath 变更即时切换（switchRoute）时 stdout 侧无背压且可无缝接管转发；
 * - **握手（S-1，防循环依赖）**：订阅 process-manager 的 run:started（装配层经
 *   setLogHooks 注入 → handleRunStarted，获得 pid 与管道句柄）；反向首行信号经注入的
 *   markRunning(projectId) **只发信号不改状态**（STARTING→RUNNING 由 process-manager 决定）；
 *   本模块不 import process-manager（句柄事件以结构兼容的 RunStartHandoff 接收）；
 * - **批量推送（R7）**：行缓冲 200ms 或 100 行批量，经注入 broadcaster 发
 *   `log:appended {projectId, source, lines}`；
 * - **readHistory / search**：IPC logs:readHistory 与 MCP read_logs（S5）同源；
 *   source=auto 按项目配置路由；file 路 tail 配置文件，stdout 路 tail 最新 run 落盘文件；
 * - **生命周期**：进程终态（handleStatusChanged，装配层从 proc:statusChanged 广播接入）
 *   → flush 残行批量 + 关闭 tailer/管道/writer；
 * - **重识别进程（无管道，ADR 已知限制 1）**：file 路经 ensureTailing 继续 tail；
 *   stdout 路管道已断，仅历史可查（readHistory）。
 *
 * 本模块零 electron 依赖（broadcaster/markRunning 注入，纯 Node 可测）。
 */

import type { Readable } from 'node:stream'
import path from 'node:path'
import type {
  LogAppendedEvent,
  LogCleanupResult,
  LogCleanupScope,
  LogSource,
  LogStorageInfo,
  Project,
  ReadHistoryParams,
  ReadHistoryResult,
  SearchParams,
  SearchResult,
  StatusChangedEvent
} from '../../shared/types'
import type { ConfigStore } from '../config/config-store'
import { RunDecoder } from './encoding'
import { FileTailer, tailFileLines } from './file-tailer'
import { LogStore } from './log-store'
import type { RunLogWriter } from './log-store'
import { searchLogFiles } from './log-search'
import { StdoutCapture } from './stdout-capture'

/** run:started 载荷（结构兼容 process-manager 的 RunStartedEvent；不 import 以维持单向依赖） */
export interface RunStartHandoff {
  projectId: string
  pid: number
  runId: string
  logSource: LogSource
  stdout?: Readable
  stderr?: Readable
}

/** UI/MCP 推送通道（装配层接到 webContents.send(log:appended)） */
export type LogBroadcaster = (chunk: LogAppendedEvent) => void

export interface LogManagerOptions {
  store: ConfigStore
  /** 当前 stdout 持久化根目录 */
  logsDir: string
  /** 默认 <userData>/logs，用于占用展示及显式清理旧目录 */
  legacyLogsDir?: string
  /** 启动时目录校验失败：保留实时日志但禁用 stdout 持久化，绝不回写默认 C 盘 */
  storageError?: string
  /** 周期清理间隔，默认 1 小时；测试可注入小值 */
  cleanupIntervalMs?: number
  /** 批量推送通道（缺省不推送，仅落盘——测试/无窗口场景） */
  broadcaster?: LogBroadcaster
  /** log → process 唯一信号通道：首条日志到达（S-1：只发信号，不改状态） */
  markRunning?: (projectId: string) => void
  /** tailer stat 兜底轮询间隔（默认 2000ms；测试注入小值加速） */
  tailPollIntervalMs?: number
}

interface ProjectLogState {
  route: LogSource
  runId?: string
  /** stdout/stderr 共享解码器（按 run 持有 = F3"锁定后按 run 缓存"） */
  decoder?: RunDecoder
  capture?: StdoutCapture
  /** stdout 行是否被消费（stdout 路 = true；file 路 = false 仅排空防背压） */
  forwarding: boolean
  tailer?: FileTailer
  /** file 路独立解码器（日志文件编码与 stdout 无关，tailer 会话独立判定） */
  tailDecoder?: RunDecoder
  writer?: RunLogWriter
  batch: string[]
  /** 批量首行进入时的来源标签（P3-1，phase4 审查：行按其真实来源路由标注，不随切换瞬间的 state.route 错标） */
  batchSource?: LogSource
  batchTimer?: NodeJS.Timeout
  firstLineSignaled: boolean
}

/** 批量推送阈值（R7：200ms 或 100 行） */
const BATCH_FLUSH_LINES = 100
const BATCH_FLUSH_MS = 200
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const ERROR_THROTTLE_MS = 10_000

function boundedSetting(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback
}

export class LogManager {
  private readonly store: ConfigStore
  private readonly broadcaster?: LogBroadcaster
  private readonly markRunning?: (projectId: string) => void
  private readonly tailPollIntervalMs: number
  private readonly cleanupIntervalMs: number
  private readonly logStore: LogStore
  private readonly logStoreDirectory: string
  private readonly legacyLogStore?: LogStore
  private readonly defaultLogsDir: string
  private readonly storageError?: string
  private readonly states = new Map<string, ProjectLogState>()
  private readonly writerCloses = new Set<Promise<void>>()
  private readonly cleanupTasks = new Set<Promise<LogCleanupResult>>()
  private readonly lastErrorAt = new Map<string, number>()
  private cleanupTimer: NodeJS.Timeout | undefined
  private maintenanceStarted = false
  private stopping = false
  private lastCleanupAt: string | undefined
  private lastCleanupErrors: string[] = []

  constructor(opts: LogManagerOptions) {
    this.store = opts.store
    this.broadcaster = opts.broadcaster
    this.markRunning = opts.markRunning
    this.tailPollIntervalMs = opts.tailPollIntervalMs ?? 2_000
    this.cleanupIntervalMs = opts.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS
    this.defaultLogsDir = opts.legacyLogsDir ?? opts.logsDir
    this.logStoreDirectory = opts.logsDir
    this.storageError = opts.storageError
    const logStoreOptions = {
      getLimits: () => {
        const s = this.store.getSettings()
        return {
          maxFileBytes: boundedSetting(s.logMaxFileMb, 1, 1024, 10) * 1024 * 1024,
          maxRotations: boundedSetting(s.logMaxRotations, 1, 10, 3),
          // 非有限数/非整数同样回落，防止 Infinity 令轮转循环或保留治理失效
          runsToKeep: boundedSetting(s.logRunsToKeep, 1, 100, 10),
          retentionMs: boundedSetting(s.logRetentionDays, 1, 365, 7) * 24 * 60 * 60 * 1000,
          maxTotalBytes: boundedSetting(s.logMaxTotalMb, 1, 1048576, 512) * 1024 * 1024
        }
      }
    }
    this.logStore = new LogStore({ logsDir: opts.logsDir, ...logStoreOptions })
    if (opts.legacyLogsDir && path.resolve(opts.legacyLogsDir) !== path.resolve(opts.logsDir)) {
      // 旧默认目录专用实例：允许显式 legacyDefault 全删
      this.legacyLogStore = new LogStore({
        logsDir: opts.legacyLogsDir,
        allowPurge: true,
        ...logStoreOptions
      })
    }
  }

  // ==================== run 生命周期（S-1 正向通道） ====================

  /** run:started：交付管道 → 挂捕获 + 按配置路由（file=tailer / stdout=捕获落盘） */
  handleRunStarted(event: RunStartHandoff): void {
    const project = this.findProject(event.projectId)
    if (!project) return // 项目已删：只排空管道防子进程写阻塞
    this.trackTeardown(this.teardown(event.projectId))

    const route: LogSource = project.logFilePath ? 'file' : 'stdout'
    const state: ProjectLogState = {
      route,
      runId: event.runId,
      forwarding: route === 'stdout',
      batch: [],
      firstLineSignaled: false
    }
    this.states.set(event.projectId, state)

    // 每 run 恒挂捕获：stdout 路转发消费；file 路排空（forwarding=false 丢弃）
    const decoder = new RunDecoder({ encodingOverride: encodingOverrideOf(project) })
    state.decoder = decoder
    state.capture = new StdoutCapture({
      stdout: event.stdout,
      stderr: event.stderr,
      decoder,
      onLines: (lines) => {
        if (state.forwarding) this.ingest(event.projectId, lines)
      }
    })
    state.capture.start()

    if (route === 'stdout') {
      if (!this.storageError) {
        try {
          state.writer = this.logStore.openRun(event.projectId, event.runId)
        } catch (err) {
          // 落盘不可用时降级为「仅实时推送」，不得让日志侧异常中断进程启动
          this.reportError(`open-run:${event.projectId}`, '打开 stdout 日志写入器失败', err)
        }
      }
    } else {
      this.startTailer(event.projectId, project, state)
    }
  }

  /** proc:statusChanged 接入点（装配层转接）：终态 → flush 残行 + 关闭路由组件 */
  handleStatusChanged(payload: StatusChangedEvent): void {
    if (payload.status === 'STOPPED' || payload.status === 'ABNORMAL_EXIT') {
      this.trackTeardown(this.teardown(payload.projectId))
    }
  }

  /**
   * logFilePath 变更即时切换（S3 预留 update 钩子，ipc-registry diff 后调用）：
   * 两路互斥 + 重置游标；无活动 run 时仅记录（下次 run 生效）。
   */
  switchRoute(projectId: string): void {
    const project = this.findProject(projectId)
    if (!project) {
      this.trackTeardown(this.teardown(projectId))
      return
    }
    const state = this.states.get(projectId)
    if (!state) return
    const newRoute: LogSource = project.logFilePath ? 'file' : 'stdout'
    if (state.route === newRoute && newRoute === 'file' && state.tailer) {
      // file → file（改路径）：重建 tailer 重置游标
      void state.tailer.stop()
      state.tailer = undefined
      state.tailDecoder = undefined
      this.startTailer(projectId, project, state)
      return
    }
    if (newRoute === 'file') {
      // stdout → file：先把旧来源 batch 交给原 writer，再关闭；不得先 close 导致残批只广播不落盘。
      state.forwarding = false
      this.flushBatch(projectId)
      const writer = state.writer
      state.writer = undefined
      if (writer) this.trackWriterClose(writer)
      state.route = newRoute
      this.startTailer(projectId, project, state)
      return
    }

    // file → stdout：停 tailer，接管转发（切换点之前的 stdout 已排空丢弃）。
    void state.tailer?.stop()
    state.tailer = undefined
    state.tailDecoder = undefined
    this.flushBatch(projectId)
    state.route = newRoute
    state.forwarding = true
    if (!this.storageError) {
      const runId = state.runId ?? `switch-${Date.now()}`
      try {
        state.writer = this.logStore.openRun(projectId, runId)
      } catch (err) {
        // 极快的 stdout→file→stdout 往返可能撞上同名 writer 关闭尾段；换独立 run 防复用。
        if (!this.logStore.hasRun(projectId, runId)) {
          this.reportError(`open-run:${projectId}`, '打开 stdout 日志写入器失败', err)
          return
        }
        state.runId = `switch-${Date.now()}`
        try {
          state.writer = this.logStore.openRun(projectId, state.runId)
        } catch (switchErr) {
          this.reportError(`open-run:${projectId}`, '打开 stdout 日志写入器失败', switchErr)
        }
      }
    }
    return
  }

  /**
   * 重识别进程的 file 路 tail 续接（装配层在 processManager.initialize() 后对
   * RUNNING 项目调用；stdout 路无管道不可增量捕获——ADR 已知限制 1，仅历史可查）。
   */
  ensureTailing(projectId: string): void {
    const project = this.findProject(projectId)
    if (!project?.logFilePath) return
    let state = this.states.get(projectId)
    if (!state) {
      state = { route: 'file', forwarding: false, batch: [], firstLineSignaled: false }
      this.states.set(projectId, state)
    }
    if (state.tailer) return
    this.startTailer(projectId, project, state)
  }

  /** 配置与进程重识别完成后调用：立即清理一次，之后每小时 single-flight 清理。 */
  startMaintenance(): void {
    if (this.maintenanceStarted || this.stopping) return
    this.maintenanceStarted = true
    void this.cleanupNow('current')
    this.cleanupTimer = setInterval(() => {
      void this.cleanupNow('current')
    }, this.cleanupIntervalMs)
    this.cleanupTimer.unref()
  }

  /** 保留设置保存后调用；设置已持久化，清理部分失败只进入结果，不回滚设置。 */
  applyRetentionSettings(): Promise<LogCleanupResult> {
    return this.cleanupNow('current')
  }

  /** current=按保留策略；legacyDefault=显式清空旧默认根内可确认属于 javamgr 的日志。 */
  cleanupNow(scope: LogCleanupScope = 'current'): Promise<LogCleanupResult> {
    const task = this.performCleanup(scope)
    this.cleanupTasks.add(task)
    void task.then(
      () => this.cleanupTasks.delete(task),
      () => this.cleanupTasks.delete(task)
    )
    return task
  }

  private async performCleanup(scope: LogCleanupScope): Promise<LogCleanupResult> {
    const target = scope === 'legacyDefault' ? this.legacyLogStore : this.logStore
    const logsDir = scope === 'legacyDefault' ? this.defaultLogsDir : this.logStoreDirectory
    if (!target) {
      return {
        scope,
        logsDir,
        freedBytes: 0,
        deletedFiles: 0,
        remainingBytes: 0,
        activeBytes: 0,
        errors: ['旧默认目录与当前目录相同，拒绝将当前日志按旧目录全量清理'],
        cleanedAt: new Date().toISOString()
      }
    }
    try {
      const result = await target.cleanup(scope)
      if (scope === 'current') {
        this.lastCleanupAt = result.cleanedAt
        this.lastCleanupErrors = [...result.errors]
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (scope === 'current') {
        this.lastCleanupAt = new Date().toISOString()
        this.lastCleanupErrors = [message]
      }
      let remainingBytes = 0
      let activeBytes = 0
      try {
        const stats = await target.getStorageStats()
        remainingBytes = stats.totalBytes
        activeBytes = stats.activeBytes
      } catch {
        // 根目录本身不可读时保留 0，并由 errors 明确报告本次清理失败。
      }
      return {
        scope,
        logsDir,
        freedBytes: 0,
        deletedFiles: 0,
        remainingBytes,
        activeBytes,
        errors: [message],
        cleanedAt: new Date().toISOString()
      }
    }
  }

  async getStorageInfo(): Promise<LogStorageInfo> {
    let totalBytes = 0
    let activeBytes = 0
    const errors = [...this.lastCleanupErrors]
    try {
      const stats = await this.logStore.getStorageStats()
      totalBytes = stats.totalBytes
      activeBytes = stats.activeBytes
      errors.push(...stats.errors)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
    return {
      logsDir: this.logStoreDirectory,
      defaultLogsDir: this.defaultLogsDir,
      totalBytes,
      activeBytes,
      ...(this.lastCleanupAt ? { lastCleanupAt: this.lastCleanupAt } : {}),
      errors: [...new Set(errors)],
      ...(this.storageError ? { storageError: this.storageError } : {})
    }
  }

  /** 停止周期触发，等待所有生产者、writer 和清理任务完成后再允许 Electron 退出。 */
  async shutdown(): Promise<void> {
    this.stopping = true
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = undefined
    const teardowns = [...this.states.keys()].map((projectId) => this.teardown(projectId))
    const results = await Promise.allSettled(teardowns)
    for (const result of results) {
      if (result.status === 'rejected') console.error('[log-manager] 关闭日志路由失败：', result.reason)
    }
    await Promise.allSettled([...this.writerCloses])
    await Promise.allSettled([...this.cleanupTasks])
  }

  // ==================== 读取（IPC logs:readHistory 与 MCP read_logs 同源） ====================

  async readHistory(params: ReadHistoryParams): Promise<ReadHistoryResult> {
    const project = this.findProject(params.projectId)
    if (!project) throw new Error(`项目不存在：${params.projectId}`)
    const lines = Math.max(1, params.lines ?? 200)
    const source: LogSource =
      params.source === 'auto' || params.source === undefined
        ? project.logFilePath
          ? 'file'
          : 'stdout'
        : params.source
    if (source === 'file') {
      if (!project.logFilePath) throw new Error('项目未配置日志文件路径')
      return {
        source,
        lines: await tailFileLines(project.logFilePath, lines, encodingOverrideOf(project))
      }
    }
    return { source, lines: (await this.logStore.readTail(project.id, lines)).lines }
  }

  // ==================== 检索（IPC logs:search 与 MCP search_logs 同源） ====================

  async search(params: SearchParams): Promise<SearchResult> {
    const project = this.findProject(params.projectId)
    if (!project) throw new Error(`项目不存在：${params.projectId}`)
    // auto 路由：file 项目扫配置文件+同基名最近 2 个轮转；stdout 项目扫当前+轮转 run 文件
    const files = project.logFilePath
      ? rotationCandidates(project.logFilePath)
      : await this.logStore.latestRunFiles(project.id)
    return searchLogFiles(files, params)
  }

  // ==================== 内部 ====================

  private findProject(projectId: string): Project | undefined {
    return this.store.listProjects().find((p) => p.id === projectId)
  }

  private startTailer(projectId: string, project: Project, state: ProjectLogState): void {
    const logFilePath = project.logFilePath
    if (!logFilePath) return
    const settings = this.store.getSettings()
    state.tailDecoder = new RunDecoder({ encodingOverride: encodingOverrideOf(project) })
    state.tailer = new FileTailer({
      filePath: logFilePath,
      initialLines: settings.tailInitialLines,
      pollIntervalMs: this.tailPollIntervalMs,
      encodingOverride: encodingOverrideOf(project),
      onLines: (lines) => this.ingest(projectId, lines),
      // N-5：初始回读的历史行不触发 markRunning（历史是旧 run 内容，不证明本次启动存活）
      onInitialLines: (lines) => this.ingest(projectId, lines, { suppressSignal: true }),
      onError: (err) => console.error(`[file-tailer] ${logFilePath}：`, err)
    })
    void state.tailer.start()
  }

  /**
   * 行入口（stdout 转发路 / tailer 路）：首行信号 + 批量缓冲（200ms / 100 行）。
   * opts.suppressSignal=true 用于 FileTailer 初始历史行（N-5：markRunning 仅由
   * 跟随期新增行触发）；被抑制的首批历史行仍进批量缓冲推送/落盘，仅不发信号。
   */
  private ingest(projectId: string, lines: string[], opts?: { suppressSignal?: boolean }): void {
    if (lines.length === 0) return
    const state = this.states.get(projectId)
    if (!state) return
    if (!state.firstLineSignaled && opts?.suppressSignal !== true) {
      state.firstLineSignaled = true
      this.markRunning?.(projectId) // S-1：只发信号，状态转移在 process-manager
    }
    // P3-1（phase4 审查）：来源标签在行进入批量那一刻锁定（而非 flush 时读 state.route），
    // 保证切换路由后 flush 的行仍按其真实来源标注
    if (state.batch.length === 0) state.batchSource = state.route
    state.batch.push(...lines)
    if (state.batch.length >= BATCH_FLUSH_LINES) {
      this.flushBatch(projectId)
    } else if (state.batchTimer === undefined) {
      state.batchTimer = setTimeout(() => this.flushBatch(projectId), BATCH_FLUSH_MS)
    }
  }

  private flushBatch(projectId: string): void {
    const state = this.states.get(projectId)
    if (!state || state.batch.length === 0) return
    if (state.batchTimer !== undefined) {
      clearTimeout(state.batchTimer)
      state.batchTimer = undefined
    }
    const lines = state.batch
    state.batch = []
    // P3-1（phase4 审查）：优先取行进入批量时锁定的来源标签
    const source = state.batchSource ?? state.route
    state.batchSource = undefined
    const chunk: LogAppendedEvent = { projectId, source, lines }
    if (state.writer) {
      state.writer.append(lines).catch((err: unknown) => {
        this.reportError(`append:${projectId}`, `日志落盘失败（${projectId}）`, err)
      })
    }
    this.broadcaster?.(chunk)
  }

  private teardown(projectId: string): Promise<void> {
    const state = this.states.get(projectId)
    if (!state) return Promise.resolve()
    // dispose 可能 flush 未换行残行，因此必须先停生产者，再 flush batch。
    state.capture?.dispose()
    const tailerStopped = state.tailer?.stop() ?? Promise.resolve()
    this.flushBatch(projectId)
    if (state.batchTimer !== undefined) clearTimeout(state.batchTimer)
    this.states.delete(projectId) // 停止请求后的晚到 tailer 行不再进入新 run/路由
    const writer = state.writer
    state.writer = undefined
    const writerClosed = writer ? this.trackWriterClose(writer) : Promise.resolve()
    return (async () => {
      try {
        await tailerStopped
      } finally {
        await writerClosed
      }
    })()
  }

  private trackWriterClose(writer: RunLogWriter): Promise<void> {
    const task = writer.close()
    this.writerCloses.add(task)
    void task.then(
      () => this.writerCloses.delete(task),
      (err: unknown) => {
        this.writerCloses.delete(task)
        this.reportError('writer-close', '关闭日志 writer 失败', err)
      }
    )
    return task
  }

  private trackTeardown(task: Promise<void>): void {
    void task.catch((err: unknown) => this.reportError('teardown', '关闭日志路由失败', err))
  }

  /** 高频 stdout 下持续落盘失败只节流记录，实时广播不被磁盘故障阻断。 */
  private reportError(key: string, message: string, err: unknown): void {
    const now = Date.now()
    const previous = this.lastErrorAt.get(key) ?? -Infinity
    if (now - previous < ERROR_THROTTLE_MS) return
    this.lastErrorAt.set(key, now)
    console.error(`[log-manager] ${message}：`, err)
  }
}

function encodingOverrideOf(project: Project): 'utf8' | 'gbk' | undefined {
  return project.encodingOverride === 'utf8' || project.encodingOverride === 'gbk'
    ? project.encodingOverride
    : undefined
}

/** file 项目检索文件列表：`.2` `.1` 当前（旧→新；不存在的由 searchLogFiles 跳过） */
function rotationCandidates(logFilePath: string): string[] {
  return [`${logFilePath}.2`, `${logFilePath}.1`, logFilePath]
}
