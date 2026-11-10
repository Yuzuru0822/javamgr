import { afterEach, describe, expect, it } from 'vitest'
import { EventLoopMonitor } from '../../src/main/telemetry/event-loop-monitor'

/**
 * event-loop-monitor 单测（N-6 / §7 分叉 1 演进条件度量）：
 * 采样/滚动窗口/P95 计算/sustainedHigh 状态机。真实定时器（短间隔加速），
 * 用同步自旋制造可观测的事件循环阻塞。
 */

const monitors: EventLoopMonitor[] = []

afterEach(() => {
  for (const m of monitors.splice(0)) m.stop()
})

function makeMonitor(opts: ConstructorParameters<typeof EventLoopMonitor>[0] = {}): EventLoopMonitor {
  const m = new EventLoopMonitor({ sampleIntervalMs: 20, windowMs: 2_000, ...opts })
  monitors.push(m)
  return m
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('EventLoopMonitor（N-6）', () => {
  it('启动即有首个样本；采样持续累积；stop 后样本数不再增长', async () => {
    const m = makeMonitor()
    m.start()
    await sleep(10) // takeSample 的 setImmediate 已执行（首样本同步调度）
    const first = m.getMetrics()
    expect(first.samples).toBeGreaterThanOrEqual(1)
    expect(first.p95Ms).toBeGreaterThanOrEqual(0)
    expect(first.windowMs).toBe(2_000)
    expect(first.sustainedHigh).toBe(false)

    await sleep(120) // 定时器续采
    const grown = m.getMetrics()
    expect(grown.samples).toBeGreaterThan(first.samples)

    m.stop()
    await sleep(50) // 已调度未执行的样本落账（stop 不撤回在飞的 setImmediate）
    const frozen = m.getMetrics().samples
    await sleep(80)
    expect(m.getMetrics().samples).toBeLessThanOrEqual(frozen) // 停止后不再新增采样
  })

  it('同步阻塞主线程 → 采样延迟显著升高（P95 反映真实阻塞）', async () => {
    const m = makeMonitor({ sampleIntervalMs: 20 })
    m.start()
    await sleep(60) // 基线样本

    // 确定性阻塞：先手动采样（调度 setImmediate），随即同步自旋 120ms——
    // immediate 在 check 阶段执行，被自旋推迟到自旋结束 → 该样本 lag ≈ 120ms
    m.stop()
    m.takeSample()
    const spinUntil = performance.now() + 120
    while (performance.now() < spinUntil) {
      /* 同步自旋阻塞事件循环 */
    }
    await sleep(60) // 让被延迟的样本落账

    const metrics = m.getMetrics()
    expect(metrics.samples).toBeGreaterThan(1)
    expect(metrics.lastMs).toBeGreaterThan(90) // 阻塞样本真实记录到 >90ms 延迟
    expect(metrics.p95Ms).toBeGreaterThan(15)
  })

  it('滚动窗口淘汰旧样本（windowMs 之后早期样本出窗）', async () => {
    const m = makeMonitor({ sampleIntervalMs: 20, windowMs: 100 })
    m.start()
    await sleep(200) // 远超窗口
    const metrics = m.getMetrics()
    // 100ms 窗口 × 20ms 间隔 ≈ 5 个样本；上限放宽到 8 防边界竞态
    expect(metrics.samples).toBeLessThanOrEqual(8)
    expect(metrics.samples).toBeGreaterThanOrEqual(1)
  })

  it('sustainedHigh：P95 越界持续 ≥ sustainedMs 才置位；回落即复位（注入时钟，确定性）', async () => {
    // 注入假时钟：takeSample 调度后、immediate 执行前推进 t → lag = 推进量，完全可控
    const clock = { t: 0 }
    const m = new EventLoopMonitor({
      now: () => clock.t,
      sampleIntervalMs: 1_000,
      windowMs: 10_000,
      highThresholdMs: 100,
      sustainedMs: 1_000
    })
    monitors.push(m)
    const flush = (): Promise<void> => new Promise((r) => setImmediate(r))
    const sampleWithLag = async (lag: number, advance = 10): Promise<void> => {
      m.takeSample()
      clock.t += lag // immediate 执行时测得的延迟
      await flush()
      clock.t += advance // 推进到下一个采样时刻
    }

    // 低延迟基线样本（不越界）
    await sampleWithLag(5)
    expect(m.getMetrics().sustainedHigh).toBe(false)

    // 高延迟样本进入窗口：首次 getMetrics 记 highSince，但未满 sustainedMs → 仍 false
    for (let i = 0; i < 5; i += 1) await sampleWithLag(150)
    clock.t += 500 // 距 highSince 500ms < 1000ms
    expect(m.getMetrics().sustainedHigh).toBe(false)
    expect(m.getMetrics().p95Ms).toBe(150)

    // 持续越界满 1000ms → true（§7 分叉 1 演进触发条件；highSince 记于上一次查询 t=1315）
    clock.t += 1_100
    expect(m.getMetrics().sustainedHigh).toBe(true)

    // 窗口推进淘汰全部高样本 → P95 回落 → 复位
    clock.t += 20_000
    const cooled = m.getMetrics()
    expect(cooled.samples).toBe(0)
    expect(cooled.sustainedHigh).toBe(false)
  })
})
