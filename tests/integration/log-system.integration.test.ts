import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/main/config/config-store'
import { resolveAppPaths } from '../../src/main/config/paths'
import { LogManager } from '../../src/main/log/log-manager'
import type { LogAppendedEvent } from '../../src/shared/types'
import { ProcessManager } from '../../src/main/process/process-manager'
import type { RunStartedEvent } from '../../src/main/process/process-manager'
import { createTaskOps } from '../../src/main/process/task-killer'

/**
 * 日志系统真实进程集成测试（计划 §3 S4 / §6 验证 A2 前半、A8、A9、A10）：
 * 1. GBK 夹具 stdout 中文无乱码（F3 编码判定 + A10）；
 * 2. UTF-8 夹具同验 + stdout 捕获落盘 + 模拟工具重启（新 LogManager）后 readHistory 可读（A9）；
 * 3. 首条日志即转 RUNNING（markRunning 握手，A2 前半；startupGraceSeconds 调大排除兜底干扰）；
 * 4. 文件 tail + logback 式轮转跟随不丢不重（A8）；
 * 5. file 路互斥：stdout banner 被排空不推送，文件行推送。
 *
 * 前置：本机 D:\java17\jdk-17.0.12；夹具 beforeAll 现场编译。afterAll 兜底 taskkill 全部 pid。
 */

const run = promisify(execFile)

const JDK_HOME = 'D:\\java17\\jdk-17.0.12'
const FIXTURES_DIR = path.resolve(__dirname, '../../scripts/fixtures')
/** 编译产物放在本文件专属临时目录（vitest 并行跑多个集成文件时，
 * 与 process-manager.integration.test.ts 的共享 build 目录互不锁文件） */
let BUILD_DIR = ''
let JAR_PATH = ''

const taskOps = createTaskOps()
const launchedPids = new Set<number>()

let baseDir: string
let store: ConfigStore
let logsDir: string
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
    await sleep(200)
  }
}

/** 装配（等价 index.ts）：ProcessManager ⇄ LogManager S-1 握手 + 状态/日志双通道 */
interface Rig {
  pm: ProcessManager
  lm: LogManager
  chunks: LogAppendedEvent[]
  lines: string[]
}

function makeRig(): Rig {
  const chunks: LogAppendedEvent[] = []
  const lines: string[] = []
  const lm = new LogManager({
    store,
    logsDir,
    tailPollIntervalMs: 300,
    broadcaster: (c) => {
      chunks.push(c)
      lines.push(...c.lines)
    },
    markRunning: (id) => rig.pm.markRunning(id) // S-1：log → process 唯一信号通道
  })
  const pm = new ProcessManager({
    store,
    runsFile: resolveAppPaths(baseDir).runsFile,
    taskOps,
    broadcaster: (payload) => {
      broadcastSink.push(payload)
      lm.handleStatusChanged(payload) // 终态：flush 残行 + 关闭 tailer/管道
    }
  })
  const rig: Rig = { pm, lm, chunks, lines }
  pm.setLogHooks({
    onRunStarted: (event: RunStartedEvent) => {
      launchedPids.add(event.pid)
      lm.handleRunStarted(event)
    }
  })
  return rig
}

const broadcastSink: Array<{ projectId: string; status: string }> = []

