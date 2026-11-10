/**
 * 进程管理核心（计划 §2.3-A / §3 S3.3，风险 R5/R8/R11 缓解，F4/N-4 决议）。
 *
 * 单一权威状态源：状态机 + projectId 级操作队列（promise 链）都在本模块。
 * GUI（IPC）与 MCP（S5）是它的两个等价客户端，走同一 public 方法，行为零分叉。
 *
 * 关键设计（与计划条款一一对应）：
 * - 操作串行化：start/stop/restart/startAll/stopAll 全部经 projectId 队列；
 *   restart/startAll/stopAll 等**组合操作持队列槽位期间直调内部 doStart/doStop，
 *   绝不重新入队（同队列自等 = 死锁，N-4）**；
 * - 幂等四规则（GUI/MCP 同源）：RUNNING+start→{ok,pid,RUNNING}；STARTING+start→
 *   {ok,pid,STARTING}（绝不二次 spawn）；STOPPED/ABNORMAL_EXIT+stop→幂等 ok；
 *   STARTING/RUNNING+stop→入队等前序完成后真实 taskkill；
 * - 状态机：STOPPED→STARTING→RUNNING→(STOPPED[code 0] | ABNORMAL_EXIT[code≠0])；
 *   STARTING→RUNNING：markRunning 首条日志信号（S4 接）或存活满 startupGraceSeconds 兜底，
 *   先到先转；有句柄进程 close 事件读 exitCode 落终态；
 * - process↔log 握手（S-1，防循环依赖）：process→log 唯一通道 = setLogHooks 注册的
 *   onRunStarted 事件（stdout/stderr 句柄交付）；log→process 唯一通道 = markRunning 信号；
 *   log 模块不得 import 本模块（接线在装配层完成）；
 * - 重识别：经 pid-registry（runs.json + 批量轮询池），死亡回调落终态
 *   "已停止（外部退出，退出码未知）"并广播。
 *
 * 本模块零 electron 依赖（广播经注入 broadcaster；spawner/taskOps/sleep 可注入，纯 Node 可测）。
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type {
  BatchResult,
  LogSource,
  OpResult,
  ProjectRuntimeState,
  RunStatus,
  StatusChangedEvent
} from '../../shared/types'
import type { ConfigStore } from '../config/config-store'
import { PidRegistry } from './pid-registry'
import type { TaskOps } from './task-killer'
import { createTaskOps } from './task-killer'

// ---------- 注入点类型 ----------

/** 广播回调：装配层接到 webContents.send(proc:statusChanged) / MCP 通知 */
export type StatusBroadcaster = (payload: StatusChangedEvent) => void

/** run:started 载荷（process → log 唯一通道；stdout/stderr 管道句柄交付） */
export interface RunStartedEvent {
  projectId: string
  pid: number
  /** 本次 run 标识（日志落盘 <projectId>/<runId>.log，S4 使用） */
  runId: string
  logSource: LogSource
  /** 分离进程的 stdout 管道（已 unref 但保留引用；log 模块负责消费，防背压阻塞） */
  stdout?: Readable
  stderr?: Readable
}

/** log 模块注入的钩子（S-1：log 不 import process-manager，经此接口完成双向接线） */
export interface LogHooks {
  /** process → log：run 启动时交付 pid 与 stdout/stderr 管道（log 挂捕获/tail） */
  onRunStarted?: (event: RunStartedEvent) => void
  /**
   * markRunning 信号观察点：公共 markRunning() 完成状态转移后回调（可选；
   * log→process 的首行信号本身走 processManager.markRunning() 公共方法，S4 接线）。
   */
  markRunning?: (projectId: string) => void
}

/** 可注入的 spawn（单测 fake spawner；生产为 child_process.spawn） */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    detached: boolean
    stdio: ['ignore', 'pipe', 'pipe']
    windowsHide: boolean
    /** 工作目录 = jar 所在目录（复刻「CD 后 java -jar」语义） */
    cwd: string
    env: NodeJS.ProcessEnv
  }
) => ChildProcess

