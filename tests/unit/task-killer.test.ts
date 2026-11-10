import { describe, expect, it, vi } from 'vitest'
import {
  createTaskOps,
  isJavaImage,
  matchesJavaName,
  probeAlive,
  PS_KILL_HARD_CAP_MS
} from '../../src/main/process/task-killer'
import type { CommandRunner, RunResult } from '../../src/main/process/task-killer'

/**
 * task-killer 单测：mock CommandRunner + 注入 probe/sleep（真实进程行为在
 * tests/integration 验证，含 WMI 病态宿主活体降级）。
 * 覆盖：kill0 三态、Get-Process 行协议解析（含 StartTime 防重用）、java* 名称匹配、
 * killTree 主引擎（CIM 枚举全树灭）/降级（外层超时→单杀主进程 degraded）/脚本参数
 * 拼装/确认轮询/补杀/超时报错。
 */

function fakeRunner(handler: (file: string, args: string[]) => Partial<RunResult>): {
  runner: CommandRunner
  run: ReturnType<typeof vi.fn>
} {
  const run = vi.fn(async (file: string, args: string[]): Promise<RunResult> => ({
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...handler(file, args)
  }))
  return { runner: { run }, run }
}

const noSleep = (): Promise<void> => Promise.resolve()

describe('task-killer / 名称匹配', () => {
  it('Get-Process ProcessName（无 .exe）与 tasklist 镜像名（带 .exe）都按 java* 匹配', () => {
    expect(matchesJavaName('java')).toBe(true)
    expect(matchesJavaName('javaw')).toBe(true)
    expect(matchesJavaName('java.exe')).toBe(true)
    expect(matchesJavaName('javaw.exe')).toBe(true)
    expect(matchesJavaName('JAVA.EXE')).toBe(true)
    expect(matchesJavaName('notepad')).toBe(false)
    expect(matchesJavaName('notepad.exe')).toBe(false)
    // isJavaImage 历史别名行为不变
    expect(isJavaImage('java.exe')).toBe(true)
    expect(isJavaImage('notepad.exe')).toBe(false)
  })
})

describe('task-killer / probeAlive（process.kill(pid,0) 三态）', () => {
  it('存在（自身）→ true；不存在（ESRCH）→ false；非法 pid → false', () => {
    expect(probeAlive(process.pid)).toBe(true)
    expect(probeAlive(999_999)).toBe(false)
    expect(probeAlive(0)).toBe(false)
    expect(probeAlive(-1)).toBe(false)
    expect(probeAlive(1.5)).toBe(false)
  })

  it('EPERM（存在但无权限）→ 视为存活：非 ESRCH 错误码映射 true', () => {
    // 直接验证映射分支：模拟 process.kill 抛 EPERM
    const orig = process.kill
    const fake = vi.fn(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process as any).kill = fake
    try {
      expect(probeAlive(4)).toBe(true) // System 进程：无权限但存在
    } finally {
      process.kill = orig
    }
  })
})