async function setProject(patch: {
  programArgs?: string[]
  logFilePath?: string
}): Promise<void> {
  const current = store.listProjects().find((p) => p.id === projectId)
  if (!current) throw new Error('测试项目不存在')
  await store.updateProject({
    ...current,
    ...(patch.programArgs !== undefined ? { programArgs: patch.programArgs } : {}),
    ...(patch.logFilePath !== undefined ? { logFilePath: patch.logFilePath } : {})
  })
}

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-logit-'))
  logsDir = path.join(baseDir, 'logs')
  BUILD_DIR = path.join(baseDir, 'fixture-build')
  JAR_PATH = path.join(BUILD_DIR, 'loggy.jar')
  await run(path.join(JDK_HOME, 'bin', 'javac.exe'), [
    '-encoding', 'UTF-8', '-d', BUILD_DIR, path.join(FIXTURES_DIR, 'Loggy.java')
  ])
  await run(path.join(JDK_HOME, 'bin', 'jar.exe'), [
    '--create', '--file', JAR_PATH, '--main-class', 'Loggy', '-C', BUILD_DIR, '.'
  ])

  store = new ConfigStore(resolveAppPaths(baseDir))
  await store.init()
  await store.addJdk({
    id: 'jdk-it', name: 'Temurin 17.0.12', homePath: JDK_HOME,
    version: '17.0.12', vendor: 'Eclipse Temurin', source: 'manual'
  })
  const created = await store.createProject({
    name: 'LoggyLogIT', jarPath: JAR_PATH, jdkId: 'jdk-it',
    jvmArgs: [], programArgs: [], envVars: {}
  })
  projectId = created.id
}, 120_000)

afterAll(async () => {
  // 兜底清理：Stop-Process 直达（WMI 病态期 taskkill 单次 61s+ 会拖爆 hook 超时）
  for (const pid of launchedPids) {
    try {
      await run(
        'powershell',
        ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
        { timeout: 10_000 }
      )
    } catch {
      // 已死则忽略
    }
  }
  if (baseDir) await rm(baseDir, { recursive: true, force: true })
}, 60_000)

describe('integration/log：stdout 捕获与编码（A9/A10）', () => {
  it('GBK 夹具：首行 ASCII banner + 后续中文 → 锁定 GBK，中文无乱码；readHistory 可读', async () => {
    await setProject({ programArgs: ['--mode=gbk', '--interval=100'] })
    const rig = makeRig()
    const started = await rig.pm.startProject(projectId)
    expect(started.ok).toBe(true)

    const chineseLine = await waitFor(
      () => (rig.lines.some((l) => l.includes('服务运行正常')) ? true : undefined),
      25_000,
      'GBK 中文行无乱码到达'
    )
    expect(chineseLine).toBe(true)
    // 无替换字符（乱码标志）
    expect(rig.lines.some((l) => l.includes('\uFFFD'))).toBe(false)
    // banner 为纯 ASCII 行（透传，未参与判定）也在流中
    expect(rig.lines.some((l) => l.startsWith('Loggy v1.0 starting'))).toBe(true)

    await rig.pm.stopProject(projectId)
    await rig.pm.prepareForExit()
    await rig.lm.shutdown()

    const hist = await rig.lm.readHistory({ projectId, lines: 50, source: 'auto' })
    expect(hist.source).toBe('stdout')
    expect(hist.lines.some((l) => l.includes('服务运行正常'))).toBe(true)
    expect(hist.lines.some((l) => l.includes('\uFFFD'))).toBe(false)
  }, 60_000)

  it('UTF-8 夹具：中文正确解码；stdout 落盘；模拟工具重启（新 LogManager）后历史可查（A9）', async () => {
    await setProject({ programArgs: ['--interval=100'] })
    const rig = makeRig()
    const started = await rig.pm.startProject(projectId)
    expect(started.ok).toBe(true)
    await waitFor(
      () => (rig.lines.some((l) => l.includes('服务运行正常')) ? true : undefined),
      25_000,
      'UTF-8 中文行到达'
    )
    await rig.pm.stopProject(projectId)
    await rig.pm.prepareForExit()
    await rig.lm.shutdown()

    // 落盘验证：logs/<projectId>/<runId>.log 存在且含中文
    const runDir = path.join(logsDir, projectId)
    const files = await readdir(runDir)
    expect(files.some((f) => f.endsWith('.log'))).toBe(true)

    // 模拟工具重启：全新 LogManager（不同实例）读同一 logsDir 的历史
    const reborn = new LogManager({ store, logsDir })
    const hist = await reborn.readHistory({ projectId, lines: 100, source: 'stdout' })
    expect(hist.source).toBe('stdout')
    expect(hist.lines.some((l) => l.includes('服务运行正常'))).toBe(true)
    await reborn.shutdown()
  }, 60_000)

  it('markRunning 握手：首条日志即转 RUNNING（A2 前半；grace 调大排除兜底干扰）', async () => {
    await store.setSettings({ startupGraceSeconds: 120 }) // 兜底远在观察窗外
    await setProject({ programArgs: ['--interval=100'] })
    const rig = makeRig()
    const t0 = Date.now()
    const started = await rig.pm.startProject(projectId)
    expect(started.ok).toBe(true)
    expect(rig.pm.getRuntimeState(projectId)?.status).toBe('STARTING')

    // 首条日志到达（JVM 启动 + banner）→ RUNNING；120s grace 不可能在此窗口触发
    await waitFor(
      () => (rig.pm.getRuntimeState(projectId)?.status === 'RUNNING' ? true : undefined),
      20_000,
      '首条日志驱动 STARTING→RUNNING'
    )
    expect(Date.now() - t0).toBeLessThan(20_000) // 排除 grace 兜底路径

    await rig.pm.stopProject(projectId)
    await rig.pm.prepareForExit()
    await rig.lm.shutdown()
    await store.setSettings({ startupGraceSeconds: 5 }) // 恢复默认，防影响其他用例
  }, 60_000)
})

