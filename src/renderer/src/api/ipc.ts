import { IPC_EVENTS, IPC_REQUESTS } from '@shared/ipc-channels'
import { decodeIpcErrorPayload } from '@shared/ipc-error'
import type { IpcErrorCode } from '@shared/ipc-error'
import type {
  BatchResult,
  EventLoopMetrics,
  JarScanResult,
  Jdk,
  JdkValidation,
  LogAppendedEvent,
  McpInfo,
  OpResult,
  PortChangedEvent,
  Project,
  ProjectInput,
  ProjectWithRuntime,
  ReadHistoryParams,
  ReadHistoryResult,
  ScanProgressEvent,
  SearchParams,
  SearchResult,
  Settings,
  StatusChangedEvent,
  UpdaterStatus,
  WebInfo
} from '@shared/types'
import type { IpcEventChannel, IpcRequestChannel } from '@shared/ipc-channels'

/**
 * window.api 类型化封装（§2.2 api/ipc.ts）：全部请求/事件经此文件，
 * 组件与 store 不直接触碰 window.api；通道名与载荷类型均来自 src/shared 单一来源。
 *
 * 双传输（v0.5.0）：Electron 窗口走 preload 注入的 window.api（ipcRenderer 桥）；
 * 浏览器面板（WebHost 服务本构建产物）无 preload → 自动回退 HTTP+SSE——
 * POST /web/api/<channel> 透传主进程同一组 IPC handler（零第二实现），
 * GET /web/events 单 SSE 流按 channel 分发（与窗口推送同源同载荷）。
 *
 * 错误协议：主进程 ipc-registry 把结构化错误 JSON 塞进 Error.message；两种传输
 * 在此统一还原为带 .code 的 Error（VALIDATION_ERROR / NOT_FOUND / CONFLICT /
 * NOT_IMPLEMENTED / INTERNAL），store/组件可按 code 分支提示。
 */

// ---------- 传输层（Electron / 浏览器自动选择） ----------

/** 调用时动态判定（preload 在 window 加载早期注入；测试 beforeEach 后注入同样生效） */
function bridge(): NonNullable<typeof window.api> | undefined {
  return typeof window !== 'undefined' ? window.api : undefined
}

async function invoke<T>(channel: IpcRequestChannel, ...args: unknown[]): Promise<T> {
  const b = bridge()
  if (b) {
    try {
      return await b.invoke<T>(channel, ...args)
    } catch (err) {
      throw normalizeIpcError(err)
    }
  }
  return httpInvoke<T>(channel, args[0])
}