describe('task-killer / isAlive（kill0 初筛 + 按需 Get-Process 名称校验）', () => {
  it('kill0 死 → {alive:false}，零 spawn', async () => {
    const { runner, run } = fakeRunner(() => ({ stdout: '999999|java|...\r\n' }))
    const ops = createTaskOps(runner, { probe: () => false, sleep: noSleep })
    const info = await ops.isAlive(999_999)
    expect(info.alive).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('kill0 活且不要求镜像名 → {alive:true}，零 spawn', async () => {
    const { runner, run } = fakeRunner(() => ({}))
    const ops = createTaskOps(runner, { probe: () => true, sleep: noSleep })
    expect(await ops.isAlive(1234)).toEqual({ alive: true })
    expect(run).not.toHaveBeenCalled()
  })

  it('requireJavaImage：Get-Process 返回 ProcessName（无 .exe）→ java 命中 / 非 java 判死', async () => {
    const { runner, run } = fakeRunner(() => ({ stdout: '1234|java|\r\n' }))
    const ops = createTaskOps(runner, { probe: () => true, sleep: noSleep })
    expect(await ops.isAlive(1234, { requireJavaImage: true })).toEqual({
      alive: true,
      image: 'java'
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toBe('powershell')
    expect(String(run.mock.calls[0]?.[1]?.join(' '))).toContain('Get-Process -Id 1234')

    const { runner: r2 } = fakeRunner(() => ({ stdout: '1234|notepad|\r\n' }))
    const ops2 = createTaskOps(r2, { probe: () => true, sleep: noSleep })
    expect(await ops2.isAlive(1234, { requireJavaImage: true })).toEqual({
      alive: false,
      image: 'notepad'
    })
  })

  it('requireJavaImage + 查询超时 → 保守存活（存在已由 kill0 确认，名称未验证不误判）', async () => {
    const { runner } = fakeRunner(() => ({ timedOut: true, code: null }))
    const ops = createTaskOps(runner, { probe: () => true, sleep: noSleep })
    expect((await ops.isAlive(1234, { requireJavaImage: true })).alive).toBe(true)
  })

  it('requireJavaImage + 查询无此 pid（kill0 与查询间死亡竞态）→ 判死', async () => {
    const { runner } = fakeRunner(() => ({ stdout: '' }))
    const ops = createTaskOps(runner, { probe: () => true, sleep: noSleep })
    expect((await ops.isAlive(1234, { requireJavaImage: true })).alive).toBe(false)
  })
})

describe('task-killer / batchQueryProcesses（一次 Get-Process：名称+StartTime）', () => {
  it('解析 pid|name|iso 行为 Map（含 StartTime epoch ms，本地时区 ISO 可解析）', async () => {
    const iso = '2026-11-09T12:34:56.1234567+08:00'
    const { runner, run } = fakeRunner(() => ({
      stdout: `1234|java|${iso}\r\n5678|javaw|\r\n`
    }))
    const ops = createTaskOps(runner, { probe: () => true, sleep: noSleep })
    const map = await ops.batchQueryProcesses([1234, 5678])
    expect(map?.get(1234)).toEqual({ name: 'java', startTime: Date.parse(iso) })
    expect(map?.get(5678)).toEqual({ name: 'javaw' }) // StartTime 不可访问 → 缺省
    expect(run).toHaveBeenCalledTimes(1)
    const command = run.mock.calls[0]
    expect(command?.[0]).toBe('powershell')
    expect(command?.[1]?.[0]).toBe('-NoProfile')
    expect(String(command?.[1]?.join(' '))).toContain('Get-Process -Id 1234,5678')
    expect(String(command?.[1]?.join(' '))).toContain("StartTime.ToString('o')")
    expect(String(command?.[1]?.join(' '))).toContain('SilentlyContinue')
  })

  it('空列表不 spawn → 空 Map', async () => {
    const { runner, run } = fakeRunner(() => ({}))
    const ops = createTaskOps(runner, { probe: () => true, sleep: noSleep })
    expect(await ops.batchQueryProcesses([])).toEqual(new Map())
    expect(run).not.toHaveBeenCalled()
  })

  it('查询超时 → null（未验证；调用方不得据此判死——病态期核心语义）', async () => {
    const { runner } = fakeRunner(() => ({ timedOut: true, code: null }))
    const ops = createTaskOps(runner, { probe: () => true, sleep: noSleep })
    expect(await ops.batchQueryProcesses([1234])).toBeNull()
  })

  it('坏行跳过（不崩溃），重复 pid 去重后单次查询', async () => {
    const { runner, run } = fakeRunner(() => ({
      stdout: 'garbage\r\n|123|oops\r\n4321|java|2026-11-09T00:00:00.0000000+08:00\r\n'
    }))
    const ops = createTaskOps(runner, { probe: () => true, sleep: noSleep })
    const map = await ops.batchQueryProcesses([4321, 4321])
    expect(map?.size).toBe(1)
    expect(map?.get(4321)?.startTime).toBe(Date.parse('2026-11-09T00:00:00.0000000+08:00'))
    expect(String(run.mock.calls[0]?.[1]?.join(' '))).toContain('Get-Process -Id 4321')
  })
})

describe('task-killer / killTree 主引擎', () => {
  it('健康路径：WALK=OK + MAIN=OK + kill0 确认死亡 → ok 且非 degraded，单次 spawn', async () => {
    const { runner, run } = fakeRunner(() => ({
      stdout: 'WALK=OK\r\nTREE=4242,4243,4244\r\nMAIN=OK\r\n'
    }))
    const ops = createTaskOps(runner, { probe: () => false, sleep: noSleep })
    const result = await ops.killTree(4242, 8_000)
    expect(result.ok).toBe(true)
    expect(result.degraded).toBeUndefined()
    expect(result.error).toBeUndefined()
    expect(run).toHaveBeenCalledTimes(1) // 枚举+批量杀合并为单次调用
    const script = String(run.mock.calls[0]?.[1]?.at(-1))
    expect(script).toContain('Get-CimInstance Win32_Process')
    expect(script).toContain('-OperationTimeoutSec 1') // CIM 内层超时（不靠外层 race）
    expect(script).toContain('Stop-Process')
    expect(script).toContain('$main = 4242')
    expect(run.mock.calls[0]?.[2]).toBe(PS_KILL_HARD_CAP_MS) // 外层硬超时 3s
  })

  it('CIM 枚举失败（WALK=DEGRADED）但主进程已杀 → ok + degraded:true + 说明', async () => {
    const { runner } = fakeRunner(() => ({
      stdout: 'WALK=DEGRADED\r\nTREE=4242\r\nMAIN=OK\r\n'
    }))
    const ops = createTaskOps(runner, { probe: () => false, sleep: noSleep })
    const result = await ops.killTree(4242, 8_000)
    expect(result.ok).toBe(true)
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toMatch(/WMI 子进程枚举不可用/)
  })

  it('外层超时 → 杀助手并降级：第二次调用只 Stop-Process 主 pid（无 CIM），带 degraded', async () => {
    let call = 0
    const { runner, run } = fakeRunner(() => {
      call += 1
      if (call === 1) return { timedOut: true, code: null }
      return { stdout: 'MAIN=OK\r\n' }
    })
    const ops = createTaskOps(runner, { probe: () => false, sleep: noSleep })
    const result = await ops.killTree(4242, 8_000)
    expect(result.ok).toBe(true)
    expect(result.degraded).toBe(true)
    expect(result.degradedReason).toMatch(/仅终止主进程/)
    expect(run).toHaveBeenCalledTimes(2)
    const degradedScript = String(run.mock.calls[1]?.[1]?.at(-1))
    expect(degradedScript).toContain('Stop-Process -Id $main -Force')
    expect(degradedScript).not.toContain('Get-CimInstance')
    expect(run.mock.calls[1]?.[2]).toBeLessThanOrEqual(2_000) // 降级调用 2s 超时
  })

  it('外层超时 + 降级调用也超时 + 确认仍活（补杀也超时）→ ok:false 含错误', async () => {
    const { runner } = fakeRunner(() => ({ timedOut: true, code: null }))
    let confirmedDead = false
    let probeCalls = 0
    const ops = createTaskOps(runner, {
      probe: () => {
        probeCalls += 1
        return !confirmedDead
      },
      sleep: noSleep
    })
    const result = await ops.killTree(4242, 400)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/未能终止/)
    expect(result.degraded).toBe(true)
  })

  it('确认期仍活 → 500ms 轮询 + 补一次 Stop-Process → 死亡成功', async () => {
    let spawnCount = 0
    let dead = false
    const run = vi.fn(async (_file: string, _args: string[]): Promise<RunResult> => {
      spawnCount += 1
      if (spawnCount >= 2) dead = true // 补杀（第 2 次 spawn）后死亡
      return { code: 0, stdout: 'WALK=OK\r\nMAIN=OK\r\n', stderr: '', timedOut: false }
    })
    const sleeps: number[] = []
    const ops = createTaskOps({ run }, {
      probe: () => !dead,
      sleep: async (ms) => {
        sleeps.push(ms)
      }
    })
    const result = await ops.killTree(4242, 4_000)
    expect(result.ok).toBe(true)
    // spawn 序：①主引擎 → ②补杀（单点 Stop-Process）
    expect(spawnCount).toBe(2)
    expect(String(run.mock.calls[1]?.[1]?.at(-1))).toContain('Stop-Process -Id $main -Force')
    expect(sleeps.length).toBeGreaterThan(0)
    expect(sleeps.every((ms) => ms <= 500)).toBe(true) // 500ms 间隔
  })

  it('MAIN=ERR（Stop-Process 无法终止）+ 确认死亡（竞态：查询时已消失）→ 仍 ok', async () => {
    const { runner } = fakeRunner(() => ({ stdout: 'WALK=OK\r\nMAIN=ERR\r\n' }))
    const ops = createTaskOps(runner, { probe: () => false, sleep: noSleep })
    const result = await ops.killTree(4242, 8_000)
    expect(result.ok).toBe(true)
  })

  it('MAIN=ERR + 补杀后仍活 → ok:false 错误含"权限不足"提示', async () => {
    const { runner } = fakeRunner(() => ({ stdout: 'WALK=OK\r\nMAIN=ERR\r\n' }))
    const ops = createTaskOps(runner, { probe: () => true, sleep: noSleep })
    const result = await ops.killTree(4242, 600)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/权限不足/)
  })

  it('无效 pid → 立即失败不 spawn', async () => {
    const { runner, run } = fakeRunner(() => ({}))
    const ops = createTaskOps(runner, { probe: () => true, sleep: noSleep })
    const result = await ops.killTree(0, 8_000)
    expect(result.ok).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('小预算（timeoutMs < 硬上限）：枚举预算压缩、整体不超预算', async () => {
    const { runner, run } = fakeRunner(() => ({
      stdout: 'WALK=OK\r\nMAIN=OK\r\n'
    }))
    const ops = createTaskOps(runner, { probe: () => false, sleep: noSleep })
    await ops.killTree(4242, 1_000)
    expect(run.mock.calls[0]?.[2]).toBe(1_000) // hardCap = min(3000, timeoutMs)
    const script = String(run.mock.calls[0]?.[1]?.at(-1))
    expect(script).toContain('AddMilliseconds(0)') // walkBudget = max(0, min(1000, 1000-2000)) = 0
  })
})

describe('task-killer / probeAlive 注入（TaskOps 暴露注入点）', () => {
  it('createTaskOps 返回的 probeAlive 即注入实现', () => {
    const { runner } = fakeRunner(() => ({}))
    const ops = createTaskOps(runner, { probe: () => true, sleep: noSleep })
    expect(ops.probeAlive(1)).toBe(true)
  })
})
