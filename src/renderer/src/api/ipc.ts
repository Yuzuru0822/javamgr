import { IPC_EVENTS, IPC_REQUESTS } from '@shared/ipc-channels'
import { decodeIpcErrorPayload } from '@shared/ipc-error'
import type { IpcErrorCode } from '@shared/ipc-error'
import type {
  BatchResult,
  EventLoopMetrics,
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
  StatusChangedEvent
} from '@shared/types'
import type { IpcRequestChannel } from '@shared/ipc-channels'

/**
 * window.api 类型化封装（§2.2 api/ipc.ts）：全部请求/事件经此文件，
 * 组件与 store 不直接触碰 window.api；通道名与载荷类型均来自 src/shared 单一来源。
 *
 * 错误协议：主进程 ipc-registry 把结构化错误 JSON 塞进 Error.message；invoke 在此
 * 统一还原为带 .code 的 Error（VALIDATION_ERROR / NOT_FOUND / CONFLICT /
 * NOT_IMPLEMENTED / INTERNAL），store/组件可按 code 分支提示。
 */

async function invoke<T>(channel: IpcRequestChannel, ...args: unknown[]): Promise<T> {
  try {
    return await window.api.invoke<T>(channel, ...args)
  } catch (err) {
    throw normalizeIpcError(err)
  }
}

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
    /** N-6：主进程事件循环延迟指标（设置页运行状况区块） */
    getEventLoopMetrics: (): Promise<EventLoopMetrics> =>
      invoke<EventLoopMetrics>(IPC_REQUESTS.APP_GET_EVENT_LOOP_METRICS),
    /** 主进程文件选择对话框（S3：ProjectForm jar 路径选择）；取消返回 null */
    pickFile: (params?: {
      title?: string
      filters?: Array<{ name: string; extensions: string[] }>
    }): Promise<string | null> => invoke<string | null>(IPC_REQUESTS.APP_PICK_FILE, params ?? {})
  }
} as const

/** 事件订阅：均返回取消订阅函数（组件 onUnmounted 时调用） */
export const ipcEvents = {
  statusChanged: (listener: (payload: StatusChangedEvent) => void): (() => void) =>
    window.api.on<StatusChangedEvent>(IPC_EVENTS.PROC_STATUS_CHANGED, listener),
  logAppended: (listener: (payload: LogAppendedEvent) => void): (() => void) =>
    window.api.on<LogAppendedEvent>(IPC_EVENTS.LOG_APPENDED, listener),
  scanProgress: (listener: (payload: ScanProgressEvent) => void): (() => void) =>
    window.api.on<ScanProgressEvent>(IPC_EVENTS.JDK_SCAN_PROGRESS, listener),
  portChanged: (listener: (payload: PortChangedEvent) => void): (() => void) =>
    window.api.on<PortChangedEvent>(IPC_EVENTS.MCP_PORT_CHANGED, listener)
} as const
