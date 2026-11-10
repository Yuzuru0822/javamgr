import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/main/config/config-store'
import { resolveAppPaths } from '../../src/main/config/paths'
import { ProcessManager } from '../../src/main/process/process-manager'
import type { LogHooks, RunStartedEvent, SpawnFn } from '../../src/main/process/process-manager'
import type { TaskOps } from '../../src/main/process/task-killer'
import type { ChildProcess } from 'node:child_process'
import type { StatusChangedEvent } from '../../src/shared/types'

/**
 * process-manager 单测：fake spawner（EventEmitter + PassThrough 伪管道）+ mock TaskOps。
 * 覆盖计划 §2.3-A 核心断言：操作队列串行化（并发 start×3 仅一次 spawn）、幂等四规则、
 * restart 持锁直调不自等（N-4）、状态机流转、close 终态、grace 兜底、markRunning 先到即转。
 * 真实进程行为（taskkill 树终止/重识别/轮询池）在 tests/integration 验证。
 */

// ---------- 测试基建 ----------

let baseDir: string
let jarPath: string
let jdkHome: string
let store: ConfigStore
let projectId: string

interface FakeChild extends EventEmitter {
  pid: number | undefined
  stdout: PassThrough
  stderr: PassThrough
  unref(): void
  emitClose(code: number | null): void
}

function makeFakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.unref = () => {}
  child.emitClose = (code) => child.emit('close', code)
  return child
}

/** fake spawner：记录调用、递增 pid */
function makeSpawner(): {
  spawner: SpawnFn
  calls: Array<{ command: string; args: string[] }>
  children: FakeChild[]
} {
  const calls: Array<{ command: string; args: string[] }> = []
  const children: FakeChild[] = []
  let nextPid = 4000
  const spawner = ((command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] })
    const child = makeFakeChild(nextPid++)
    children.push(child)
    return child as unknown as ChildProcess
  }) as SpawnFn
  return { spawner, calls, children }
}

function makeTaskOps(overrides?: Partial<TaskOps> & { killDelayMs?: number }): {
  taskOps: TaskOps
  killCalls: number[]
} {
  const killCalls: number[] = []
  const killDelayMs = overrides?.killDelayMs ?? 0
  const taskOps: TaskOps = {
    probeAlive(pid) {
      return !killCalls.includes(pid)
    },
    async isAlive(pid) {
      return killCalls.includes(pid) ? { alive: false } : { alive: true, image: 'java' }
    },
    async batchQueryProcesses(pids) {
      if (pids.length === 0) return new Map()
      return new Map(killCalls.length === 0 ? pids.map((p) => [p, { name: 'java', startTime: Date.now() }]) : [])
    },
    async killTree(pid) {
      killCalls.push(pid)
      if (killDelayMs > 0) await new Promise((r) => setTimeout(r, killDelayMs))
      return { ok: true, durationMs: 10 }
    },
    ...overrides
  }
  return { taskOps, killCalls }
}

const immediateSleep = (): Promise<void> => Promise.resolve()

function makeManager(opts?: {
  spawner?: SpawnFn
  taskOps?: TaskOps
  logHooks?: LogHooks
}): { pm: ProcessManager; events: StatusChangedEvent[] } {
  const events: StatusChangedEvent[] = []
  const pm = new ProcessManager({
    store,
    runsFile: resolveAppPaths(baseDir).runsFile,
    broadcaster: (payload) => events.push(payload),
    batchStaggerMs: 0,
    sleep: immediateSleep,
    ...(opts?.spawner !== undefined ? { spawner: opts.spawner } : {}),
    ...(opts?.taskOps !== undefined ? { taskOps: opts.taskOps } : {})
  })
  if (opts?.logHooks) pm.setLogHooks(opts.logHooks)
  return { pm, events }
}

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-pm-'))
  jarPath = path.join(baseDir, 'app.jar')
  await writeFile(jarPath, 'fake-jar-bytes')
  // 自包含假 JDK 树（doStart 前置校验检查 bin\java.exe 存在性，不依赖本机安装）
  jdkHome = path.join(baseDir, 'jdk')
  await mkdir(path.join(jdkHome, 'bin'), { recursive: true })
  await writeFile(path.join(jdkHome, 'bin', 'java.exe'), 'fake-java')
  store = new ConfigStore(resolveAppPaths(baseDir))
  await store.init()
  const created = await store.createProject({
    name: 'LoggyDemo',
    jarPath,
    jdkId: 'jdk-test',
    jvmArgs: ['-Xmx128m'],
    programArgs: ['--interval=1000'],
    envVars: { APP_ENV: 'demo' }
  })
  projectId = created.id
  await store.addJdk({
    id: 'jdk-test',
    name: 'Temurin 17',
    homePath: jdkHome,
    version: '17.0.12',
    vendor: 'Eclipse Temurin',
    source: 'manual'
  })
  // grace 兜底默认拉长，避免与 markRunning 用例竞态；兜底用例单独改小
  await store.setSettings({ startupGraceSeconds: 60 })
})

