import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/main/config/config-store'
import { resolveAppPaths } from '../../src/main/config/paths'
import { ProcessManager } from '../../src/main/process/process-manager'
import type { RunStartedEvent } from '../../src/main/process/process-manager'
import { createTaskOps, probeAlive } from '../../src/main/process/task-killer'

/**
 * 真实进程集成测试（计划 §3 S3.7，A3/A5/A13/R1 验收抓手；2026-11-09 WMI 病态宿主修复后）：
 * 1. 派生子进程的进程树：stop 后核对父+子全灭——**活体病态环境决定性用例**：
 *    断言 stop 调用 ≤3s 返回且主 java 进程死亡（对照病态期 taskkill 61.6s）；
 *    子进程按返回的 degraded 标志动态断言（健康宿主全灭 / 病态宿主仅主进程+降级说明），
 *    两种宿主状态下都绿；
 * 2. 夹具 System.exit(3)：close 事件驱动 ABNORMAL_EXIT + 退出码；
 * 3. 重识别（工具重启模拟）：第二个 process-manager 实例 reidentify → RUNNING"重识别"
 *    → 外部 Stop-Process → 轮询池 ≤2 周期内检出死亡 → STOPPED"外部退出，退出码未知"。
 *
 * 测试全程不用 taskkill/tasklist（WMI 病态期挂死）；清理/外部杀一律 Get-Process +
 * Stop-Process（PSAPI/TerminateProcess 直达）。测试前后各记录一次 WMI 病态探针结果
 * （Get-CimInstance -OperationTimeoutSec 2 探测，写进输出供报告引用，不作断言）。
 *
 * 前置：本机 D:\java17\jdk-17.0.12（javac/jar/java）；夹具在 beforeAll 现场编译到
 * scripts/fixtures/build/（.gitignore 已忽略）。afterAll 兜底 Stop-Process 全部记录 pid。
 */

const run = promisify(execFile)

const JDK_HOME = 'D:\\java17\\jdk-17.0.12'
const FIXTURES_DIR = path.resolve(__dirname, '../../scripts/fixtures')
const BUILD_DIR = path.join(FIXTURES_DIR, 'build')
const JAR_PATH = path.join(BUILD_DIR, 'loggy.jar')

const taskOps = createTaskOps()

/** 全部经 ProcessManager 拉起过的 pid（afterAll 兜底清理） */
const launchedPids = new Set<number>()

let baseDir: string
let store: ConfigStore
let projectId: string

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  what: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
    await sleep(250)
  }
}

/** WMI 病态探针：Get-CimInstance 带 2s 操作超时，报告健康/病态与耗时（供报告引用） */
async function wmiHealthProbe(tag: string): Promise<void> {
  const t0 = Date.now()
  try {
    await run(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}" -OperationTimeoutSec 2 -ErrorAction Stop | Out-Null`
      ],
      { timeout: 8_000 }
    )
    const ms = Date.now() - t0
    console.log(`[wmi-probe:${tag}] HEALTHY (${ms}ms)`)
  } catch (err) {
    const ms = Date.now() - t0
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
    console.log(`[wmi-probe:${tag}] SICK (${ms}ms): ${msg.slice(0, 120)}`)
  }
}

/** 外部强杀一个 pid（Stop-Process，不用 taskkill——病态期 taskkill 61s+） */
async function externalKill(pid: number): Promise<void> {
  await run(
    'powershell',
    ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
    { timeout: 10_000 }
  )
}

/** 收集 stdout 文本（run:started 句柄交付路径，S4 log-manager 同款消费方式） */
function attachStdoutCollector(
  pm: ProcessManager,
  sink: { text: string; chunks: string[] }
): void {
  pm.setLogHooks({
    onRunStarted: (event: RunStartedEvent) => {
      launchedPids.add(event.pid)
      event.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        sink.text += text
        sink.chunks.push(text)
      })
      event.stderr?.resume()
    }
  })
}

