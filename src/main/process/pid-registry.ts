/**
 * runs.json 落盘 + 启动重识别 + 无句柄进程批量存活轮询池（计划 §2.3-A / §3 S3.2，F2/Z-2、N-2、N-3）。
 *
 * 职责：
 * - 持久化 RunRecord[]（写入时机：start 成功 / stop 完成 / 进程退出 / app 退出前）；
 * - reidentify()：启动时逐条 kill0 存在性初筛（零 spawn）→ 存活者一次批量 Get-Process
 *   （名称须 java* + StartTime ±3s 比对，不一致 = PID 重用 → 判定已死）→ 存活者全部入轮询池；
 * - 轮询池：每 pollIntervalSeconds（settings 5–10s）一轮，每轮 spawn 数 0–1 次——
 *   ① 池内每个 pid 先 taskOps.probeAlive（process.kill(pid,0)）零开销初筛（死→进入复核）；
 *   ② 存活者/初筛死亡者一次批量 Get-Process（含 ProcessName+StartTime）做 N-3 防重用比对；
 *   ③ 该调用超时（≤2.5s）→ 本轮记"未验证"跳过（绝不堆积挂死助手、绝不据此误判死亡）；
 *   发现死亡 → onDeath 回调（process-manager 落终态"已停止（外部退出，退出码未知）"）→ 出池。
 *
 * WMI 病态宿主适配（2026-11-09）：tasklist/taskkill 全面退役出探活/轮询路径——tasklist
 * 在病态期挂死且超时返回空表会被误判为"全部死亡"；kill0 + Get-Process（PSAPI）全程健康。
 *
 * 本模块零 electron 依赖；TaskOps 与时钟/定时策略均可注入（vitest 可完整测试）。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RunRecord } from '../../shared/types'
import type { ProcessSnapshot, TaskOps } from './task-killer'
import { matchesJavaName } from './task-killer'

/** PID 重用比对容差：查询 StartTime 与记录 startTime 差值超过该值 = 不同进程 */
export const START_TIME_TOLERANCE_MS = 3_000

/** 重识别分类结果 */
export interface ReidentifiedRun {
  record: RunRecord
  /** true = 存活（java* 且启动时间比对一致）→ RUNNING + 入轮询池 */
  alive: boolean
  /** alive=false 的原因：exited（kill0 不存在）| pid-reused（名称/启动时间不一致） */
  reason?: 'exited' | 'pid-reused'
}

export interface PidRegistryOptions {
  /** runs.json 绝对路径（AppPaths.runsFile） */
  runsFile: string
  taskOps: TaskOps
  /** 池内进程死亡时回调（process-manager 设置终态并广播） */
  onDeath: (projectId: string, reason: 'exited' | 'pid-reused') => void
  /** 每轮读取 settings.pollIntervalSeconds（5–10），保持设置热更新 */
  getIntervalSeconds: () => number
  /** 休眠注入（单测 fake timers 下免等待） */
  sleep?: (ms: number) => Promise<void>
}

/** 单条记录的存活裁定结果 */
interface Verdict {
  /** alive = 存活；dead = 死亡（reason 区分）；undecided = 信号矛盾，本轮未决（保守留池） */
  outcome: 'alive' | 'dead' | 'undecided'
  reason?: 'exited' | 'pid-reused'
}

/**
 * 单条记录的存活裁定（批量 Get-Process 结果 → 存活 / pid-reused / exited / 未决）。
 * 未决 = 信号矛盾（kill0 活但 Get-Process 查无），保守留在池内待下轮，绝不误判死亡。
 */
function verdict(rec: RunRecord, screenAlive: boolean, info: ProcessSnapshot | undefined): Verdict {
  if (info !== undefined) {
    const sameProcess =
      matchesJavaName(info.name) &&
      info.startTime !== undefined &&
      Math.abs(info.startTime - rec.startTime) <= START_TIME_TOLERANCE_MS
    if (sameProcess) return { outcome: 'alive' }
    // 查有此 pid 但非 java 镜像或 StartTime 不一致 → PID 已被其他进程重用（N-3）
    return { outcome: 'dead', reason: 'pid-reused' }
  }
  // Get-Process 查无：kill0 也判死 → 确死；kill0 活着 → 信号矛盾，本轮未决
  if (!screenAlive) return { outcome: 'dead', reason: 'exited' }
  return { outcome: 'undecided' }
}