afterEach(async () => {
  // maxRetries：close 事件的异步 registry 写盘（void remove）可能与清理竞争，Windows 下按 Node 约定重试
  await rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// ---------- 启动路径 ----------

describe('process-manager / start 校验与 spawn 契约', () => {
  it('jar 不存在 → 结构化错误（S6.2：含路径与建议），状态不变', async () => {
    const missing = path.join(baseDir, 'moved', 'app.jar')
    await store.updateProject({
      id: projectId,
      name: 'LoggyDemo',
      jarPath: missing,
      jdkId: 'jdk-test',
      jvmArgs: [],
      programArgs: [],
      envVars: {}
    })
    const { spawner, calls } = makeSpawner()
    const { pm } = makeManager({ spawner })
    const result = await pm.startProject(projectId)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('jar 文件不存在')
    expect(result.error).toContain(missing) // 含路径
    expect(result.error).toMatch(/重新选择 jar 路径/) // 含建议
    expect(calls).toHaveLength(0)
    expect(pm.getRuntimeState(projectId)).toBeUndefined()
  })

  it('jdkId 无效 → 结构化错误（S6.2：含项目名与建议）', async () => {
    await store.updateProject({
      id: projectId,
      name: 'LoggyDemo',
      jarPath,
      jdkId: 'jdk-ghost',
      jvmArgs: [],
      programArgs: [],
      envVars: {}
    })
    const { spawner, calls } = makeSpawner()
    const { pm } = makeManager({ spawner })
    const result = await pm.startProject(projectId)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('LoggyDemo') // 项目可辨识
    expect(result.error).toMatch(/绑定的 JDK 已不存在/)
    expect(result.error).toMatch(/重新选择 JDK/) // 建议
    expect(calls).toHaveLength(0)
  })

  it('S6.2 JDK 安装目录被删（bin\\java.exe 不存在）→ 友好报错（含 JDK 名与 java.exe 路径），不进入 spawn', async () => {
    await rm(path.join(jdkHome, 'bin', 'java.exe'), { force: true })
    const { spawner, calls } = makeSpawner()
    const { pm } = makeManager({ spawner })
    const result = await pm.startProject(projectId)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('JDK 路径无效')
    expect(result.error).toContain('Temurin 17') // 具体哪个 JDK
    expect(result.error).toContain(path.join(jdkHome, 'bin', 'java.exe')) // 具体缺哪个文件
    expect(result.error).toMatch(/修正该 JDK 路径|改绑其他 JDK/) // 建议
    expect(calls).toHaveLength(0)
    expect(pm.getRuntimeState(projectId)).toBeUndefined() // 状态不变
  })

  it('spawn 契约：java.exe + 参数顺序（jvmArgs 在 -jar 前）+ detached/windowsHide/JAVA_HOME env', async () => {
    const { spawner, calls, children } = makeSpawner()
    let captured: RunStartedEvent | undefined
    const { pm } = makeManager({
      spawner,
      logHooks: { onRunStarted: (e) => (captured = e) }
    })
    const result = await pm.startProject(projectId)
    expect(result.ok).toBe(true)
    expect(result.status).toBe('STARTING')
    expect(result.pid).toBe(children[0]?.pid)

    const call = calls[0]
    expect(call?.command).toBe(path.join(jdkHome, 'bin', 'java.exe'))
    expect(call?.args).toEqual(['-Xmx128m', '-jar', jarPath, '--interval=1000'])

    // run:started 事件（S-1）：pid/runId/句柄交付
    expect(captured?.pid).toBe(children[0]?.pid)
    expect(captured?.runId).toMatch(/^\d{8}-\d{6}-/)
    expect(captured?.stdout).toBe(children[0]?.stdout)
    expect(captured?.stderr).toBe(children[0]?.stderr)
  })

  it('P2-3（phase4 审查）：runs.json 落盘失败 → 启动仍成功，close 监听已挂、管道已排空，无幽灵 STARTING', async () => {
    const { spawner, children } = makeSpawner()
    const { pm } = makeManager({ spawner })
    // 注入 upsert 失败（Windows 杀软/索引器锁 rename 的 EPERM 窗口）
    const upsertSpy = vi.spyOn(pm.registry, 'upsert').mockRejectedValue(
      new Error('EPERM: operation not permitted, rename')
    )
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await pm.startProject(projectId)
      // 落盘失败降级为日志：启动结果不受影响（旧实现 startProject 直接拒绝，
      // 子进程 detached 存活而监听未挂 → 永久 STARTING + 管道无人消费）
      expect(result.ok).toBe(true)
      expect(result.status).toBe('STARTING')
      expect(consoleErr).toHaveBeenCalled()

      // close 监听已挂：进程死亡仍能落终态（不是幽灵 STARTING）
      children[0]?.emitClose(0)
      expect(pm.getRuntimeState(projectId)?.status).toBe('STOPPED')
    } finally {
      upsertSpy.mockRestore()
      consoleErr.mockRestore()
    }
  })

  it('P2-3（phase4 审查）：落盘失败且无人消费管道 → stdout/stderr 被 resume 排空（防 Java 写满管道阻塞）', async () => {
    const { spawner, children } = makeSpawner()
    const { pm } = makeManager({ spawner })
    const upsertSpy = vi.spyOn(pm.registry, 'upsert').mockRejectedValue(new Error('EBUSY'))
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await pm.startProject(projectId)
      expect(result.ok).toBe(true)
      // 无人消费路径的排空兜底在 upsert 之前执行（旧实现失败时永远走不到）
      expect(children[0]?.stdout.readableFlowing).toBe(true)
      expect(children[0]?.stderr.readableFlowing).toBe(true)
    } finally {
      upsertSpy.mockRestore()
      consoleErr.mockRestore()
    }
  })
})

