/**
 * 主进程事件循环延迟简易打点（N-6 落点，§7 分叉 1 演进触发条件的度量基础）。
 *
 * 背景：utilityProcess 日志 worker 的量化演进触发条件之一是"主进程 event loop
 * 延迟 P95 >100ms 且持续 30s"（另一条：单项目持续日志吞吐 >2,000 行/秒）。
 * 本模块提供该指标的低成本测量与查询，设置页可查看（§7 "应用内置简易打点测量，
 * 设置页可查看指标"）。
 *
 * 测量方法（经典 setImmediate 漂移）：每 sampleIntervalMs 调度一次
 * setImmediate，记录调度时刻与实际执行时刻之差 = 该采样周期内事件循环的阻塞
 * 程度。样本保留在滚动窗口（默认 30s）内，getMetrics() 计算窗口内 P95；
 * P95 持续超阈值 ≥ sustainedMs 时 sustainedHigh=true（演进条件判定用）。
 *
 * 本模块零 electron 依赖（纯 Node 定时器），vitest 可直接测。
 */

import type { EventLoopMetrics } from '../../shared/types'

export interface EventLoopMonitorOptions {
  /** 采样间隔（默认 1000ms；测试可缩短） */
  sampleIntervalMs?: number
  /** 滚动窗口长度（默认 30_000ms，与演进条件"持续 30s"对齐） */
  windowMs?: number
  /** P95 高位阈值（默认 100ms，§7 分叉 1） */
  highThresholdMs?: number
  /** 高位持续时长（默认 30_000ms）：P95 超阈值持续到该时长 → sustainedHigh */
  sustainedMs?: number
  /** 时钟注入（测试用；默认 performance.now，毫秒浮点精度） */
  now?: () => number
}

interface Sample {
  at: number
  lag: number
}

const DEFAULTS = {
  sampleIntervalMs: 1_000,
  windowMs: 30_000,
  highThresholdMs: 100,
  sustainedMs: 30_000
} as const

export class EventLoopMonitor {
  private readonly sampleIntervalMs: number
  private readonly windowMs: number
  private readonly highThresholdMs: number
  private readonly sustainedMs: number
  private readonly now: () => number

  private samples: Sample[] = []
  private timer: NodeJS.Timeout | undefined
  /** P95 首次越过阈值的时刻（undefined = 当前窗口未越界） */
  private highSince: number | undefined

  constructor(opts: EventLoopMonitorOptions = {}) {
    this.sampleIntervalMs = opts.sampleIntervalMs ?? DEFAULTS.sampleIntervalMs
    this.windowMs = opts.windowMs ?? DEFAULTS.windowMs
    this.highThresholdMs = opts.highThresholdMs ?? DEFAULTS.highThresholdMs
    this.sustainedMs = opts.sustainedMs ?? DEFAULTS.sustainedMs
    this.now = opts.now ?? (() => performance.now())
  }

  /** 启动采样（幂等：已启动时忽略） */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => this.takeSample(), this.sampleIntervalMs)
    this.takeSample() // 启动即取一个样本，设置页无需等一个周期
  }

  /** 停止采样（窗口样本保留，可查询历史；重启 start 续采） */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 手动采一个样本（测试与 start() 首采复用；正常由定时器驱动） */
  takeSample(): void {
    const scheduledAt = this.now()
    setImmediate(() => {
      const lag = Math.max(0, this.now() - scheduledAt)
      this.record(scheduledAt, lag)
    })
  }

  /** 当前窗口指标快照 */
  getMetrics(): EventLoopMetrics {
    this.evict()
    const lags = this.samples.map((s) => s.lag)
    const p95 = percentile(lags, 0.95)
    // sustainedHigh 判定：当前窗口 P95 越界 + 越界起点距今 ≥ sustainedMs
    let sustainedHigh = false
    if (p95 > this.highThresholdMs) {
      if (this.highSince === undefined) this.highSince = this.now()
      sustainedHigh = this.now() - this.highSince >= this.sustainedMs
    } else {
      this.highSince = undefined
    }
    const last = this.samples.length > 0 ? this.samples[this.samples.length - 1] : undefined
    return {
      lastMs: round2(last?.lag ?? 0),
      p95Ms: round2(p95),
      samples: this.samples.length,
      windowMs: this.windowMs,
      sustainedHigh
    }
  }

  private record(at: number, lag: number): void {
    this.samples.push({ at, lag })
    this.evict()
  }

  /** 滚动窗口淘汰（以样本时间戳为准，早于 now-windowMs 的丢弃） */
  private evict(): void {
    const cutoff = this.now() - this.windowMs
    if (this.samples.length === 0 || this.samples[0].at >= cutoff) return
    const firstKept = this.samples.findIndex((s) => s.at >= cutoff)
    this.samples = firstKept === -1 ? [] : this.samples.slice(firstKept)
  }
}

// ---------- 小工具 ----------

/** 就地排序数组的分位数（lags 小数组拷贝排序，无需完整分布库） */
function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[idx] ?? 0
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
