/**
 * Maven 构建执行器（v0.7.0 构建按钮，计划外的增量功能）。
 *
 * 职责：
 * - run(projectId)：按「项目构建配置 + Maven 条目 + 项目绑定的 JDK」组装命令并启动：
 *   `"…\bin\mvn.cmd" -B [-s settings.xml] [-Dmaven.repo.local=repo] <buildCommand…>`；
 *   - 工作目录：project.buildDir 显式指定（启动前校验存在，配置错误显式报错）；缺省自动
 *     推断——jar 在 target\ 下取其上一级（mvn 标准布局），否则 jar 所在目录（jar 与 pom 平级）；
 *   - env：JAVA_HOME = 项目绑定 JDK 的 homePath，PATH 前置其 bin（mvn.cmd 启动脚本找 java
 *     的两条路径都覆盖），再叠加项目 envVars——与进程启动（process-manager）同源语义；
 *   - Windows 上 Node 新版对 .cmd 直接 execFile 会 EINVAL，故经 `cmd.exe /d /s /c` 执行，
 *     windowsVerbatimArguments + 自拼引号（/S 保证多引号命令行原样传递，社区标准做法）；
 * - 输出：stdout/stderr 合并，字节缓冲按 \n 切行、剥 \r，**行级解码**（先严格 UTF-8，
 *   出现替换符再回退 GBK——中文 Windows 控制台代码页 936；行级无跨块多字节问题）；
 *   200ms 或 100 行批量经 build:output 事件推送（学 log:appended 防洪泛）；
 * - 取消：killTree（task-killer 的 PowerShell 杀树，与停止项目同一套），close 后标 cancelled；
 * - 状态：每项目内存保留最近一次构建快照（BuildState，滚动输出缓冲 5000 行丢头保尾），
 *   供 build:getState 重开对话框恢复；不落盘（构建输出属易失信息，演进空间见 README）。
 *
 * 同一项目同时只允许一个构建（重复 run 报错）；不同项目可并行。
 * 本模块零 electron 依赖（spawn/killTree/广播均注入），vitest 用 fake child 全链路测试。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import * as iconv from 'iconv-lite'
import type {
  BuildOutputEvent,
  BuildState,
  BuildStatusEvent,
  Jdk,
  Maven,
  Project
} from '../../shared/types'
import type { KillResult } from '../process/task-killer'
import { findMvnScript } from './maven-scanner'

/** 输出行滚动缓冲上限（丢头部保尾部；对话框展示最近构建输出足够） */
const MAX_LINES = 5_000
/** 输出批量推送间隔（ms）与单批行数上限（与 log:appended 同款参数） */
const OUTPUT_FLUSH_MS = 200
const OUTPUT_BATCH_LINES = 100
/** 取消构建的杀树预算 */
const CANCEL_KILL_TIMEOUT_MS = 8_000
/** buildCommand 缺省值 */
const DEFAULT_BUILD_COMMAND = 'clean package'

export interface BuildRunnerDeps {
  /** 只读配置面（ConfigStore 结构子集） */
  store: {
    listProjects(): Project[]
    listMavens(): Maven[]
    listJdks(): Jdk[]
  }
  /** 进程树终止（task-killer.makeTaskTools().killTree；与停止项目同一套） */
  killTree: (pid: number, timeoutMs?: number) => Promise<KillResult>
  /** build:output 事件广播（ipc-registry 的 broadcastEvent 注入） */
  broadcastOutput: (event: BuildOutputEvent) => void
  /** build:statusChanged 事件广播 */
  broadcastStatus: (event: BuildStatusEvent) => void
  /** spawn 注入（测试 fake；缺省 node:child_process.spawn） */
  spawner?: typeof spawn
}

interface RunningBuild {
  state: BuildState
  /** ChildProcess 的结构子集（宽签名：fake child 注入用） */
  child: { pid?: number; kill?: () => unknown }
  cancelRequested: boolean
  byteBuffer: Buffer
  pendingLines: string[]
  flushTimer: ReturnType<typeof setInterval> | null
}

/** 行级解码：严格 UTF-8（无替换符）优先，含非 ASCII 且 UTF-8 失败回退 GBK */
function decodeLine(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  return iconv.decode(buf, 'gbk')
}

/** 参数引号：含空白才包双引号（-D 属性带 = 不需要；路径含空格需要） */
function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg
}