// ---------- 操作队列串行化 + 幂等四规则 ----------

describe('process-manager / 队列串行化与幂等', () => {
  it('并发 start×3 → 仅一次 spawn（队列串行 + STARTING 幂等）', async () => {
    const { spawner, calls } = makeSpawner()
    const { pm } = makeManager({ spawner })
    const results = await Promise.all([
      pm.startProject(projectId),
      pm.startProject(projectId),
      pm.startProject(projectId)
    ])
    expect(calls).toHaveLength(1)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.every((r) => r.pid === results[0]?.pid)).toBe(true)
    expect(pm.getRuntimeState(projectId)?.status).toBe('STARTING')
  })

  it('RUNNING 下 start → 幂等返回 {ok,pid,status:RUNNING}，绝不二次 spawn', async () => {
    const { spawner, calls } = makeSpawner()
    const { pm } = makeManager({ spawner })
    await pm.startProject(projectId)
    pm.markRunning(projectId)
    const pid = pm.getRuntimeState(projectId)?.pid
    const again = await pm.startProject(projectId)
    expect(again).toEqual({ ok: true, pid, status: 'RUNNING' })
    expect(calls).toHaveLength(1)
  })

  it('STARTING 下 start → 幂等返回 {ok,pid,status:STARTING}', async () => {
    const { spawner, calls } = makeSpawner()
    const { pm } = makeManager({ spawner })
    await pm.startProject(projectId)
    const again = await pm.startProject(projectId)
    expect(again.ok).toBe(true)
    expect(again.status).toBe('STARTING')
    expect(calls).toHaveLength(1)
  })

  it('STOPPED / ABNORMAL_EXIT 下 stop → 幂等 ok 且不调 taskkill', async () => {
    const { taskOps, killCalls } = makeTaskOps()
    const { spawner, children } = makeSpawner()
    const { pm } = makeManager({ spawner, taskOps })

    // 无任何运行记录
    expect(await pm.stopProject(projectId)).toEqual({ ok: true, durationMs: 0 })
    expect(killCalls).toHaveLength(0)

    // 启动后正常退出（close 0）
    await pm.startProject(projectId)
    children[0]?.emitClose(0)
    expect(pm.getRuntimeState(projectId)?.status).toBe('STOPPED')
    expect((await pm.stopProject(projectId)).ok).toBe(true)
    expect(killCalls).toHaveLength(0)

    // 异常退出态同样幂等
    await pm.startProject(projectId)
    children[1]?.emitClose(1)
    expect(pm.getRuntimeState(projectId)?.status).toBe('ABNORMAL_EXIT')
    expect((await pm.stopProject(projectId)).ok).toBe(true)
    expect(killCalls).toHaveLength(0)
  })

  it('STARTING/RUNNING 下 stop → 真实 taskkill 且落 STOPPED（非 ABNORMAL）', async () => {
    const { taskOps, killCalls } = makeTaskOps()
    const { spawner, children } = makeSpawner()
    const { pm } = makeManager({ spawner, taskOps })
    await pm.startProject(projectId)
    pm.markRunning(projectId)

    const stopResult = await pm.stopProject(projectId)
    expect(stopResult.ok).toBe(true)
    expect(killCalls).toHaveLength(1)

    const state = pm.getRuntimeState(projectId)
    expect(state?.status).toBe('STOPPED')

    // stop 后 close(1) 迟到：stopping 标记下不得翻转为 ABNORMAL_EXIT
    children[0]?.emitClose(1)
    expect(pm.getRuntimeState(projectId)?.status).toBe('STOPPED')
  })

  it('stop 排队在 start 之后（同项目串行），kill 慢时不交错', async () => {
    const { taskOps } = makeTaskOps({ killDelayMs: 60 })
    const { spawner, calls, children } = makeSpawner()
    const { pm } = makeManager({ spawner, taskOps })
    const startPromise = pm.startProject(projectId)
    const stopPromise = pm.stopProject(projectId)
    await Promise.all([startPromise, stopPromise])
    // start 先入队先执行（spawn 1 次），stop 等其完成再杀 → 最终 STOPPED
    expect(calls).toHaveLength(1)
    expect(pm.getRuntimeState(projectId)?.status).toBe('STOPPED')
    children[0]?.emitClose(1)
    expect(pm.getRuntimeState(projectId)?.status).toBe('STOPPED')
  })
})

