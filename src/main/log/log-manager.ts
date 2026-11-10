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
import type {
  LogAppendedEvent,
  LogSource,
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
  /** <userData>/logs（AppPaths.logsDir） */
  logsDir: string
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

export class LogManager {
  private readonly store: ConfigStore
  private readonly broadcaster?: LogBroadcaster
  private readonly markRunning?: (projectId: string) => void
  private readonly tailPollIntervalMs: number
  private readonly logStore: LogStore
  private readonly states = new Map<string, ProjectLogState>()

  constructor(opts: LogManagerOptions) {
    this.store = opts.store
    this.broadcaster = opts.broadcaster
    this.markRunning = opts.markRunning
    this.tailPollIntervalMs = opts.tailPollIntervalMs ?? 2_000
    this.logStore = new LogStore({
      logsDir: opts.logsDir,
      getLimits: () => {
        const s = this.store.getSettings()
        return {
          maxFileBytes: Math.max(1, s.logMaxFileMb) * 1024 * 1024,
          maxRotations: s.logMaxRotations,
          runsToKeep: s.logRunsToKeep
        }
      }
    })
  }

  // ==================== run 生命周期（S-1 正向通道） ====================

  /** run:started：交付管道 → 挂捕获 + 按配置路由（file=tailer / stdout=捕获落盘） */
  handleRunStarted(event: RunStartHandoff): void {
    const project = this.findProject(event.projectId)
    if (!project) return // 项目已删：只排空管道防子进程写阻塞
    this.teardown(event.projectId)

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
      state.writer = this.logStore.openRun(event.projectId, event.runId)
    } else {
      this.startTailer(event.projectId, project, state)
    }
  }

  /** proc:statusChanged 接入点（装配层转接）：终态 → flush 残行 + 关闭路由组件 */
  handleStatusChanged(payload: StatusChangedEvent): void {
    if (payload.status === 'STOPPED' || payload.status === 'ABNORMAL_EXIT') {
      this.teardown(payload.projectId)
    }
  }

  /**
   * logFilePath 变更即时切换（S3 预留 update 钩子，ipc-registry diff 后调用）：
   * 两路互斥 + 重置游标；无活动 run 时仅记录（下次 run 生效）。
   */
  switchRoute(projectId: string): void {
    const project = this.findProject(projectId)
    if (!project) {
      this.teardown(projectId)
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
      // stdout → file：停转发与落盘，起 tailer
      state.forwarding = false
      state.writer?.close()
      state.writer = undefined
      this.flushBatch(projectId)
      this.startTailer(projectId, project, state)
    } else {
      // file → stdout：停 tailer，接管转发（本 run 切换点之前的 stdout 已被排空丢弃，
      // 落盘自切换点起——即时切换的固有边界，UI 引导长跑服务配置日志文件）
      void state.tailer?.stop()
      state.tailer = undefined
      state.tailDecoder = undefined
      this.flushBatch(projectId)
      state.forwarding = true
      state.writer = this.logStore.openRun(projectId, state.runId ?? `switch-${Date.now()}`)
    }
    state.route = newRoute
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

  /**
   * 进程退出兜底/应用关闭：flush 全部项目（残行广播 + 落盘）并关闭组件。
   * P2-4（phase4 审查）：teardown 里 flushBatch 的 writer.append 是 fire-and-forget
   * 异步链（内部 appendFile），不等落盘就返回会让 Electron quit 抢先——退出前最后
   * ≤100 行/200ms 窗口的日志可能丢盘。先留各 writer 引用（teardown 会 close 并移除
   * state），teardown 完成后 await 全部 writer.drain() 真实落盘再返回。
   */
  async shutdown(): Promise<void> {
    const writers: RunLogWriter[] = []
    for (const state of this.states.values()) {
      if (state.writer) writers.push(state.writer)
    }
    for (const projectId of [...this.states.keys()]) this.teardown(projectId)
    await Promise.all(writers.map((w) => w.drain()))
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
        console.error(`[log-manager] 日志落盘失败（${projectId}）：`, err)
      })
    }
    this.broadcaster?.(chunk)
  }

  private teardown(projectId: string): void {
    const state = this.states.get(projectId)
    if (!state) return
    this.flushBatch(projectId) // 残行批量先广播/落盘
    state.capture?.dispose()
    void state.tailer?.stop()
    state.writer?.close()
    if (state.batchTimer !== undefined) clearTimeout(state.batchTimer)
    this.states.delete(projectId)
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