/**
 * 构建工作目录推断：显式 buildDir 优先（调用方校验存在）；缺省启发式——
 * jar 父目录名为 target（mvn 标准输出布局）→ 取其上一级（项目根），否则 jar 所在目录。
 */
export function resolveBuildWorkDir(project: Project): string {
  if (project.buildDir !== undefined && project.buildDir.trim().length > 0) {
    return path.resolve(project.buildDir.trim())
  }
  const jarDir = path.dirname(project.jarPath)
  if (path.basename(jarDir).toLowerCase() === 'target') {
    return path.dirname(jarDir)
  }
  return jarDir
}

export class BuildRunner {
  private readonly builds = new Map<string, RunningBuild>()

  constructor(private readonly deps: BuildRunnerDeps) {}

  /** 启动构建；配置缺失/进行中抛 Error（中文，IPC 层转 VALIDATION_ERROR/CONFLICT 语义由调用方定） */
  async run(projectId: string): Promise<BuildState> {
    if (this.builds.has(projectId)) {
      const current = this.builds.get(projectId)!
      if (current.state.status === 'running') {
        throw new Error('该项目正在构建中，请等待完成或先取消')
      }
    }

    const project = this.deps.store.listProjects().find((p) => p.id === projectId)
    if (!project) throw new Error(`项目不存在：${projectId}`)
    if (!project.mavenId) throw new Error('项目未配置构建信息（构建配置未绑定 Maven）')
    const maven = this.deps.store.listMavens().find((m) => m.id === project.mavenId)
    if (!maven) throw new Error('项目绑定的 Maven 已不存在，请到项目「构建配置」重新绑定')
    const jdk = this.deps.store.listJdks().find((j) => j.id === project.jdkId)
    if (!jdk) throw new Error('项目绑定的 JDK 已不存在，请先在编辑页改绑 JDK')

    const workDir = resolveBuildWorkDir(project)
    if (project.buildDir !== undefined && project.buildDir.trim().length > 0) {
      try {
        const st = await stat(workDir)
        if (!st.isDirectory()) throw new Error('not a dir')
      } catch {
        throw new Error(`构建目录不存在：${workDir}（项目「构建配置」里的构建目录配置有误）`)
      }
    }
    const mvnScript = await findMvnScript(maven.homePath)
    if (!mvnScript) {
      throw new Error(`Maven 脚本缺失：${path.join(maven.homePath, 'bin')}\\mvn.cmd（目录被移动或损坏，请到 Maven 页修正路径）`)
    }

    const goals = (project.buildCommand ?? DEFAULT_BUILD_COMMAND).trim().split(/\s+/).filter(Boolean)
    const args = [
      '-B', // batch mode：无 ANSI 进度条污染输出
      ...(maven.settingsPath !== undefined ? ['-s', maven.settingsPath] : []),
      ...(maven.localRepoPath !== undefined
        ? [`-Dmaven.repo.local=${maven.localRepoPath}`]
        : []),
      ...goals
    ]
    const commandLine = [ `"${mvnScript}"`, ...args.map(quoteArg) ].join(' ')

    const jdkBin = path.join(jdk.homePath, 'bin')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAVA_HOME: jdk.homePath,
      PATH: `${jdkBin}${path.delimiter}${process.env.PATH ?? ''}`,
      ...project.envVars
    }

    const state: BuildState = {
      projectId,
      status: 'running',
      commandLine,
      workDir,
      startedAt: Date.now(),
      lines: []
    }