// ---------- restart 原子组合（N-4） ----------

describe('process-manager / restart', () => {
  it('持锁直调不自等：stop→start 原子完成，返回新 pid（10s 超时守护防死锁挂起）', async () => {
    const { taskOps, killCalls } = makeTaskOps({ killDelayMs: 30 })
    const { spawner, calls, children } = makeSpawner()
    const { pm } = makeManager({ spawner, taskOps })
    await pm.startProject(projectId)
    pm.markRunning(projectId)
    const oldPid = pm.getRuntimeState(projectId)?.pid

    const restart = await Promise.race([
      pm.restartProject(projectId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('restart 死锁：队列自等')), 10_000)
      )
    ])

    expect(restart.ok).toBe(true)
    expect(restart.pid).not.toBe(oldPid)
    expect(calls).toHaveLength(2) // 初始 start + restart 内部 start（各一次）
    expect(killCalls).toHaveLength(1) // restart 内部 stop（一次）
    expect(pm.getRuntimeState(projectId)?.status).toBe('STARTING')
  })

  it('并发 restart + stop：队列化为确定顺序（restart 完成后 stop 生效），终态 STOPPED', async () => {
    const { taskOps } = makeTaskOps()
    const { spawner } = makeSpawner()
    const { pm } = makeManager({ spawner, taskOps })
    await pm.startProject(projectId)
    pm.markRunning(projectId)

    const [restartResult, stopResult] = await Promise.all([
      pm.restartProject(projectId),
      pm.stopProject(projectId)
    ])
    expect(restartResult.ok).toBe(true)
    expect(stopResult.ok).toBe(true)
    // restart 先入队：先拉起新进程；stop 后入队：等 restart 完整结束后杀掉新进程
    expect(pm.getRuntimeState(projectId)?.status).toBe('STOPPED')
  })

  it('restart 内 stop 失败 → 不再 start，返回 stop 错误', async () => {
    const failingOps: TaskOps = {
      probeAlive() {
        return true
      },
      async isAlive() {
        return { alive: true, image: 'java' }
      },
      async batchQueryProcesses() {
        return new Map()
      },
      async killTree() {
        return { ok: false, durationMs: 8_000, error: '进程树终止超时（8000ms）' }
      }
    }
    const { spawner, calls } = makeSpawner()
    const { pm } = makeManager({ spawner, taskOps: failingOps })
    await pm.startProject(projectId)
    pm.markRunning(projectId)
    const result = await pm.restartProject(projectId)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/进程树终止超时/)
    expect(calls).toHaveLength(1) // 未二次 spawn
    expect(pm.getRuntimeState(projectId)?.status).toBe('RUNNING') // 原进程仍在
  })

  it('WMI 病态降级：killTree 返回 degraded → restart 的 stop 段同样受益并透传 note', async () => {
    const degradedOps: TaskOps = {
      probeAlive() {
        return false
      },
      async isAlive() {
        return { alive: false }
      },
      async batchQueryProcesses() {
        return new Map()
      },
      async killTree(pid) {
        return {
          ok: true,
          durationMs: 2_214,
          degraded: true,
          degradedReason: `WMI 子进程枚举不可用，仅终止主进程（pid=${pid}）`
        }
      }
    }
    const { spawner, calls } = makeSpawner()
    const { pm } = makeManager({ spawner, taskOps: degradedOps })
    await pm.startProject(projectId)
    pm.markRunning(projectId)
    const result = await pm.restartProject(projectId)
    // stop 段 degraded 不构成失败：start 照常执行，note 透传
    expect(result.ok).toBe(true)
    expect(result.note).toMatch(/仅终止主进程/)
    expect(calls).toHaveLength(2)
    expect(pm.getRuntimeState(projectId)?.status).toBe('STARTING')
  })
})