describe('integration/log：文件 tail 与轮转（A8）', () => {
  it('logback 式轮转（每 50 行 rename+重建）：tail 不丢跟——行序严格递增无重复', async () => {
    const logFile = path.join(baseDir, 'rotate', 'app.log')
    await setProject({ programArgs: ['--log=' + logFile, '--rotate=50', '--interval=60'], logFilePath: logFile })
    const rig = makeRig()
    const started = await rig.pm.startProject(projectId)
    expect(started.ok).toBe(true)

    // ≥3 次轮转（150 行）量的行到达后校验
    await waitFor(
      () => (extractSeqs(rig.lines).length >= 160 ? true : undefined),
      40_000,
      '跨 ≥3 次轮转收集 160+ 行'
    )
    const seqs = extractSeqs(rig.lines)
    // 不丢不重：INFO 行 seq 严格递增且唯一（重复/回退 = 丢跟或误重读）
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number)
    }
    expect(new Set(seqs).size).toBe(seqs.length)

    await rig.pm.stopProject(projectId)
    await rig.pm.prepareForExit()
    await rig.lm.shutdown()
  }, 90_000)

  it('file 路互斥：stdout banner 被排空不推送；文件行以 source=file 推送', async () => {
    const logFile = path.join(baseDir, 'mutex', 'app.log')
    await setProject({ programArgs: ['--log=' + logFile, '--interval=100'], logFilePath: logFile })
    const rig = makeRig()
    const started = await rig.pm.startProject(projectId)
    expect(started.ok).toBe(true)

    await waitFor(
      () => (rig.lines.some((l) => l.includes('服务运行正常')) ? true : undefined),
      30_000,
      '文件路日志推送'
    )
    // banner 只写 console 不写文件：file 路排空 stdout，不得出现在推送中
    expect(rig.lines.some((l) => l.startsWith('Loggy v1.0 starting'))).toBe(false)
    expect(rig.chunks.every((c) => c.source === 'file')).toBe(true)

    await rig.pm.stopProject(projectId)
    await rig.pm.prepareForExit()
    await rig.lm.shutdown()
  }, 60_000)
})

/** 从广播行提取 INFO 行的 seq（"已处理 <seq*100> 个请求"），用于轮转丢跟校验 */
function extractSeqs(lines: string[]): number[] {
  const seqs: number[] = []
  for (const line of lines) {
    const m = /已处理 (\d+) 个请求/.exec(line)
    if (m) seqs.push(Number(m[1]))
  }
  return seqs
}