function parseChildPids(text: string): number[] {
  const pids: number[] = []
  for (const match of text.matchAll(/child #\d+ spawned, pid=(\d+)/g)) {
    pids.push(Number.parseInt(match[1] ?? '', 10))
  }
  return pids
}

beforeAll(async () => {
  await wmiHealthProbe('before')

  // 1) 现场编译夹具（javac -encoding UTF-8 + jar cfe，见 scripts/fixtures/README.md）
  await rm(BUILD_DIR, { recursive: true, force: true })
  await run(path.join(JDK_HOME, 'bin', 'javac.exe'), [
    '-encoding',
    'UTF-8',
    '-d',
    BUILD_DIR,
    path.join(FIXTURES_DIR, 'Loggy.java')
  ])
  await run(path.join(JDK_HOME, 'bin', 'jar.exe'), [
    '--create',
    '--file',
    JAR_PATH,
    '--main-class',
    'Loggy',
    '-C',
    BUILD_DIR,
    '.'
  ])

  // 2) 真实 ConfigStore（临时 userData）+ 项目/JDK 指向真实 JDK 与夹具 jar
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-it-'))
  store = new ConfigStore(resolveAppPaths(baseDir))
  await store.init()
  await store.addJdk({
    id: 'jdk-it',
    name: 'Temurin 17.0.12',
    homePath: JDK_HOME,
    version: '17.0.12',
    vendor: 'Eclipse Temurin',
    source: 'manual'
  })
  const created = await store.createProject({
    name: 'LoggyIT',
    jarPath: JAR_PATH,
    jdkId: 'jdk-it',
    jvmArgs: [],
    programArgs: [],
    envVars: {}
  })
  projectId = created.id
}, 120_000)

afterAll(async () => {
  // 兜底清理：任何仍存活的记录 pid 一律 Stop-Process（TerminateProcess 直达，
  // WMI 病态期可用；不用 taskkill——本机病态期 taskkill 单次 61s+）
  for (const pid of launchedPids) {
    try {
      await externalKill(pid)
    } catch {
      // 已死则忽略
    }
  }
  // 夹具 ping 子进程残留兜底（degraded 场景子进程不在 launchedPids 内）
  try {
    await run(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-Process -Name ping -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
      ],
      { timeout: 15_000 }
    )
  } catch {
    // 无残留则忽略
  }
  if (baseDir) await rm(baseDir, { recursive: true, force: true })
  await wmiHealthProbe('after')
}, 60_000)

/** 更新项目程序参数后重建运行环境 */
async function setProgramArgs(args: string[]): Promise<void> {
  const current = store.listProjects().find((p) => p.id === projectId)
  if (!current) throw new Error('测试项目不存在')
  await store.updateProject({ ...current, programArgs: args })
}

describe('integration/process-manager：真实进程树终止（WMI 病态宿主活体验证）', () => {
  it('启动派生 2 个子进程 → 停止 ≤3s 返回且主进程死亡（R1/A3；病态期对照 taskkill 61s）', async () => {
    await setProgramArgs(['--children=2', '--interval=200'])
    const pm = new ProcessManager({
      store,
      runsFile: resolveAppPaths(baseDir).runsFile,
      taskOps
    })
    const sink = { text: '', chunks: [] as string[] }
    attachStdoutCollector(pm, sink)

    const startResult = await pm.startProject(projectId)
    expect(startResult.ok).toBe(true)
    const parentPid = startResult.pid as number

    // STARTING → RUNNING：无 log 模块时走 startupGraceSeconds（默认 5s）兜底
    const running = await waitFor(
      () => (pm.getRuntimeState(projectId)?.status === 'RUNNING' ? true : undefined),
      12_000,
      'grace 兜底转 RUNNING'
    )
    expect(running).toBe(true)

    // 2026-11-10 cwd 修复（真实子进程验证）：banner 的 user.dir = jar 所在目录，
    // 相对路径平级配置文件（Spring file:config/ 等）按此解析
    const bannerUserDir = await waitFor(() => {
      const m = sink.text.match(/user\.dir=(.+)/)
      return m ? m[1]!.trim() : undefined
    }, 10_000, 'banner 输出 user.dir')
    expect(bannerUserDir.toLowerCase()).toBe(path.dirname(JAR_PATH).toLowerCase())

    // 子进程 pid 从夹具 banner 解析（child #N spawned, pid=X）
    const childPids = await waitFor(() => {
      const parsed = parseChildPids(sink.text)
      return parsed.length >= 2 ? parsed : undefined
    }, 10_000, '夹具派生 2 个子进程')
    expect(childPids.length).toBeGreaterThanOrEqual(2)
    for (const pid of childPids) {
      launchedPids.add(pid)
      expect(probeAlive(pid)).toBe(true)
    }

    // 停止（决定性断言）：≤3s 返回 + ok（病态 WMI 下原 taskkill 路径 8s 超时失败）
    const stopResult = await pm.stopProject(projectId)
    expect(stopResult.ok).toBe(true)
    expect(stopResult.durationMs).toBeLessThanOrEqual(3_000)
    console.log(
      `[stop-timing] durationMs=${stopResult.durationMs} degraded=${stopResult.note ?? 'no'}`
    )

    // 主 java 进程死亡（kill0 零 spawn 验证）
    expect(probeAlive(parentPid)).toBe(false)
    expect(pm.getRuntimeState(projectId)?.status).toBe('STOPPED')

    // 子进程：按 degraded 标志动态断言（两种宿主状态都绿）
    const degraded = stopResult.note !== undefined
    if (!degraded) {
      // 健康宿主：CIM 枚举成功 → 全树灭
      for (const pid of childPids) {
        await waitFor(() => (!probeAlive(pid) ? true : undefined), 5_000, `pid ${pid} 死亡`)
      }
      console.log('[stop-timing] 全树终止（WALK=OK）：子进程全部死亡')
    } else {
      // 病态宿主：降级仅主进程 → note 必含降级说明；子进程由 afterAll 的 ping 清场兜底
      expect(stopResult.note).toMatch(/WMI 子进程枚举不可用/)
      const orphaned = childPids.filter((pid) => probeAlive(pid))
      console.log(
        `[stop-timing] 降级终止（note=${stopResult.note}）：子进程残留 ${orphaned.length}/${childPids.length}（由测试收尾清理）`
      )
    }

    await pm.prepareForExit()
  }, 60_000)
})

