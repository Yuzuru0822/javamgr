import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PidRegistry } from '../../src/main/process/pid-registry'
import type { ProcessSnapshot, TaskOps } from '../../src/main/process/task-killer'

/**
 * pid-registry 单测：TaskOps 全 mock（含 kill0 初筛与批量 Get-Process）。
 * 覆盖：runs.json 落盘/加载/损坏容忍；reidentify 分类（存活/已死/PID 重用/查询超时保守）；
 * 轮询池每轮 0–1 次 spawn（WMI 病态适配：超时跳过不误判死亡）、死亡回调与出池、
 * 信号矛盾（kill0 活 + 查询无）保守留池、空池不 spawn。
 */

let baseDir: string
let runsFile: string

const makeRecord = (projectId: string, pid: number, startTime = Date.now()) => ({
  projectId,
  pid,
  startTime,
  logSource: 'stdout' as const,
  runId: `run-${projectId}`
})

/** 按场景配置 kill0 初筛结果 / 批量 Get-Process 结果（null = 查询超时） */
function makeTaskOps(setup: {
  kill0Alive?: Set<number>
  batch?: Map<number, ProcessSnapshot> | null
  batchTimeout?: boolean
}): { taskOps: TaskOps; spawns: { file: string; args: string[] }[] } {
  const spawns: { file: string; args: string[] }[] = []
  const taskOps: TaskOps = {
    probeAlive(pid) {
      return setup.kill0Alive?.has(pid) === true
    },
    async isAlive(pid) {
      spawns.push({ file: 'powershell', args: ['Get-Process', String(pid)] })
      const info = setup.batch?.get(pid)
      if (info === undefined) return { alive: false }
      return { alive: info.name.startsWith('java'), image: info.name }
    },
    async batchQueryProcesses(pids) {
      spawns.push({ file: 'powershell', args: ['Get-Process', ...pids.map(String)] })
      if (setup.batchTimeout || setup.batch === null) return null
      return new Map(
        [...(setup.batch ?? new Map())].filter(([pid]) => pids.includes(pid))
      )
    },
    async killTree(pid) {
      spawns.push({ file: 'powershell', args: ['Stop-Process', String(pid)] })
      return { ok: true, durationMs: 1 }
    }
  }
  return { taskOps, spawns }
}

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-pidreg-'))
  runsFile = path.join(baseDir, 'runs.json')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('pid-registry / 持久化', () => {
  it('upsert 变更即写盘；load 读回', async () => {
    const { taskOps } = makeTaskOps({})
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: () => {},
      getIntervalSeconds: () => 5
    })
    await reg.upsert(makeRecord('p1', 111))
    await reg.upsert(makeRecord('p2', 222))
    const onDisk = JSON.parse(await readFile(runsFile, 'utf8')) as unknown[]
    expect(onDisk).toHaveLength(2)
    const loaded = await reg.load()
    expect(loaded.map((r) => r.projectId).sort()).toEqual(['p1', 'p2'])
  })

  it('remove 出清条目；损坏文件 load 返回空不抛错', async () => {
    const { taskOps } = makeTaskOps({})
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: () => {},
      getIntervalSeconds: () => 5
    })
    await reg.upsert(makeRecord('p1', 111))
    await reg.remove('p1')
    expect((await reg.load())).toHaveLength(0)

    await writeFile(runsFile, '{corrupted!!!', 'utf8')
    const reg2 = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: () => {},
      getIntervalSeconds: () => 5
    })
    await expect(reg2.load()).resolves.toEqual([])
  })
})