/** 有句柄进程的最小面（单测用 EventEmitter + PassThrough 伪造） */
export interface HandledChild {
  pid?: number | undefined
  stdout: Readable | null
  stderr: Readable | null
  unref(): void
  on(event: 'close', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

export interface ProcessManagerOptions {
  store: ConfigStore
  /** runs.json 路径（AppPaths.runsFile） */
  runsFile: string
  taskOps?: TaskOps
  spawner?: SpawnFn
  broadcaster?: StatusBroadcaster
  /** startAll/stopAll 项间错峰间隔（默认 500ms；单测置 0） */
  batchStaggerMs?: number
  /** 停止单项超时（默认 8000ms） */
  stopTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

// ---------- 内部运行时条目 ----------

interface RuntimeEntry {
  status: RunStatus
  pid?: number
  startTime?: number
  exitCode?: number
  note?: string
  runId?: string
  logSource: LogSource
  /** 有句柄的新启动进程（事件驱动；重识别进程无句柄，经 pid-registry 轮询池） */
  child?: HandledChild
  /** STARTING→RUNNING 兜底定时器 */
  graceTimer?: NodeJS.Timeout
  /** 本次 run 是否由 stop() 发起终止（close 事件据此区分 STOPPED 与 ABNORMAL_EXIT） */
  stopping?: boolean
}

// ---------- ProcessManager ----------

export class ProcessManager {
  private readonly store: ConfigStore
  private readonly runtime = new Map<string, RuntimeEntry>()
  /** projectId 级操作队列尾（promise 链；同项目操作严格串行，不同项目并行） */
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly taskOps: TaskOps
  private readonly spawner: SpawnFn
  private readonly broadcaster?: StatusBroadcaster
  private readonly batchStaggerMs: number
  private readonly stopTimeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private logHooks: LogHooks = {}
  readonly registry: PidRegistry

  constructor(opts: ProcessManagerOptions) {
    this.store = opts.store
    this.taskOps = opts.taskOps ?? createTaskOps()
    this.spawner = opts.spawner ?? ((cmd, args, options) => spawn(cmd, [...args], options))
    this.broadcaster = opts.broadcaster
    this.batchStaggerMs = opts.batchStaggerMs ?? 500
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 8_000
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.registry = new PidRegistry({
      runsFile: opts.runsFile,
      taskOps: this.taskOps,
      onDeath: (projectId) => this.onPolledDeath(projectId),
      getIntervalSeconds: () => {
        const configured = this.store.getSettings().pollIntervalSeconds
        return Math.min(10, Math.max(5, configured))
      }
    })
  }

  // ==================== 装配 / 生命周期 ====================

  /**
   * 启动初始化：runs.json 重识别（存活→RUNNING"重识别"并入轮询池；
   * 已死→STOPPED"工具离线期间退出，退出码未知"）+ 启动轮询。
   */
  async initialize(): Promise<void> {
    const knownProjects = new Set(this.store.listProjects().map((p) => p.id))
    const results = await this.registry.reidentify()
    for (const r of results) {
      if (!knownProjects.has(r.record.projectId)) {
        // 项目已被删除：出清遗留记录，不产生幽灵状态
        await this.registry.remove(r.record.projectId)
        continue
      }
      if (r.alive) {
        this.runtime.set(r.record.projectId, {
          status: 'RUNNING',
          pid: r.record.pid,
          startTime: r.record.startTime,
          runId: r.record.runId,
          logSource: r.record.logSource,
          note: '重识别'
        })
      } else {
        this.runtime.set(r.record.projectId, {
          status: 'STOPPED',
          startTime: r.record.startTime,
          runId: r.record.runId,
          logSource: r.record.logSource,
          note: '工具离线期间退出，退出码未知'
        })
      }
      this.broadcast(r.record.projectId)
    }
    this.registry.startPolling()
  }

  /** 退出前收尾：停轮询 + runs.json 落盘（keep 策略下为存活进程续写记录） */
  async prepareForExit(): Promise<void> {
    this.registry.stopPolling()
    await this.registry.save()
  }


  /** S-1 握手接线：log 模块注册 onRunStarted（句柄交付）；markRunning 为 log→process 信号入口 */
  setLogHooks(hooks: LogHooks): void {
    this.logHooks = hooks
  }

  // ==================== 查询（IPC 与 MCP S5 同源） ====================

  getRuntimeState(projectId: string): ProjectRuntimeState | undefined {
    const entry = this.runtime.get(projectId)
    if (!entry) return undefined
    return this.toRuntimeState(entry)
  }

  listRuntimeStates(): Array<{ projectId: string } & ProjectRuntimeState> {
    return [...this.runtime.entries()].map(([projectId, entry]) => ({
      projectId,
      ...this.toRuntimeState(entry)
    }))
  }

  private toRuntimeState(entry: RuntimeEntry): ProjectRuntimeState {
    return {
      status: entry.status,
      ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
      ...(entry.startTime !== undefined ? { startTime: entry.startTime } : {}),
      ...(entry.status === 'RUNNING' && entry.startTime !== undefined
        ? { uptimeMs: Date.now() - entry.startTime }
        : {}),
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
      ...(entry.note !== undefined && entry.note !== null ? { note: entry.note } : {})
    }
  }

  // ==================== 公共操作（全部入 projectId 队列） ====================

  /** 启动（幂等四规则见文件头）；结果语义与 IPC projects:start / MCP start_project 一致 */
  startProject(projectId: string): Promise<OpResult> {
    return this.enqueue(projectId, () => this.doStart(projectId))
  }

  /**
   * 停止（PowerShell Stop-Process 杀树：CIM 枚举后代 + 批量终止，WMI 病态宿主自动降级
   * 为主进程单杀——结果 note 携带 degraded 说明；STOPPED/ABNORMAL_EXIT 幂等 ok）。
   * timeoutMs：本次停止的树终止预算（§2.6 stop_project 契约，默认 8000 = 构造期 stopTimeoutMs）。
   */
  stopProject(projectId: string, timeoutMs?: number): Promise<OpResult> {
    return this.enqueue(projectId, () => this.doStop(projectId, timeoutMs))
  }

  /**
   * 重启 = 原子组合（stop 等待进程树死亡 → start），整段占用队列直至完成；
   * 持队列槽位期间直调内部实现，绝不重新入队（N-4 自等死锁禁令）。
   * stopTimeoutMs：组合内 stop 的树终止预算（§2.6 restart_project 契约，默认 8000）。
   */
  restartProject(projectId: string, stopTimeoutMs?: number): Promise<OpResult> {
    return this.enqueue(projectId, async () => {
      const stopResult = await this.doStop(projectId, stopTimeoutMs)
      if (!stopResult.ok) return stopResult
      const startResult = await this.doStart(projectId)
      // stop 段降级说明（WMI 病态宿主仅终止主进程）透传到 restart 结果
      return stopResult.note !== undefined ? { ...startResult, note: stopResult.note } : startResult
    })
  }

  /** 全部启动：每项目只入队一次、项间错峰、单项失败不中断（§2.3-A 批量） */
  async startAllProjects(): Promise<BatchResult> {
    return this.runBatch((id) => this.enqueue(id, () => this.doStart(id)))
  }

  /** 全部停止（语义同上） */
  async stopAllProjects(): Promise<BatchResult> {
    return this.runBatch((id) => this.enqueue(id, () => this.doStop(id)))
  }

  /**
   * 退出策略 stopAll：并行逐项目杀树（单项 stopTimeoutMs 超时，Promise.allSettled 互不阻塞）。
   * 返回尝试终止的 projectId 列表（失败项目状态带"退出时终止失败"note，由调用方汇总）。
   */
  async killAllForExit(): Promise<string[]> {
    const targets = [...this.runtime.entries()].filter(
      ([, e]) => (e.status === 'RUNNING' || e.status === 'STARTING') && e.pid !== undefined
    )
    await Promise.allSettled(
      targets.map(async ([projectId, entry]) => {
        const result = await this.taskOps.killTree(entry.pid as number, this.stopTimeoutMs)
        this.clearGraceTimer(projectId)
        this.runtime.set(projectId, {
          status: 'STOPPED',
          logSource: entry.logSource,
          ...(result.ok
            ? result.degraded === true
              ? { note: result.degradedReason ?? 'WMI 子进程枚举不可用，仅终止主进程' }
              : {}
            : { note: `退出时终止失败：${result.error ?? '未知错误'}` })
        })
        await this.registry.remove(projectId)
        this.broadcast(projectId)
      })
    )
    return targets.map(([projectId]) => projectId)
  }

  // ==================== 队列基建 ====================

  private enqueue<T>(projectId: string, op: () => Promise<T>): Promise<T> {
    const tail = this.queues.get(projectId) ?? Promise.resolve()
    const next = tail.then(op, op) // 前序成败都继续（前序失败已由其调用方收悉）
    const swallowed = next.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(projectId, swallowed)
    void swallowed.then(() => {
      if (this.queues.get(projectId) === swallowed) this.queues.delete(projectId)
    })
    return next
  }

  private async runBatch(
    enqueueOne: (id: string) => Promise<OpResult>
  ): Promise<BatchResult> {
    const results: BatchResult['results'] = []
    const ids = this.store.listProjects().map((p) => p.id)
    await Promise.all(
      ids.map(async (id, index) => {
        // 项间错峰（§2.3-A 批量）：第 i 项延迟 i×stagger 再入队——并行 sleep 同时醒来
        // 不构成"项间"错峰（S6 修正：7 项目实测后 3 个 JVM 同时启动撞内存提交上限）
        if (index > 0) await this.sleep(this.batchStaggerMs * index)
        try {
          const r = await enqueueOne(id)
          results.push({ id, ok: r.ok, ...(r.error !== undefined ? { error: r.error } : {}) })
        } catch (err) {
          results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })
    )
    return { results }
  }

  // ==================== 内部实现（持队列槽位时直调，禁止重新入队） ====================

  private async doStart(projectId: string): Promise<OpResult> {
    const project = this.store.listProjects().find((p) => p.id === projectId)
    if (!project) return { ok: false, error: `项目不存在：${projectId}` }

    // 幂等四规则（出队后按当时状态套用，绝不二次 spawn）
    const current = this.runtime.get(projectId)
    if (current?.status === 'RUNNING') {
      return { ok: true, pid: current.pid, status: 'RUNNING' }
    }
    if (current?.status === 'STARTING') {
      return { ok: true, pid: current.pid, status: 'STARTING' }
    }

    // 前置校验（S6.2 异常路径：错误信息用户可读——含路径与建议）：
    // JDK 条目存在 + java.exe 在盘 + jar 存在；任一缺失返回结构化错误，状态不变
    const jdk = this.store.listJdks().find((j) => j.id === project.jdkId)
    if (!jdk) {
      return {
        ok: false,
        error: `项目「${project.name}」绑定的 JDK 已不存在（jdkId=${project.jdkId}）。` +
          `可能是 JDK 被移除或配置丢失——请编辑项目重新选择 JDK，或到 JDK 页重新添加`
      }
    }
    const javaExe = `${jdk.homePath}\\bin\\java.exe`
    try {
      await access(javaExe)
    } catch {
      return {
        ok: false,
        error: `JDK 路径无效：找不到 ${javaExe}（JDK「${jdk.name}」的安装目录可能已被移动或删除）。` +
          `请到 JDK 页修正该 JDK 路径，或为项目「${project.name}」改绑其他 JDK`
      }
    }
    try {
      await access(project.jarPath)
    } catch {
      return {
        ok: false,
        error: `jar 文件不存在：${project.jarPath}。` +
          `文件可能已被移动或删除——请编辑项目「${project.name}」重新选择 jar 路径`
      }
    }

    const logSource: LogSource = project.logFilePath ? 'file' : 'stdout'
    const runId = this.makeRunId()

    // spawn：detached + unref（工具退出默认不杀子进程，R5），保留 stdout/stderr 管道引用；
    // cwd = jar 所在目录（2026-11-10 修复）：复刻「CD 到目录再 java -jar」语义——相对路径
    // 配置（Spring file:config/、logback 相对 <file> 等）按 user.dir 解析，落在 jar 平级
    let child: ChildProcess
    try {
      child = this.spawner(javaExe, this.buildArgs(project), {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: path.dirname(project.jarPath),
        env: { ...process.env, JAVA_HOME: jdk.homePath, ...project.envVars }
      })
    } catch (err) {
      return {
        ok: false,
        error: `启动失败（spawn 异常）：${err instanceof Error ? err.message : String(err)}`
      }
    }
    if (child.pid === undefined) {
      return {
        ok: false,
        error: `启动失败：无法执行 ${javaExe}（spawn 未返回 pid）。请确认该文件是有效的 java.exe，或到 JDK 页改绑其他 JDK`
      }
    }

    const pid = child.pid
    const startTime = Date.now()
    const entry: RuntimeEntry = {
      status: 'STARTING',
      pid,
      startTime,
      runId,
      logSource,
      child
    }
    this.runtime.set(projectId, entry)

    child.unref()

    // P2-3（phase4 审查）：先挂 close/error 监听 + grace 兜底 + 交付 stdout 管道，
    // 再落 runs.json——若 upsert 在最前且落盘失败（EPERM/EBUSY 窗口），子进程已
    // detached 存活而监听未挂（进程死亡无人落终态 = 永久 STARTING）、管道无人消费
    // （Java 写满 OS 管道缓冲后阻塞挂起）。
    this.attachChildListeners(projectId, entry)
    this.armGraceFallback(projectId, entry)

    // process → log：run:started 事件（stdout/stderr 句柄交付；S-1 唯一正向通道）
    const event: RunStartedEvent = {
      projectId,
      pid,
      runId,
      logSource,
      ...(child.stdout !== null ? { stdout: child.stdout } : {}),
      ...(child.stderr !== null ? { stderr: child.stderr } : {})
    }
    if (this.logHooks.onRunStarted) {
      this.logHooks.onRunStarted(event)
    } else {
      // 无人消费时排空管道，防 Java 进程写满缓冲区阻塞（S4 接入后由 log 模块消费）
      child.stdout?.resume()
      child.stderr?.resume()
    }

    // runs.json 落盘（写入时机①：start 成功）。失败降级为日志而非中断：监听与管道
    // 均已就位，runs.json 缺一条只影响工具重启后的重识别，不致命（P2-3）。
    try {
      await this.registry.upsert({ projectId, pid, startTime, logSource, runId })
    } catch (err) {
      console.error(`[process-manager] runs.json 落盘失败（${projectId}，不影响本次启动）：`, err)
    }

    this.broadcast(projectId)
    return { ok: true, pid, status: 'STARTING' }
  }

  private buildArgs(project: {
    jarPath: string
    jvmArgs: string[]
    programArgs: string[]
  }): string[] {
    // JVM 参数必须位于 -jar 之前才能被 JVM 解析（计划 §2.3-A spawn 参数列示顺序为笔误，
    // 以 scripts/fixtures/README.md 的 -Dloggy.* 契约与 java 语义为准）
    return [...project.jvmArgs, '-jar', project.jarPath, ...project.programArgs]
  }

  private makeRunId(): string {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return `${stamp}-${randomUUID().slice(0, 8)}`
  }

  private attachChildListeners(projectId: string, entry: RuntimeEntry): void {
    const child = entry.child
    if (!child) return

    child.on('close', (code) => {
      // 本次 run 已被后续 run 替换（restart 竞态）：旧句柄事件丢弃
      if (this.runtime.get(projectId) !== entry) return
      this.clearGraceTimer(projectId)
      const wasStopping = entry.stopping === true
      if (wasStopping) {
        // stop() 发起的终止：一律 STOPPED（非 ABNORMAL，§2.3-A）
        this.runtime.set(projectId, {
          status: 'STOPPED',
          pid: entry.pid,
          startTime: entry.startTime,
          runId: entry.runId,
          logSource: entry.logSource
        })
      } else if (code === 0) {
        this.runtime.set(projectId, {
          status: 'STOPPED',
          pid: entry.pid,
          startTime: entry.startTime,
          runId: entry.runId,
          logSource: entry.logSource
        })
      } else {
        this.runtime.set(projectId, {
          status: 'ABNORMAL_EXIT',
          pid: entry.pid,
          startTime: entry.startTime,
          runId: entry.runId,
          logSource: entry.logSource,
          ...(code !== null ? { exitCode: code } : {}),
          note: code === null ? '进程被信号终止，退出码不可得' : undefined
        })
      }
      // runs.json 出清（写入时机③：进程退出）
      this.registry.remove(projectId).catch((err: unknown) => {
        console.error(`[process-manager] runs.json 出清失败（${projectId}）：`, err)
      })
      this.broadcast(projectId)
    })

    child.on('error', (err) => {
      if (this.runtime.get(projectId) !== entry) return
      this.clearGraceTimer(projectId)
      // 有 pid 后的异步 error（罕见）：按异常退出处理，退出码未知
      this.runtime.set(projectId, {
        status: 'ABNORMAL_EXIT',
        pid: entry.pid,
        startTime: entry.startTime,
        runId: entry.runId,
        logSource: entry.logSource,
        note: `进程错误：${err.message}`
      })
      this.registry.remove(projectId).catch((err: unknown) => {
        console.error(`[process-manager] runs.json 出清失败（${projectId}）：`, err)
      })
      this.broadcast(projectId)
    })
  }

  /** STARTING→RUNNING 兜底：无任何输出时存活满 startupGraceSeconds 转 RUNNING（§2.3-A 状态机） */
  private armGraceFallback(projectId: string, entry: RuntimeEntry): void {
    const graceSeconds = this.store.getSettings().startupGraceSeconds
    const timer = setTimeout(() => {
      // 就地转移（不替换对象）：close/error 监听持有 entry 引用做身份比对，替换会漏终态
      if (this.runtime.get(projectId) === entry && entry.status === 'STARTING') {
        entry.status = 'RUNNING'
        this.broadcast(projectId)
      }
    }, Math.max(0, graceSeconds) * 1_000)
    entry.graceTimer = timer
  }

  private clearGraceTimer(projectId: string): void {
    const entry = this.runtime.get(projectId)
    if (entry?.graceTimer !== undefined) {
      clearTimeout(entry.graceTimer)
      entry.graceTimer = undefined
    }
  }

  /** log → process 唯一信号通道：首条日志输出即转 RUNNING（先到先转，S4 接入） */
  markRunning(projectId: string): void {
    const entry = this.runtime.get(projectId)
    if (!entry || entry.status !== 'STARTING') return
    if (entry.graceTimer !== undefined) {
      clearTimeout(entry.graceTimer)
      entry.graceTimer = undefined
    }
    entry.status = 'RUNNING'
    this.broadcast(projectId)
    this.logHooks.markRunning?.(projectId)
  }

  private async doStop(projectId: string, timeoutMs?: number): Promise<OpResult> {
    const entry = this.runtime.get(projectId)

    // 幂等：已停/异常退出 → ok，不动 taskkill
    if (!entry || entry.status === 'STOPPED' || entry.status === 'ABNORMAL_EXIT') {
      return { ok: true, durationMs: 0 }
    }
    if (entry.pid === undefined) {
      // 理论不可达（STARTING/RUNNING 必有 pid）；防御性落 STOPPED
      this.clearGraceTimer(projectId)
      this.runtime.set(projectId, { ...entry, status: 'STOPPED' })
      await this.registry.remove(projectId)
      this.broadcast(projectId)
      return { ok: true, durationMs: 0 }
    }

    const startedAt = Date.now()
    entry.stopping = true // close 事件据此落 STOPPED（而非 ABNORMAL_EXIT）
    this.clearGraceTimer(projectId)

    const kill = await this.taskOps.killTree(entry.pid, timeoutMs ?? this.stopTimeoutMs)
    if (!kill.ok) {
      entry.stopping = false
      return { ok: false, durationMs: kill.durationMs, error: kill.error ?? '停止失败' }
    }

    // 进程树已确认死亡：落 STOPPED（非 ABNORMAL）+ runs.json 出清（写入时机②：stop 完成）。
    // 若 close 事件已先一步落终态（STOPPED），此处保持幂等不回退。
    // degraded 透传（WMI 病态宿主降级：仅终止了主进程，子进程可能残留）。
    const settled = this.runtime.get(projectId)
    if (settled === entry) {
      this.runtime.set(projectId, {
        status: 'STOPPED',
        pid: entry.pid,
        startTime: entry.startTime,
        runId: entry.runId,
        logSource: entry.logSource,
        ...(kill.degraded === true
          ? { note: kill.degradedReason ?? 'WMI 子进程枚举不可用，仅终止主进程' }
          : {})
      })
    }
    await this.registry.remove(projectId)
    this.broadcast(projectId)
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      ...(kill.degraded === true
        ? { note: kill.degradedReason ?? 'WMI 子进程枚举不可用，仅终止主进程' }
        : {})
    }
  }

  // ==================== 轮询池死亡回调（重识别进程，无句柄） ====================

  private onPolledDeath(projectId: string): void {
    const entry = this.runtime.get(projectId)
    // 仅轮询池管辖的（无句柄）RUNNING/STARTING 进程经此路径落终态；有句柄进程由 close 事件负责
    if (!entry || entry.child !== undefined) return
    if (entry.status !== 'RUNNING' && entry.status !== 'STARTING') return
    this.runtime.set(projectId, {
      status: 'STOPPED',
      pid: entry.pid,
      startTime: entry.startTime,
      runId: entry.runId,
      logSource: entry.logSource,
      note: '外部退出，退出码未知'
    })
    this.broadcast(projectId)
  }

  // ==================== 广播（proc:statusChanged，载荷与 getRuntimeState 同源） ====================

  private broadcast(projectId: string): void {
    if (!this.broadcaster) return
    const state = this.getRuntimeState(projectId)
    if (!state) return
    const payload: StatusChangedEvent = {
      projectId,
      status: state.status,
      ...(state.pid !== undefined ? { pid: state.pid } : {}),
      ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
      ...(state.startTime !== undefined ? { startTime: state.startTime } : {}),
      ...(state.note !== undefined ? { note: state.note } : {})
    }
    this.broadcaster(payload)
  }
}