// ---------- 状态机 ----------

describe('process-manager / 状态机', () => {
  it('正常退出 close(0) → STOPPED；异常退出 close(3) → ABNORMAL_EXIT + 退出码', async () => {
    const { spawner, children } = makeSpawner()
    const { pm, events } = makeManager({ spawner })

    await pm.startProject(projectId)
    pm.markRunning(projectId)
    children[0]?.emitClose(0)
    expect(pm.getRuntimeState(projectId)).toMatchObject({ status: 'STOPPED' })

    await pm.startProject(projectId)
    pm.markRunning(projectId)
    children[1]?.emitClose(3)
    const abnormal = pm.getRuntimeState(projectId)
    expect(abnormal?.status).toBe('ABNORMAL_EXIT')
    expect(abnormal?.exitCode).toBe(3)

    // 广播事件含退出码
    const last = events[events.length - 1]
    expect(last).toMatchObject({ projectId, status: 'ABNORMAL_EXIT', exitCode: 3 })
  })

  it('STARTING 被外部杀死（close 1 且非 stop 发起）→ ABNORMAL_EXIT', async () => {
    const { spawner, children } = makeSpawner()
    const { pm } = makeManager({ spawner })
    await pm.startProject(projectId)
    children[0]?.emitClose(1)
    expect(pm.getRuntimeState(projectId)?.status).toBe('ABNORMAL_EXIT')
  })

  it('grace 兜底：无输出存活满 startupGraceSeconds → RUNNING', async () => {
    await store.setSettings({ startupGraceSeconds: 0.05 }) // 50ms
    const { spawner } = makeSpawner()
    const { pm, events } = makeManager({ spawner })
    await pm.startProject(projectId)
    expect(pm.getRuntimeState(projectId)?.status).toBe('STARTING')
    await new Promise((r) => setTimeout(r, 180))
    expect(pm.getRuntimeState(projectId)?.status).toBe('RUNNING')
    expect(events.some((e) => e.status === 'RUNNING')).toBe(true)
  })

  it('markRunning 先到即转：立即 RUNNING，grace 定时器被取消', async () => {
    const { spawner } = makeSpawner()
    const { pm } = makeManager({ spawner })
    await pm.startProject(projectId)
    pm.markRunning(projectId)
    expect(pm.getRuntimeState(projectId)?.status).toBe('RUNNING')
    // grace=60s 不应再翻转（已是 RUNNING，markRunning 幂等无害）
    pm.markRunning(projectId)
    expect(pm.getRuntimeState(projectId)?.status).toBe('RUNNING')
  })

  it('grace 计时中 stop → 落 STOPPED 且兜底定时器不再触发', async () => {
    await store.setSettings({ startupGraceSeconds: 0.05 })
    const { taskOps } = makeTaskOps()
    const { spawner } = makeSpawner()
    const { pm } = makeManager({ spawner, taskOps })
    await pm.startProject(projectId)
    await pm.stopProject(projectId)
    await new Promise((r) => setTimeout(r, 120))
    expect(pm.getRuntimeState(projectId)?.status).toBe('STOPPED')
  })
})