describe('pid-registry / reidentify（kill0 初筛 + 一次批量 Get-Process）', () => {
  it('kill0 活 + java 镜像 + StartTime 一致 → alive=true 并入池；kill0 死 → exited（零查询初筛）', async () => {
    const startTime = Date.now()
    const { taskOps, spawns } = makeTaskOps({
      kill0Alive: new Set([111, 333]),
      batch: new Map([
        [111, { name: 'java', startTime }],
        [333, { name: 'notepad', startTime }]
      ])
    })
    await writeFile(
      runsFile,
      JSON.stringify([
        makeRecord('p1', 111, startTime),
        makeRecord('p2', 222, startTime),
        makeRecord('p3', 333, startTime)
      ]),
      'utf8'
    )
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: () => {},
      getIntervalSeconds: () => 5
    })
    const results = await reg.reidentify()

    const byId = new Map(results.map((r) => [r.record.projectId, r]))
    expect(byId.get('p1')?.alive).toBe(true)
    expect(byId.get('p2')?.alive).toBe(false)
    expect(byId.get('p2')?.reason).toBe('exited')
    // 333 存在但被 notepad 占用 → PID 重用判死（非 java 镜像）
    expect(byId.get('p3')?.alive).toBe(false)
    expect(byId.get('p3')?.reason).toBe('pid-reused')

    expect(reg.isInPool('p1')).toBe(true)
    expect(reg.poolSize()).toBe(1)

    // 初筛零 spawn：仅存活者（111、333）一次批量 Get-Process（1 次 spawn）
    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.args).toContain('111')
    expect(spawns[0]?.args).toContain('333')
  })

  it('StartTime 比对不一致（PID 重用）→ 判死（N-3）', async () => {
    const startTime = Date.now() - 60_000
    const { taskOps } = makeTaskOps({
      kill0Alive: new Set([111]),
      batch: new Map([[111, { name: 'java', startTime: Date.now() }]]) // 新进程占用同 PID
    })
    await writeFile(runsFile, JSON.stringify([makeRecord('p1', 111, startTime)]), 'utf8')
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: () => {},
      getIntervalSeconds: () => 5
    })
    const results = await reg.reidentify()
    expect(results[0]?.alive).toBe(false)
    expect(results[0]?.reason).toBe('pid-reused')
    expect(reg.poolSize()).toBe(0)
  })

  it('StartTime 不可访问（受保护进程）→ 不构成存活结论，判 PID 重用', async () => {
    const startTime = Date.now()
    const { taskOps } = makeTaskOps({
      kill0Alive: new Set([111]),
      batch: new Map([[111, { name: 'java' }]]) // 无 startTime
    })
    await writeFile(runsFile, JSON.stringify([makeRecord('p1', 111, startTime)]), 'utf8')
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: () => {},
      getIntervalSeconds: () => 5
    })
    const results = await reg.reidentify()
    expect(results[0]?.alive).toBe(false)
    expect(results[0]?.reason).toBe('pid-reused')
  })

  it('±3s 容差内视为同一进程', async () => {
    const startTime = Date.now()
    const { taskOps } = makeTaskOps({
      kill0Alive: new Set([111]),
      batch: new Map([[111, { name: 'java', startTime: startTime + 2_500 }]])
    })
    await writeFile(runsFile, JSON.stringify([makeRecord('p1', 111, startTime)]), 'utf8')
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: () => {},
      getIntervalSeconds: () => 5
    })
    const results = await reg.reidentify()
    expect(results[0]?.alive).toBe(true)
  })

  it('批量查询超时（WMI/PowerShell 病态）→ 保守按存活入池，不误判死亡', async () => {
    const startTime = Date.now()
    const { taskOps } = makeTaskOps({
      kill0Alive: new Set([111]),
      batchTimeout: true
    })
    await writeFile(runsFile, JSON.stringify([makeRecord('p1', 111, startTime)]), 'utf8')
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: () => {},
      getIntervalSeconds: () => 5
    })
    const results = await reg.reidentify()
    expect(results[0]?.alive).toBe(true)
    expect(reg.poolSize()).toBe(1) // 入池，由轮询池下轮纠正
  })
})