export class PidRegistry {
  /** projectId → 运行记录（内存权威，写盘走 save） */
  private readonly records = new Map<string, RunRecord>()
  /** 轮询池：重识别出的无句柄存活进程（有句柄进程纯事件驱动，不进池） */
  private readonly pool = new Map<string, RunRecord>()
  private timer: NodeJS.Timeout | undefined
  private polling = false
  /** 写盘串行化：tmp+rename 非重入，close 事件的异步 remove 与 upsert 并发时必须排队 */
  private writeTail: Promise<void> = Promise.resolve()
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly opts: PidRegistryOptions) {
    this.sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  }

  // ---------- 持久化（原子写：tmp → rename，与 config-store 同一模式） ----------

  /** 启动加载：文件缺失/损坏 → 空（容忍历史遗留，不阻塞启动） */
  async load(): Promise<RunRecord[]> {
    let raw: string
    try {
      raw = await readFile(this.opts.runsFile, 'utf8')
    } catch {
      return []
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      const list = parsed.filter(
        (v): v is RunRecord =>
          typeof v === 'object' &&
          v !== null &&
          typeof (v as RunRecord).projectId === 'string' &&
          typeof (v as RunRecord).pid === 'number' &&
          typeof (v as RunRecord).startTime === 'number' &&
          ((v as RunRecord).logSource === 'file' || (v as RunRecord).logSource === 'stdout')
      )
      this.records.clear()
      for (const rec of list) this.records.set(rec.projectId, rec)
      return list
    } catch {
      return []
    }
  }

  /**
   * 原子写盘（tmp → rename）。tmp 文件名带随机后缀：writeTail 只串行化**本实例**的写，
   * 同进程内多个 PidRegistry 实例（如 S3 重识别测试的 pmA/pmB、MCP 与 GUI 并存场景）
   * 会并发写同一 runs.json——固定 tmp 名会互相覆盖导致 rename ENOENT，随机后缀隔离。
   */
  async save(): Promise<void> {
    const perform = async (): Promise<void> => {
      await mkdir(path.dirname(this.opts.runsFile), { recursive: true })
      const tmp = `${this.opts.runsFile}.${randomUUID().slice(0, 8)}.tmp`
      await writeFile(tmp, `${JSON.stringify([...this.records.values()], null, 2)}\n`, 'utf8')
      await this.renameWithRetry(tmp, this.opts.runsFile)
    }
    const next = this.writeTail.then(perform, perform)
    this.writeTail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  /** Windows 下 rename 可能被杀软/索引器瞬态锁住（EPERM/EACCES/EBUSY）：小退避重试 */
  private async renameWithRetry(from: string, to: string, attempts = 3): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await rename(from, to)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (i === attempts - 1 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
          throw err
        }
        await this.sleep(50)
      }
    }
  }

  /** start 成功后登记（变更即写盘） */
  async upsert(record: RunRecord): Promise<void> {
    this.records.set(record.projectId, { ...record })
    await this.save()
  }

  /** stop 完成 / 进程退出 / 项目删除后移除（变更即写盘） */
  async remove(projectId: string): Promise<void> {
    this.records.delete(projectId)
    this.pool.delete(projectId)
    await this.save()
  }

  getRecord(projectId: string): RunRecord | undefined {
    const rec = this.records.get(projectId)
    return rec ? { ...rec } : undefined
  }

  // ---------- 重识别（启动时一次） ----------

  /**
   * 逐条 kill0 存在性初筛（零 spawn）→ 存活者一次批量 Get-Process（java* 名称 +
   * StartTime ±3s 比对，N-3）→ 存活全部入轮询池；返回分类结果供 process-manager 落状态。
   * 批量查询超时 → 存活者保守按存活入池（轮询池下轮纠正），绝不误判死亡。
   */
  async reidentify(): Promise<ReidentifiedRun[]> {
    const records = await this.load()
    const results: ReidentifiedRun[] = []
    const survivors: RunRecord[] = []

    for (const rec of records) {
      if (this.opts.taskOps.probeAlive(rec.pid)) {
        survivors.push(rec)
      } else {
        results.push({ record: { ...rec }, alive: false, reason: 'exited' })
      }
    }

    // 启动时间比对（一次批量查询）：不一致 = PID 已被重用 → 原进程必已死亡
    if (survivors.length > 0) {
      const batch = await this.opts.taskOps.batchQueryProcesses(
        survivors.map((r) => r.pid)
      )
      for (const rec of survivors) {
        if (batch === null) {
          // 查询超时（未验证）：保守按存活入池，轮询池下轮纠正
          results.push({ record: { ...rec }, alive: true })
          this.pool.set(rec.projectId, { ...rec })
          continue
        }
        const v = verdict(rec, true, batch.get(rec.pid))
        if (v.outcome === 'alive') {
          results.push({ record: { ...rec }, alive: true })
          this.pool.set(rec.projectId, { ...rec })
        } else {
          results.push({ record: { ...rec }, alive: false, reason: v.reason })
        }
      }
      // 被判死亡（含重用）的记录出清：runs.json 不再为它们背书
      const deadIds = new Set(results.filter((r) => !r.alive).map((r) => r.record.projectId))
      if (deadIds.size > 0) {
        for (const id of deadIds) this.records.delete(id)
        await this.save()
      }
    }

    return results
  }

  /** 手动补充入池（保留给 stop 后失去句柄等边界，S3 主流程不使用） */
  addToPool(record: RunRecord): void {
    this.pool.set(record.projectId, { ...record })
  }

  isInPool(projectId: string): boolean {
    return this.pool.has(projectId)
  }

  poolSize(): number {
    return this.pool.size
  }

  // ---------- 批量存活轮询池 ----------

  startPolling(): void {
    if (this.polling) return
    this.polling = true
    void this.scheduleNext(0)
  }

  stopPolling(): void {
    this.polling = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.polling) return
    this.timer = setTimeout(() => {
      // P2-2（phase4 审查）：finally 不吞拒绝——pollOnce 内 save() 落盘失败（Windows
      // 杀软/索引器锁 rename，重试后仍 EPERM/EBUSY）会使链拒绝且无人接，变成
      // unhandledRejection。此处 catch 兜底记日志；轮询经 finally 继续（写盘失败
      // 不终止存活监控，runs.json 由下次成功写盘修复）。
      void this.pollOnce()
        .catch((err: unknown) => {
          console.error('[pid-registry] 轮询出清写盘失败（runs.json，不影响继续监控）：', err)
        })
        .finally(() => {
          if (this.polling) this.scheduleNext(Math.max(1, this.opts.getIntervalSeconds() * 1000))
        })
    }, delayMs)
  }

  /**
   * 一轮轮询：spawn 数 0–1 次（空池 0 次）。
   * ① 池内每个 pid 先 probeAlive（process.kill(pid,0)）零开销初筛（死→进入复核）；
   * ② 存活者/初筛死亡者一次批量 Get-Process（ProcessName+StartTime，N-3 防重用比对）；
   * ③ 查询超时（batchQueryProcesses 返回 null）→ 本轮记"未验证"整体跳过。
   */
  async pollOnce(): Promise<void> {
    if (this.pool.size === 0) return

    // ① kill0 零开销初筛（无 spawn）
    const screen = new Map<string, boolean>() // projectId → kill0 存在
    for (const [projectId, rec] of this.pool) {
      screen.set(projectId, this.opts.taskOps.probeAlive(rec.pid))
    }

    // ② 一次批量 Get-Process（存活者 + 初筛死亡者全部复核）
    const batch = await this.opts.taskOps.batchQueryProcesses(
      [...this.pool.values()].map((r) => r.pid)
    )
    // ③ 查询超时/失败 → 本轮未验证：不误判死亡、不堆积挂死助手
    if (batch === null) return

    const dead: Array<{ projectId: string; reason: 'exited' | 'pid-reused' }> = []
    for (const [projectId, rec] of this.pool) {
      const screenAlive = screen.get(projectId) === true
      const v = verdict(rec, screenAlive, batch.get(rec.pid))
      if (v.outcome === 'undecided') continue // 信号矛盾：保守留池，下轮再判
      if (v.outcome === 'dead') dead.push({ projectId, reason: v.reason ?? 'exited' })
    }

    if (dead.length === 0) return

    let dirty = false
    for (const { projectId, reason } of dead) {
      this.pool.delete(projectId)
      // 池内进程死亡：runs 记录出清 + 回调 process-manager 落终态
      if (this.records.delete(projectId)) dirty = true
      try {
        this.opts.onDeath(projectId, reason)
      } catch (err) {
        console.error(`[pid-registry] onDeath 回调异常（${projectId}）：`, err)
      }
    }
    if (dirty) await this.save()
  }
}