// ---------- 批量 ----------

describe('process-manager / startAll / stopAll', () => {
  it('每项目只入队一次、错峰、单项失败不中断', async () => {
    const other = await store.createProject({
      name: 'BrokenJar',
      jarPath: path.join(baseDir, 'missing.jar'),
      jdkId: 'jdk-test',
      jvmArgs: [],
      programArgs: [],
      envVars: {}
    })
    const third = await store.createProject({
      name: 'Third',
      jarPath,
      jdkId: 'jdk-test',
      jvmArgs: [],
      programArgs: [],
      envVars: {}
    })
    const { spawner, calls } = makeSpawner()
    const { taskOps } = makeTaskOps()
    const { pm } = makeManager({ spawner, taskOps })

    const batch = await pm.startAllProjects()
    expect(batch.results).toHaveLength(3)
    const byId = new Map(batch.results.map((r) => [r.id, r]))
    expect(byId.get(projectId)?.ok).toBe(true)
    expect(byId.get(other.id)?.ok).toBe(false) // jar 缺失单项失败
    expect(byId.get(third.id)?.ok).toBe(true) // 不中断后续
    expect(calls).toHaveLength(2)

    const stopBatch = await pm.stopAllProjects()
    expect(stopBatch.results.every((r) => r.ok)).toBe(true)
    expect(pm.getRuntimeState(projectId)?.status).toBe('STOPPED')
    expect(pm.getRuntimeState(third.id)?.status).toBe('STOPPED')
  })
})

// ---------- 查询与广播同源 ----------

describe('process-manager / 查询', () => {
  it('listRuntimeStates 供 IPC 与 MCP 同源；uptimeMs 仅 RUNNING 派生', async () => {
    const { spawner } = makeSpawner()
    const { pm } = makeManager({ spawner })
    await pm.startProject(projectId)
    pm.markRunning(projectId)

    const states = pm.listRuntimeStates()
    expect(states).toHaveLength(1)
    expect(states[0]?.projectId).toBe(projectId)
    expect(states[0]?.status).toBe('RUNNING')
    expect(typeof states[0]?.uptimeMs).toBe('number')
  })

  it('广播事件流与状态同源：STARTING→RUNNING 全量推送 proc:statusChanged', async () => {
    const { spawner } = makeSpawner()
    const { pm, events } = makeManager({ spawner })
    await pm.startProject(projectId)
    pm.markRunning(projectId)
    expect(events.map((e) => e.status)).toEqual(['STARTING', 'RUNNING'])
    expect(events.every((e) => e.projectId === projectId)).toBe(true)
  })
})

// ---------- 退出策略钩子 ----------

describe('process-manager / killAllForExit（lifecycle stopAll）', () => {
  it('并行杀全部运行项目并落 STOPPED，runs 记录出清', async () => {
    const { taskOps, killCalls } = makeTaskOps()
    const { spawner } = makeSpawner()
    const { pm } = makeManager({ spawner, taskOps })
    await pm.startProject(projectId)
    await pm.killAllForExit()
    expect(killCalls).toHaveLength(1)
    expect(pm.getRuntimeState(projectId)?.status).toBe('STOPPED')
    await pm.prepareForExit()
  })
})