describe('pid-registry / 轮询池（每轮 spawn 0–1 次）', () => {
  it('存活者一次批量 Get-Process：java+StartTime 一致 → 留池；仅 1 次 spawn', async () => {
    const startTime = Date.now()
    const { taskOps, spawns } = makeTaskOps({
      kill0Alive: new Set([111, 222]),
      batch: new Map([
        [111, { name: 'java', startTime }],
        [222, { name: 'javaw', startTime }]
      ])
    })
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: () => {},
      getIntervalSeconds: () => 5
    })
    await reg.upsert(makeRecord('p1', 111, startTime))
    await reg.upsert(makeRecord('p2', 222, startTime))
    reg.addToPool(makeRecord('p1', 111, startTime))
    reg.addToPool(makeRecord('p2', 222, startTime))

    spawns.length = 0
    await reg.pollOnce()
    expect(spawns).toHaveLength(1) // 恰好 1 次（批量 Get-Process）
    expect(spawns[0]?.file).toBe('powershell')
    expect(reg.poolSize()).toBe(2)
  })

  it('批量查询超时 → 本轮记未验证跳过：不误判死亡、不出池（WMI 病态专项）', async () => {
    const startTime = Date.now()
    const deaths: Array<{ id: string; reason: string }> = []
    const { taskOps, spawns } = makeTaskOps({
      kill0Alive: new Set([111]), // kill0 说活着
      batchTimeout: true // 但批量查询挂死超时
    })
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: (id, reason) => deaths.push({ id, reason }),
      getIntervalSeconds: () => 5
    })
    await reg.upsert(makeRecord('p1', 111, startTime))
    reg.addToPool(makeRecord('p1', 111, startTime))

    await reg.pollOnce()
    expect(deaths).toEqual([]) // 绝不误判死亡
    expect(reg.poolSize()).toBe(1) // 留池待下轮
    expect(await reg.getRecord('p1')).toBeDefined() // runs.json 记录保留
    expect(spawns).toHaveLength(1) // 只 1 次尝试，不堆积
  })

  it('kill0 死 + 查询无此 pid → 判死 exited + onDeath + 出池（真实死亡路径）', async () => {
    const startTime = Date.now()
    const deaths: Array<{ id: string; reason: string }> = []
    const { taskOps, spawns } = makeTaskOps({
      kill0Alive: new Set(), // kill0：不存在
      batch: new Map() // 复核：也查无
    })
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: (id, reason) => deaths.push({ id, reason }),
      getIntervalSeconds: () => 5
    })
    await reg.upsert(makeRecord('p1', 111, startTime))
    reg.addToPool(makeRecord('p1', 111, startTime))

    spawns.length = 0
    await reg.pollOnce()
    expect(deaths).toEqual([{ id: 'p1', reason: 'exited' }])
    expect(reg.poolSize()).toBe(0)
    expect(await reg.getRecord('p1')).toBeUndefined() // runs.json 出清
    expect(spawns).toHaveLength(1) // 初筛死亡者仍进批量复核（1 次调用）
  })

  it('kill0 活 + 查询无此 pid（信号矛盾）→ 保守留池本轮不判死', async () => {
    const startTime = Date.now()
    const deaths: Array<{ id: string; reason: string }> = []
    const { taskOps } = makeTaskOps({
      kill0Alive: new Set([111]),
      batch: new Map()
    })
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: (id, reason) => deaths.push({ id, reason }),
      getIntervalSeconds: () => 5
    })
    await reg.upsert(makeRecord('p1', 111, startTime))
    reg.addToPool(makeRecord('p1', 111, startTime))

    await reg.pollOnce()
    expect(deaths).toEqual([])
    expect(reg.poolSize()).toBe(1)
  })

  it('初筛存活但 StartTime 不一致（PID 重用）→ 判死 + onDeath(pid-reused) + 出池', async () => {
    const startTime = Date.now() - 60_000
    const deaths: Array<{ id: string; reason: string }> = []
    const { taskOps } = makeTaskOps({
      kill0Alive: new Set([111]),
      batch: new Map([[111, { name: 'java', startTime: Date.now() }]]) // 新进程占用同 PID
    })
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: (id, reason) => deaths.push({ id, reason }),
      getIntervalSeconds: () => 5
    })
    await reg.upsert(makeRecord('p1', 111, startTime))
    reg.addToPool(makeRecord('p1', 111, startTime))

    await reg.pollOnce()
    expect(deaths).toEqual([{ id: 'p1', reason: 'pid-reused' }])
    expect(reg.poolSize()).toBe(0)
    expect(await reg.getRecord('p1')).toBeUndefined()
  })

  it('java 镜像但被非 java 进程占 pid → pid-reused', async () => {
    const startTime = Date.now()
    const deaths: Array<{ id: string; reason: string }> = []
    const { taskOps } = makeTaskOps({
      kill0Alive: new Set([111]),
      batch: new Map([[111, { name: 'notepad', startTime }]])
    })
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: (id, reason) => deaths.push({ id, reason }),
      getIntervalSeconds: () => 5
    })
    await reg.upsert(makeRecord('p1', 111, startTime))
    reg.addToPool(makeRecord('p1', 111, startTime))

    await reg.pollOnce()
    expect(deaths).toEqual([{ id: 'p1', reason: 'pid-reused' }])
  })

  it('空池不 spawn', async () => {
    const { taskOps, spawns } = makeTaskOps({})
    const reg = new PidRegistry({
      runsFile,
      taskOps,
      onDeath: () => {},
      getIntervalSeconds: () => 5
    })
    await reg.pollOnce()
    expect(spawns).toHaveLength(0)
  })

  it('startPolling 按设置的间隔周而复始；stopPolling 停止', async () => {
    vi.useFakeTimers()
    try {
      const startTime = Date.now()
      const setup = {
        kill0Alive: new Set([111]),
        batch: new Map([[111, { name: 'java', startTime }]])
      }
      const { taskOps, spawns } = makeTaskOps(setup)
      const reg = new PidRegistry({
        runsFile,
        taskOps,
        onDeath: () => {},
        getIntervalSeconds: () => 5,
        sleep: async () => {}
      })
      await reg.upsert(makeRecord('p1', 111, startTime))
      reg.addToPool(makeRecord('p1', 111, startTime))

      spawns.length = 0
      reg.startPolling()
      await vi.advanceTimersByTimeAsync(10) // 首轮立即执行
      expect(spawns).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(5_000) // 第二轮
      expect(spawns).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(3_000) // 间隔未满
      expect(spawns).toHaveLength(2)

      reg.stopPolling()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(spawns).toHaveLength(2) // 停止后不再轮询
    } finally {
      vi.useRealTimers()
    }
  })

  it('P2-2（phase4 审查）：轮询中 save 落盘失败 → catch 兜底，不产生 unhandledRejection 且轮询继续', async () => {
    // runsFile 指向已存在目录：writeFile(tmp) 成功但 rename(tmp, 目录) 必失败
    // （Windows EPERM 类，重试 3 次后仍失败）→ pollOnce 的 save 拒绝
    const runsFileAsDir = path.join(baseDir, 'runs-as-dir')
    await mkdir(runsFileAsDir)

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})

    const startTime = Date.now()
    // p1 kill0 死 + 查询无 → 死亡触发 save（拒绝路径）；p2 存活使轮询持续
    const { taskOps, spawns } = makeTaskOps({
      kill0Alive: new Set([222]),
      batch: new Map([[222, { name: 'java', startTime }]])
    })
    const deaths: Array<{ id: string; reason: string }> = []
    const reg = new PidRegistry({
      runsFile: runsFileAsDir,
      taskOps,
      onDeath: (id, reason) => deaths.push({ id, reason }),
      getIntervalSeconds: () => 0.001 // Math.max(1, 1ms)：快速多轮观察"失败后继续"
      // 注意：save 内部 rename 重试 sleep 用真实实现（构造缺省），不注入
    })

    // upsert 落盘失败（目录占位），但内存 records 已写入（set 先于 save）
    await expect(reg.upsert(makeRecord('p1', 111, startTime))).rejects.toThrow()
    reg.addToPool(makeRecord('p1', 111, startTime))
    reg.addToPool(makeRecord('p2', 222, startTime))

    try {
      reg.startPolling()
      // 等待：死亡回调触发（save 拒绝路径已走到）+ 后续轮询持续 spawn（失败未终止监控）
      const deadline = Date.now() + 8_000
      for (;;) {
        const polls = spawns.length
        if (deaths.length >= 1 && polls >= 5) break
        if (Date.now() > deadline) throw new Error('等待超时：死亡回调/轮询续行未达成')
        await new Promise((r) => setTimeout(r, 30))
      }
      expect(deaths).toEqual([{ id: 'p1', reason: 'exited' }])
      // 落盘失败被 catch 兜底（降级日志）而非中断轮询
      expect(consoleErr).toHaveBeenCalled()
      // 给潜在 unhandledRejection 事件留出发射窗口
      await new Promise((r) => setTimeout(r, 120))
      expect(unhandled).toEqual([])
    } finally {
      reg.stopPolling()
      await new Promise((r) => setTimeout(r, 50))
      process.off('unhandledRejection', onUnhandled)
      consoleErr.mockRestore()
    }
  })
})