/** 浏览器传输：POST /web/api/<channel>（同源 fetch；结构化错误协议与 Electron 路径同形） */
async function httpInvoke<T>(channel: IpcRequestChannel, body: unknown): Promise<T> {
  const res = await fetch(`/web/api/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })
  const payload = (await res.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; code: string; message: string }
    | null
  if (payload === null) {
    throw new Error(`通道 ${channel} 响应非 JSON（HTTP ${res.status}）`)
  }
  if (!payload.ok) {
    const normalized = new Error(payload.message)
    Object.assign(normalized, { code: payload.code })
    throw normalized
  }
  return payload.data
}

/** 浏览器传输：单 SSE 流按 channel 分发（懒建立；Electron 路径直连 ipcRenderer） */
function webSubscribe<T>(channel: IpcEventChannel, listener: (payload: T) => void): () => void {
  const listeners = webEventListeners
  const set = listeners.get(channel) ?? new Set()
  set.add(listener as (payload: unknown) => void)
  listeners.set(channel, set)
  if (!webEventSource) {
    webEventSource = new EventSource('/web/events')
    webEventSource.onmessage = (event: MessageEvent<string>) => {
      try {
        const { channel: ch, payload } = JSON.parse(event.data) as {
          channel: string
          payload: unknown
        }
        for (const l of listeners.get(ch as IpcEventChannel) ?? []) l(payload)
      } catch {
        // 非 JSON 帧忽略（心跳注释不会进入 onmessage）
      }
    }
  }
  return () => {
    set.delete(listener as (payload: unknown) => void)
  }
}

const webEventListeners = new Map<IpcEventChannel, Set<(payload: unknown) => void>>()
let webEventSource: EventSource | null = null

/** 从 Electron 包装过的 rejection message 还原结构化错误；非协议错误原样抛出 */
function normalizeIpcError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err)
  const structured = decodeIpcErrorPayload(message)
  if (!structured) return err
  const normalized = new Error(structured.message)
  Object.assign(normalized, { code: structured.code, details: structured.details })
  return normalized
}

export type { IpcErrorCode }

export const ipc = {
  projects: {
    list: (): Promise<ProjectWithRuntime[]> => invoke<ProjectWithRuntime[]>(IPC_REQUESTS.PROJECTS_LIST),
    create: (input: ProjectInput): Promise<Project> =>
      invoke<Project>(IPC_REQUESTS.PROJECTS_CREATE, input),
    /** 扫描导入：递归收集目录下 *.jar（alreadyManaged 按当前纳管标注） */
    scanJars: (rootDir: string): Promise<JarScanResult> =>
      invoke<JarScanResult>(IPC_REQUESTS.PROJECTS_SCAN_JARS, { rootDir }),
    update: (input: ProjectInput & { id: string }): Promise<Project> =>
      invoke<Project>(IPC_REQUESTS.PROJECTS_UPDATE, input),
    remove: (id: string, confirm: boolean): Promise<void> =>
      invoke<void>(IPC_REQUESTS.PROJECTS_DELETE, { id, confirm }),
    start: (id: string): Promise<OpResult> => invoke<OpResult>(IPC_REQUESTS.PROJECTS_START, { id }),
    stop: (id: string): Promise<OpResult> => invoke<OpResult>(IPC_REQUESTS.PROJECTS_STOP, { id }),
    restart: (id: string): Promise<OpResult> =>
      invoke<OpResult>(IPC_REQUESTS.PROJECTS_RESTART, { id }),
    startAll: (): Promise<BatchResult> => invoke<BatchResult>(IPC_REQUESTS.PROJECTS_START_ALL),
    stopAll: (): Promise<BatchResult> => invoke<BatchResult>(IPC_REQUESTS.PROJECTS_STOP_ALL)
  },
  jdk: {
    scan: (): Promise<Jdk[]> => invoke<Jdk[]>(IPC_REQUESTS.JDK_SCAN),
    list: (): Promise<Jdk[]> => invoke<Jdk[]>(IPC_REQUESTS.JDK_LIST),
    /** 即时校验（不入库）：对话框输入路径后反馈版本/发行方或失败原因；add/update 落库时服务端复检 */
    validate: (homePath: string): Promise<JdkValidation> =>
      invoke<JdkValidation>(IPC_REQUESTS.JDK_VALIDATE, { homePath }),
    /** 手动添加：版本/发行方由主进程校验路径后派生；name 可选覆盖展示名 */
    add: (homePath: string, name?: string): Promise<Jdk[]> =>
      invoke<Jdk[]>(IPC_REQUESTS.JDK_ADD, { homePath, ...(name !== undefined ? { name } : {}) }),
    /** 编辑：路径变更时主进程重新校验派生；保留原 id */
    update: (id: string, homePath: string, name?: string): Promise<Jdk[]> =>
      invoke<Jdk[]>(IPC_REQUESTS.JDK_UPDATE, {
        id,
        homePath,
        ...(name !== undefined ? { name } : {})
      }),
    remove: (id: string): Promise<Jdk[]> => invoke<Jdk[]>(IPC_REQUESTS.JDK_REMOVE, { id })
  },
  logs: {
    readHistory: (params: ReadHistoryParams): Promise<ReadHistoryResult> =>
      invoke<ReadHistoryResult>(IPC_REQUESTS.LOGS_READ_HISTORY, params),
    search: (params: SearchParams): Promise<SearchResult> =>
      invoke<SearchResult>(IPC_REQUESTS.LOGS_SEARCH, params)
  },
  settings: {
    get: (): Promise<Settings> => invoke<Settings>(IPC_REQUESTS.SETTINGS_GET),
    /** 局部合并：只传要改的键，主进程合并默认值与现值后返回完整 Settings */
    set: (patch: Partial<Settings>): Promise<Settings> =>
      invoke<Settings>(IPC_REQUESTS.SETTINGS_SET, patch)
  },
  app: {
    getMcpInfo: (): Promise<McpInfo> => invoke<McpInfo>(IPC_REQUESTS.APP_GET_MCP_INFO),
    /** 应用版本号（项目面板页头展示；开发期取 package.json，打包后取安装包版本） */
    getVersion: (): Promise<string> => invoke<string>(IPC_REQUESTS.APP_GET_VERSION),
    /** N-6：主进程事件循环延迟指标（设置页运行状况区块） */
    getEventLoopMetrics: (): Promise<EventLoopMetrics> =>
      invoke<EventLoopMetrics>(IPC_REQUESTS.APP_GET_EVENT_LOOP_METRICS),
    /** 主进程文件/目录选择对话框；取消返回 null（directory=true 选目录，扫描导入用） */
    pickFile: (params?: {
      title?: string
      directory?: boolean
      filters?: Array<{ name: string; extensions: string[] }>
    }): Promise<string | null> => invoke<string | null>(IPC_REQUESTS.APP_PICK_FILE, params ?? {}),
    /** v0.4.0 自动更新：触发检查（后续状态经 updaterStatus 事件推送） */
    checkUpdate: (): Promise<UpdaterStatus> => invoke<UpdaterStatus>(IPC_REQUESTS.UPDATER_CHECK),
    /** 下载完成后立即重启静默安装（主进程随即退出） */
    installUpdateNow: (): Promise<void> => invoke<void>(IPC_REQUESTS.UPDATER_INSTALL_NOW),
    /** 当前更新状态快照（重开设置页恢复下载进度等） */
    getUpdaterState: (): Promise<UpdaterStatus> =>
      invoke<UpdaterStatus>(IPC_REQUESTS.UPDATER_GET_STATE),
    /** v0.5.0 浏览器面板访问信息 */
    getWebInfo: (): Promise<WebInfo> => invoke<WebInfo>(IPC_REQUESTS.WEB_GET_INFO)
  }
} as const

/** 事件订阅：均返回取消订阅函数（组件 onUnmounted 时调用） */
export const ipcEvents = {
  statusChanged: (listener: (payload: StatusChangedEvent) => void): (() => void) => {
    const b = bridge()
    return b
      ? b.on<StatusChangedEvent>(IPC_EVENTS.PROC_STATUS_CHANGED, listener)
      : webSubscribe(IPC_EVENTS.PROC_STATUS_CHANGED, listener)
  },
  logAppended: (listener: (payload: LogAppendedEvent) => void): (() => void) => {
    const b = bridge()
    return b
      ? b.on<LogAppendedEvent>(IPC_EVENTS.LOG_APPENDED, listener)
      : webSubscribe(IPC_EVENTS.LOG_APPENDED, listener)
  },
  scanProgress: (listener: (payload: ScanProgressEvent) => void): (() => void) => {
    const b = bridge()
    return b
      ? b.on<ScanProgressEvent>(IPC_EVENTS.JDK_SCAN_PROGRESS, listener)
      : webSubscribe(IPC_EVENTS.JDK_SCAN_PROGRESS, listener)
  },
  portChanged: (listener: (payload: PortChangedEvent) => void): (() => void) => {
    const b = bridge()
    return b
      ? b.on<PortChangedEvent>(IPC_EVENTS.MCP_PORT_CHANGED, listener)
      : webSubscribe(IPC_EVENTS.MCP_PORT_CHANGED, listener)
  },
  updaterStatus: (listener: (payload: UpdaterStatus) => void): (() => void) => {
    const b = bridge()
    return b
      ? b.on<UpdaterStatus>(IPC_EVENTS.UPDATER_STATUS, listener)
      : webSubscribe(IPC_EVENTS.UPDATER_STATUS, listener)
  }
} as const