    const spawnFn = this.deps.spawner ?? spawn
    const child = spawnFn('cmd.exe', ['/d', '/s', '/c', commandLine], {
      windowsVerbatimArguments: true,
      windowsHide: true,
      cwd: workDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const entry: RunningBuild = {
      state,
      child,
      cancelRequested: false,
      byteBuffer: Buffer.alloc(0),
      pendingLines: [],
      flushTimer: null
    }
    this.builds.set(projectId, entry)

    const onChunk = (chunk: Buffer): void => {
      this.absorb(entry, chunk)
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.on('error', (err) => {
      this.pushLine(entry, `[javamgr] 构建进程启动失败：${err.message}`)
      this.finish(entry, -1, false)
    })
    child.on('close', (code) => {
      // 收尾：残余字节作为最后一行
      if (entry.byteBuffer.length > 0) {
        this.pushLine(entry, entry.byteBuffer)
        entry.byteBuffer = Buffer.alloc(0)
      }
      this.finish(entry, code ?? -1, entry.cancelRequested)
    })

    return structuredClone(state)
  }

  /** 取消进行中的构建（杀树；非 running 时静默——幂等） */
  async stop(projectId: string): Promise<void> {
    const entry = this.builds.get(projectId)
    if (!entry || entry.state.status !== 'running') return
    entry.cancelRequested = true
    this.pushLine(entry, '[javamgr] 正在取消构建（终止 mvn 进程树）…')
    if (entry.child.pid !== undefined) {
      const result = await this.deps.killTree(entry.child.pid, CANCEL_KILL_TIMEOUT_MS)
      if (!result.ok) {
        // 兜底：杀树失败用 child.kill 直杀（degraded 情况主进程已被杀，这里通常已 close）
        entry.child.kill?.()
      }
    } else {
      entry.child.kill?.()
    }
  }

  getState(projectId: string): BuildState | null {
    const entry = this.builds.get(projectId)
    return entry ? structuredClone(entry.state) : null
  }

  // ---------- 内部：行切分 / 批量推送 / 终态 ----------

  private absorb(entry: RunningBuild, chunk: Buffer): void {
    entry.byteBuffer = Buffer.concat([entry.byteBuffer, chunk])
    let nl: number
    while ((nl = entry.byteBuffer.indexOf(0x0a)) !== -1) {
      let line = entry.byteBuffer.subarray(0, nl)
      entry.byteBuffer = entry.byteBuffer.subarray(nl + 1)
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1)
      this.pushLine(entry, line)
    }
  }

  private pushLine(entry: RunningBuild, raw: Buffer | string): void {
    const text = typeof raw === 'string' ? raw : decodeLine(raw)
    entry.state.lines.push(text)
    if (entry.state.lines.length > MAX_LINES) entry.state.lines.splice(0, entry.state.lines.length - MAX_LINES)
    entry.pendingLines.push(text)
    if (entry.flushTimer === null) {
      entry.flushTimer = setInterval(() => this.flush(entry), OUTPUT_FLUSH_MS)
      // flushTimer.unref?.() —— interval 持有 entry 闭包，构建结束后已在 finish 清理
    }
    if (entry.pendingLines.length >= OUTPUT_BATCH_LINES) this.flush(entry)
  }

  private flush(entry: RunningBuild): void {
    if (entry.pendingLines.length === 0) {
      // 空轮询：避免构建全程挂着空 interval（首行之后才 flush 的场景少见，保守保留）
      return
    }
    const lines = entry.pendingLines.splice(0, entry.pendingLines.length)
    this.deps.broadcastOutput({ projectId: entry.state.projectId, lines })
  }

  private finish(entry: RunningBuild, exitCode: number, cancelled: boolean): void {
    if (entry.state.status !== 'running') return // 已终结（error+close 双触发幂等）
    if (entry.flushTimer !== null) {
      clearInterval(entry.flushTimer)
      entry.flushTimer = null
    }
    this.flush(entry) // 终态前把残余行推完（此时 pendingLines 非空才会广播）
    entry.state.status = cancelled ? 'cancelled' : exitCode === 0 ? 'success' : 'failure'
    entry.state.durationMs = Date.now() - entry.state.startedAt
    if (!cancelled) entry.state.exitCode = exitCode
    this.pushLine(
      entry,
      `[javamgr] 构建结束：${statusLabel(entry.state.status)}${entry.state.exitCode !== undefined ? `（退出码 ${entry.state.exitCode}）` : ''}，耗时 ${(entry.state.durationMs / 1000).toFixed(1)}s`
    )
    this.flush(entry)
    this.deps.broadcastStatus({
      projectId: entry.state.projectId,
      status: entry.state.status,
      ...(entry.state.exitCode !== undefined ? { exitCode: entry.state.exitCode } : {}),
      durationMs: entry.state.durationMs
    })
  }
}

function statusLabel(status: BuildState['status']): string {
  switch (status) {
    case 'success':
      return '成功'
    case 'failure':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return '未知'
  }
}

/** 生成构建 id（预留：落盘/多 run 演进时用作标识；当前单活动构建用 projectId 即可） */
export function newBuildId(): string {
  return randomUUID()
}