describe('integration/process-manager：异常退出码', () => {
  it('夹具 System.exit(3) → close 事件驱动 ABNORMAL_EXIT + 退出码 3（A5）', async () => {
    await setProgramArgs(['--exit-after=3', '--exit-code=3', '--interval=200'])
    const pm = new ProcessManager({
      store,
      runsFile: resolveAppPaths(baseDir).runsFile,
      taskOps
    })
    attachStdoutCollector(pm, { text: '', chunks: [] })

    const startResult = await pm.startProject(projectId)
    expect(startResult.ok).toBe(true)

    const abnormal = await waitFor(
      () => {
        const state = pm.getRuntimeState(projectId)
        return state?.status === 'ABNORMAL_EXIT' ? state : undefined
      },
      20_000,
      'ABNORMAL_EXIT'
    )
    expect(abnormal.exitCode).toBe(3)

    await pm.prepareForExit()
  }, 60_000)
})

describe('integration/process-manager：重识别 + 轮询池（A13 核心）', () => {
  it('启动 → 第二实例 reidentify 得 RUNNING"重识别" → 外部 Stop-Process → ≤2 周期内检出死亡', async () => {
    // PM_A：原工具实例（持有句柄）
    await setProgramArgs(['--interval=500'])
    const pmA = new ProcessManager({
      store,
      runsFile: resolveAppPaths(baseDir).runsFile,
      taskOps
    })
    attachStdoutCollector(pmA, { text: '', chunks: [] })
    const startResult = await pmA.startProject(projectId)
    expect(startResult.ok).toBe(true)
    const pid = startResult.pid as number
    await waitFor(
      () => (pmA.getRuntimeState(projectId)?.status === 'RUNNING' ? true : undefined),
      12_000,
      'PM_A grace 兜底转 RUNNING'
    )

    // PM_B：模拟工具重启（新实例、无句柄），读同一份 runs.json 重识别
    const eventsB: Array<{ status: string; note?: string }> = []
    const pmB = new ProcessManager({
      store,
      runsFile: resolveAppPaths(baseDir).runsFile,
      taskOps,
      broadcaster: (payload) => eventsB.push({ status: payload.status, note: payload.note })
    })
    await pmB.initialize() // reidentify（kill0 初筛 + 一次批量 Get-Process）+ 启动轮询池

    const reidentified = pmB.getRuntimeState(projectId)
    expect(reidentified?.status).toBe('RUNNING')
    expect(reidentified?.pid).toBe(pid)
    expect(reidentified?.note).toBe('重识别')
    expect(pmB.registry.poolSize()).toBe(1)

    // 外部强杀（模拟用户/其他工具终止；Stop-Process 直达，不用 taskkill——本用例无子进程）
    await externalKill(pid)

    // 轮询池（5s 间隔）应在 ≤2 周期（≤10s，留余量 15s）内检出死亡
    const deadState = await waitFor(
      () => {
        const state = pmB.getRuntimeState(projectId)
        return state?.status === 'STOPPED' && state.note === '外部退出，退出码未知' ? state : undefined
      },
      15_000,
      '轮询池检出外部退出'
    )
    expect(deadState.pid).toBe(pid)
    expect(eventsB.some((e) => e.status === 'STOPPED' && e.note === '外部退出，退出码未知')).toBe(true)

    // PM_A 的句柄路径（close 事件）也终态化：强杀退出码非 0 → ABNORMAL_EXIT
    await waitFor(
      () => (pmA.getRuntimeState(projectId)?.status === 'ABNORMAL_EXIT' ? true : undefined),
      10_000,
      'PM_A close 事件终态'
    )

    await pmA.prepareForExit()
    await pmB.prepareForExit() // 停轮询，防定时器悬挂阻塞 vitest 退出
  }, 90_000)
})
