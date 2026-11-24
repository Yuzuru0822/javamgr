/**
 * stdout 捕获日志持久化。
 *
 * - 布局：`<logsDir>/<projectId>/<runId>.log`（追加写，UTF-8 已解码文本）；
 * - 单文件超限轮转；保留策略同时约束轮转数、run 数、保留天数与全局目标容量；
 * - 活动 writer 对应 run 由写入串行链独占保护，后台清理只回收非活动 run；
 * - 清理仅识别 javamgr 自有文件布局，未知文件、目录与链接不递归处理。
 *
 * 本模块零 electron 依赖（logsDir 注入）。
 */

import { appendFile, mkdir, open, readdir, rmdir, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { LogCleanupResult, LogCleanupScope } from '../../shared/types'
import { renameWithRetry } from '../fs-utils'

export interface LogStoreLimits {
  maxFileBytes: number
  maxRotations: number
  runsToKeep: number
  /** 缺省兼容旧调用方：7 天 */
  retentionMs?: number
  /** 缺省兼容旧调用方：512 MiB；属于可回收目标，不删除活动 run 硬凑限额 */
  maxTotalBytes?: number
}

export interface LogStoreOptions {
  logsDir: string
  /** 每次写入/清理时取实时 settings（日志保留参数可热更） */
  getLimits: () => LogStoreLimits
  /** 测试注入时钟 */
  now?: () => number
  /** 允许 legacyDefault 全量清理：只给「旧默认目录」专用实例开启，
   *  避免同一个 store 被跨 scope 请求时把当前目录按全删规则处理。 */
  allowPurge?: boolean
}

/** 单个 run 的概要（listRuns 产物） */
export interface RunSummary {
  runId: string
  /** 该 run 全部现存文件（旧→新：.N … .1 当前） */
  files: string[]
  /** 该 run 最新文件 mtime（保留清理排序键） */
  lastModifiedMs: number
  sizeBytes: number
  active: boolean
}

export interface LogStorageStats {
  totalBytes: number
  activeBytes: number
  errors: string[]
}

interface ScannedFile {
  path: string
  sizeBytes: number
  mtimeMs: number
  /** 0=当前 base；1…N=轮转 */
  rotation: number
}

interface ScannedRun extends RunSummary {
  projectId: string
  projectDir: string
  fileDetails: ScannedFile[]
}

interface ScanResult {
  runs: ScannedRun[]
  projectDirs: string[]
  totalBytes: number
  activeBytes: number
  errors: string[]
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024
const PROJECT_DIR = /^(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|p[A-Za-z0-9_-]{0,120})$/i
const LOG_FILE = /^((?:\d{8}-\d{6}-[0-9a-f]{8}|switch-\d+|run-[A-Za-z0-9][A-Za-z0-9_-]{0,117}))\.log(?:\.(\d+)|\.rotating|\.retiring)?$/i
/** .rotating 是被抢占的最新 base，位于 .1 与当前 base 之间；不可按多余旧后缀清理 */
const ROTATING_SUFFIX_ROTATION = 0.5
/** .retiring 是已完成轮转后待删的最旧代，读取时排最前，可由保留清理回收 */
const RETIRING_SUFFIX_ROTATION = 9_999

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch (err) {
    if (isMissing(err)) return -1
    throw err
  }
}

export class LogStore {
  private readonly writers = new Map<string, RunLogWriter>()
  private cleanupInFlight: Promise<LogCleanupResult> | undefined
  private cleanupPending = false
  private cleanupPurgePending = false

  constructor(private readonly opts: LogStoreOptions) {}

  private projectDir(projectId: string): string {
    return path.join(this.opts.logsDir, projectId)
  }

  private writerKey(projectId: string, runId: string): string {
    return `${projectId}/${runId}`
  }

  /** 包括正在 close/drain 的 writer；关闭回调从活动表移除后才返回 false。 */
  hasRun(projectId: string, runId: string): boolean {
    return this.writers.has(this.writerKey(projectId, runId))
  }

  /** 打开（或复用）一个 run 的写入器；正在关闭的同名 writer 不允许复用。 */
  openRun(projectId: string, runId: string): RunLogWriter {
    const key = this.writerKey(projectId, runId)
    const existing = this.writers.get(key)
    if (existing) {
      if (existing.isClosed) throw new Error(`日志 writer 正在关闭，不能复用：${key}`)
      return existing
    }
    const writer = new RunLogWriter(
      this.projectDir(projectId),
      runId,
      () => this.opts.getLimits(),
      async (closed) => {
        // close 已先 drain；活动表移除后再清理，晚到清理不会把该 run 误判为活动。
        if (this.writers.get(key) === closed) this.writers.delete(key)
        await this.cleanup('current')
      }
    )
    this.writers.set(key, writer)
    return writer
  }

  /** 枚举项目全部历史 run（按 mtime 新→旧；runId 倒序 tie-break）。 */
  async listRuns(projectId: string): Promise<RunSummary[]> {
    const result = await this.scanProject(projectId, this.projectDir(projectId))
    if (result.errors.length > 0) throw new Error(result.errors.join('；'))
    return sortRunsNewest(result.runs)
  }

  /** 最新 run 的全部现存文件（旧→新）；无历史返回 []。 */
  async latestRunFiles(projectId: string): Promise<string[]> {
    const latest = (await this.listRuns(projectId))[0]
    if (!latest) return []
    const existing: string[] = []
    for (const file of latest.files) {
      if (await fileSize(file) >= 0) existing.push(file)
    }
    return existing
  }

  /** 最新 run 尾部 lines 行（跨轮转文件按时间序拼接）。 */
  async readTail(projectId: string, lines: number): Promise<{ lines: string[]; runId?: string }> {
    const latest = (await this.listRuns(projectId))[0]
    if (!latest) return { lines: [] }
    const collected: string[] = []
    for (const file of [...latest.files].reverse()) {
      if (collected.length >= lines) break
      const text = await readFileTailText(file, lines - collected.length + 1)
      if (text.length > 0) collected.unshift(...text.split('\n'))
    }
    return { lines: collected.slice(-lines), runId: latest.runId }
  }

  /** 当前目录占用快照；活动字节是全局目标容量中暂不可回收的部分。 */
  async getStorageStats(): Promise<LogStorageStats> {
    const scan = await this.scanAll()
    return { totalBytes: scan.totalBytes, activeBytes: scan.activeBytes, errors: scan.errors }
  }

  /** 兼容原调用口：run 关闭/旧测试按项目触发；统一汇入全局 single-flight 清理。 */
  async cleanupProject(_projectId: string): Promise<void> {
    await this.cleanup('current')
  }

  /**
   * 单次清理请求可能合并多个触发源；运行期间又来了新请求则置 dirty，在本轮后再跑一轮，
   * 避免“清理中到来的 run close/设置变更”被直接丢弃。
   */
  cleanup(scope: LogCleanupScope = 'current'): Promise<LogCleanupResult> {
    if (scope === 'legacyDefault' && this.opts.allowPurge !== true) {
      return Promise.reject(new Error('当前日志目录实例不允许 legacyDefault 全量清理'))
    }
    this.cleanupPending = true
    // 全删只在「旧默认目录」专用实例上生效（allowPurge），当前目录实例永不被全删
    if (scope === 'legacyDefault') this.cleanupPurgePending = true
    if (!this.cleanupInFlight) this.cleanupInFlight = this.runCleanupLoop(scope)
    return this.cleanupInFlight
  }

  private async runCleanupLoop(scope: LogCleanupScope): Promise<LogCleanupResult> {
    const aggregate: LogCleanupResult = {
      scope,
      logsDir: this.opts.logsDir,
      freedBytes: 0,
      deletedFiles: 0,
      remainingBytes: 0,
      activeBytes: 0,
      errors: [],
      cleanedAt: new Date(this.opts.now?.() ?? Date.now()).toISOString()
    }
    try {
      do {
        this.cleanupPending = false
        const purge = this.cleanupPurgePending
        this.cleanupPurgePending = false
        const result = await this.performCleanup(purge ? 'legacyDefault' : 'current')
        aggregate.freedBytes += result.freedBytes
        aggregate.deletedFiles += result.deletedFiles
        aggregate.remainingBytes = result.remainingBytes
        aggregate.activeBytes = result.activeBytes
        aggregate.errors.push(...result.errors)
        aggregate.cleanedAt = result.cleanedAt
      } while (this.cleanupPending)
      return aggregate
    } finally {
      this.cleanupInFlight = undefined
    }
  }

  private async performCleanup(scope: LogCleanupScope): Promise<LogCleanupResult> {
    const result: LogCleanupResult = {
      scope,
      logsDir: this.opts.logsDir,
      freedBytes: 0,
      deletedFiles: 0,
      remainingBytes: 0,
      activeBytes: 0,
      errors: [],
      cleanedAt: new Date(this.opts.now?.() ?? Date.now()).toISOString()
    }
    const limits = this.opts.getLimits()
    const retentionMs = limits.retentionMs ?? DEFAULT_RETENTION_MS
    const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    const cutoff = (this.opts.now?.() ?? Date.now()) - retentionMs

    const initial = await this.scanAll()
    result.errors.push(...initial.errors)
    if (scope === 'legacyDefault') {
      // 显式清理旧默认根：只全删可确认属于 javamgr 的 stdout 文件；活动项仍防御性跳过。
      for (const run of initial.runs) {
        if (run.active || this.writers.has(this.writerKey(run.projectId, run.runId))) continue
        await this.deleteFiles(run.fileDetails, result)
      }
    } else {
      const byProject = new Map<string, ScannedRun[]>()
      for (const run of initial.runs) {
        const runs = byProject.get(run.projectId) ?? []
        runs.push(run)
        byProject.set(run.projectId, runs)
      }
      for (const runs of byProject.values()) {
        const ordered = sortRunsNewest(runs)
        // 活动 run 既不删除也不占用保留配额：runsToKeep 统计的是「历史 run」
        let keptHistory = 0
        for (const run of ordered) {
          if (run.active || this.writers.has(this.writerKey(run.projectId, run.runId))) continue
          if (run.lastModifiedMs <= cutoff) {
            await this.deleteFiles(run.fileDetails, result)
            continue
          }
          if (keptHistory < Math.max(1, limits.runsToKeep)) {
            keptHistory += 1
            await this.deleteFiles(
              run.fileDetails.filter(
                (file) =>
                  file.rotation > Math.max(1, limits.maxRotations) &&
                  file.rotation !== RETIRING_SUFFIX_ROTATION
              ),
              result
            )
          } else {
            await this.deleteFiles(run.fileDetails, result)
          }
        }
      }

      // 全局容量按完整 run 组回收，避免只剩半段轮转历史；删除前实时复查活动表。
      const afterRetention = await this.scanAll()
      result.errors.push(...afterRetention.errors)
      let remaining = afterRetention.totalBytes
      const oldestFirst = [...afterRetention.runs].sort(
        (a, b) => a.lastModifiedMs - b.lastModifiedMs || a.runId.localeCompare(b.runId)
      )
      for (const run of oldestFirst) {
        if (remaining <= maxTotalBytes) break
        if (run.active || this.writers.has(this.writerKey(run.projectId, run.runId))) continue
        const freedBefore = result.freedBytes
        await this.deleteFiles(run.fileDetails, result)
        // 用真实释放字节推进，避免每个 run 都全量重扫（stat 量级 O(files) → O(1)）
        remaining -= result.freedBytes - freedBefore
      }
    }

    await this.removeEmptyProjectDirs(initial.projectDirs, result)
    const final = await this.scanAll()
    result.errors.push(...final.errors)
    result.remainingBytes = final.totalBytes
    result.activeBytes = final.activeBytes
    result.cleanedAt = new Date(this.opts.now?.() ?? Date.now()).toISOString()
    return result
  }

  private async deleteFiles(files: ScannedFile[], result: LogCleanupResult): Promise<void> {
    for (const file of files) {
      try {
        // 删除前重新 stat：释放字节只计算真实成功删除的现存文件。
        const current = await stat(file.path)
        if (!current.isFile()) continue
        await unlink(file.path)
        result.freedBytes += current.size
        result.deletedFiles += 1
      } catch (err) {
        if (isMissing(err)) continue
        result.errors.push(`删除 ${file.path} 失败：${errorText(err)}`)
      }
    }
  }

  private async removeEmptyProjectDirs(dirs: string[], result: LogCleanupResult): Promise<void> {
    for (const dir of dirs) {
      try {
        await rmdir(dir)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') continue
        result.errors.push(`移除空日志目录 ${dir} 失败：${errorText(err)}`)
      }
    }
  }

  private async scanAll(): Promise<ScanResult> {
    const result: ScanResult = {
      runs: [],
      projectDirs: [],
      totalBytes: 0,
      activeBytes: 0,
      errors: []
    }
    let entries
    try {
      entries = await readdir(this.opts.logsDir, { withFileTypes: true })
    } catch (err) {
      if (isMissing(err)) return result
      throw new Error(`读取日志根目录 ${this.opts.logsDir} 失败：${errorText(err)}`)
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !PROJECT_DIR.test(entry.name)) continue
      const projectDir = this.projectDir(entry.name)
      result.projectDirs.push(projectDir)
      const project = await this.scanProject(entry.name, projectDir)
      result.runs.push(...project.runs)
      result.errors.push(...project.errors)
    }
    for (const run of result.runs) {
      result.totalBytes += run.sizeBytes
      if (run.active) result.activeBytes += run.sizeBytes
    }
    return result
  }

  private async scanProject(
    projectId: string,
    dir: string
  ): Promise<{ runs: ScannedRun[]; errors: string[] }> {
    const errors: string[] = []
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (isMissing(err)) return { runs: [], errors }
      return { runs: [], errors: [`读取日志目录 ${dir} 失败：${errorText(err)}`] }
    }
    const byRun = new Map<string, ScannedFile[]>()
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      const match = LOG_FILE.exec(entry.name)
      if (!match) continue
      const filePath = path.join(dir, entry.name)
      try {
        const info = await stat(filePath)
        if (!info.isFile()) continue
        const runId = match[1]!
        const files = byRun.get(runId) ?? []
        files.push({
          path: filePath,
          sizeBytes: info.size,
          mtimeMs: info.mtimeMs,
          rotation: match[2]
            ? Number(match[2])
            : entry.name.endsWith('.rotating')
              ? ROTATING_SUFFIX_ROTATION
              : entry.name.endsWith('.retiring')
                ? RETIRING_SUFFIX_ROTATION
                : 0
        })
        byRun.set(runId, files)
      } catch (err) {
        if (!isMissing(err)) errors.push(`读取日志文件 ${filePath} 状态失败：${errorText(err)}`)
      }
    }
    const runs: ScannedRun[] = []
    for (const [runId, fileDetails] of byRun) {
      fileDetails.sort((a, b) => b.rotation - a.rotation)
      runs.push({
        projectId,
        projectDir: dir,
        runId,
        fileDetails,
        files: fileDetails.map((file) => file.path),
        lastModifiedMs: Math.max(...fileDetails.map((file) => file.mtimeMs)),
        sizeBytes: fileDetails.reduce((sum, file) => sum + file.sizeBytes, 0),
        active: this.writers.has(this.writerKey(projectId, runId))
      })
    }
    return { runs, errors }
  }
}

function sortRunsNewest<T extends RunSummary>(runs: T[]): T[] {
  return [...runs].sort(
    (a, b) => b.lastModifiedMs - a.lastModifiedMs || (a.runId < b.runId ? 1 : -1)
  )
}

/** 单 run 文件写入器：追加写 + 大小轮转；append 经内部 promise 链串行化。 */
export class RunLogWriter {
  private size = -1
  private closed = false
  private recovered = false
  private dirReady = false
  private tail: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly dir: string,
    private readonly runId: string,
    private readonly getLimits: () => LogStoreLimits,
    private readonly onClosed: (writer: RunLogWriter) => Promise<void>
  ) {}

  get isClosed(): boolean {
    return this.closed
  }

  private get base(): string {
    return path.join(this.dir, `${this.runId}.log`)
  }

  /** 追加整行批次；轮转失败则本批不写，后续 append 可在故障恢复后重试。 */
  append(lines: string[]): Promise<void> {
    if (lines.length === 0) return Promise.resolve()
    if (this.closed) return Promise.reject(new Error(`日志 writer 已关闭：${this.runId}`))
    const run = async (): Promise<void> => {
      const data = Buffer.from(`${lines.join('\n')}\n`, 'utf8')
      const limits = this.getLimits()
      if (!this.dirReady) {
        await mkdir(this.dir, { recursive: true })
        this.dirReady = true
      }
      if (!this.recovered) {
        await this.recoverPendingRotation()
        this.recovered = true
      }
      if (this.size < 0) this.size = Math.max(0, await fileSize(this.base))
      if (this.size > 0 && this.size + data.length > limits.maxFileBytes) {
        await this.rotate(limits.maxRotations)
      }
      await appendFile(this.base, data)
      this.size += data.length
    }
    this.tail = this.tail.then(run, run)
    return this.tail
  }

  /** 关闭幂等：等待已排队写入，再从活动表移除并等待保留清理。 */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      let failure: unknown
      try {
        await this.drain()
      } catch (err) {
        failure = err
      }
      try {
        await this.onClosed(this)
      } catch (err) {
        if (failure === undefined) failure = err
        else console.error(`[log-store] writer 关闭后清理失败（${this.runId}）：`, err)
      }
      if (failure !== undefined) throw failure
    })()
    return this.closePromise
  }

  drain(): Promise<void> {
    return this.tail
  }

  /** 轮转/恢复一律禁止覆盖目标文件，防止部分回滚把另一代历史冲掉。 */
  private async renameNoClobber(from: string, to: string): Promise<void> {
    if ((await fileSize(to)) >= 0) {
      throw Object.assign(new Error(`日志轮转目标已存在，拒绝覆盖：${to}`), { code: 'EEXIST' })
    }
    await renameWithRetry(from, to)
  }

  /** 恢复崩溃/回滚失败留下的 rotating、retiring 或双残留现场。 */
  private async recoverPendingRotation(): Promise<void> {
    const rotating = `${this.base}.rotating`
    const retiring = `${this.base}.retiring`
    const hasRotating = (await fileSize(rotating)) >= 0
    const hasRetiring = (await fileSize(retiring)) >= 0
    if (!hasRotating && !hasRetiring) return
    if (hasRotating && (await fileSize(this.base)) >= 0) {
      throw new Error(`日志轮转恢复冲突：当前文件与暂存文件同时存在（${this.base}）`)
    }

    const rotationPattern = new RegExp(`^${this.runId}\\.log\\.(\\d+)$`)
    const readMaxRotation = async (): Promise<number> => {
      const names = await readdir(this.dir)
      let max = 0
      for (const name of names) {
        const match = rotationPattern.exec(name)
        if (match) max = Math.max(max, Number(match[1]))
      }
      return max
    }
    const hasGap = async (max: number): Promise<boolean> => {
      for (let i = 1; i <= max; i++) {
        if ((await fileSize(`${this.base}.${i}`)) < 0) return true
      }
      return false
    }

    const maxBefore = await readMaxRotation()
    // 只有 retiring 且历史编号连续，可能是已提交待删垃圾，也可能尚未开始顺移；
    // 两种都不需要在这里改动，后续轮转会区分并安全处理。
    if (!hasRotating && !(await hasGap(maxBefore))) return

    // 有 rotating 或编号缺口 = 未提交现场；只向空位回移，绝不覆盖另一代。
    for (let i = 1; i < maxBefore; i++) {
      const target = `${this.base}.${i}`
      const source = `${this.base}.${i + 1}`
      if ((await fileSize(target)) < 0 && (await fileSize(source)) >= 0) {
        await this.renameNoClobber(source, target)
      }
    }
    if (hasRetiring) {
      const restored = `${this.base}.${(await readMaxRotation()) + 1}`
      await this.renameNoClobber(retiring, restored)
    }
    if (hasRotating) await this.renameNoClobber(rotating, this.base)
  }

  /** base → rotating；最旧代 → retiring；提交 rotating → .1 后才删除最旧代。 */
  private async rotate(maxRotations: number): Promise<void> {
    await this.recoverPendingRotation()
    const rotating = `${this.base}.rotating`
    const retiring = `${this.base}.retiring`
    await this.renameNoClobber(this.base, rotating)
    const moved: number[] = []
    let retired = false
    try {
      if ((await fileSize(retiring)) >= 0) {
        if ((await fileSize(`${this.base}.${maxRotations}`)) >= 0) {
          // 恢复后仍与完整 .N 并存的 retiring 是已提交轮转留下的待删垃圾。
          await unlink(retiring)
        } else {
          retired = true // 未归位的最旧代，本轮提交成功后才删除
        }
      }
      if (!retired && (await fileSize(`${this.base}.${maxRotations}`)) >= 0) {
        await this.renameNoClobber(`${this.base}.${maxRotations}`, retiring)
        retired = true
      }
      for (let i = maxRotations - 1; i >= 1; i -= 1) {
        try {
          await this.renameNoClobber(`${this.base}.${i}`, `${this.base}.${i + 1}`)
          moved.push(i)
        } catch (err) {
          if (!isMissing(err)) throw err
        }
      }
      await this.renameNoClobber(rotating, `${this.base}.1`)
    } catch (err) {
      const rollbackErrors: unknown[] = []
      for (const i of [...moved].reverse()) {
        try {
          await this.renameNoClobber(`${this.base}.${i + 1}`, `${this.base}.${i}`)
        } catch (rollbackErr) {
          rollbackErrors.push(rollbackErr)
          // 目标被占用时停止后续回滚，不能把更老一代继续覆盖上去。
          break
        }
      }
      if (retired) {
        if ((await fileSize(`${this.base}.${maxRotations}`)) < 0) {
          try {
            await this.renameNoClobber(retiring, `${this.base}.${maxRotations}`)
          } catch (rollbackErr) {
            rollbackErrors.push(rollbackErr)
          }
        } else {
          rollbackErrors.push(new Error('最旧代归位位置被占用，已保留 .retiring'))
        }
      }
      if ((await fileSize(rotating)) >= 0) {
        if ((await fileSize(this.base)) < 0) {
          try {
            await this.renameNoClobber(rotating, this.base)
          } catch (rollbackErr) {
            rollbackErrors.push(rollbackErr)
          }
        } else {
          rollbackErrors.push(new Error('base 已存在，未覆盖 .rotating 暂存文件'))
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(
          `日志轮转失败：${errorText(err)}；回滚未完全恢复：${rollbackErrors.map(errorText).join('；')}`
        )
      }
      throw err
    }

    this.size = 0
    if (retired) {
      try {
        await unlink(retiring)
      } catch (err) {
        if (!isMissing(err)) throw err
      }
    }
  }
}

/** 读文件末尾文本（64KB 块反向读取，凑够 maxLines 行即止）。 */
async function readFileTailText(file: string, maxLines: number): Promise<string> {
  const size = await fileSize(file)
  if (size <= 0) return ''
  const BLOCK = 64 * 1024
  const chunks: Buffer[] = []
  let position = size
  let newlines = 0
  let reachedStart = false
  let handle: FileHandle | undefined
  try {
    handle = await open(file, 'r')
    while (position > 0 && newlines <= maxLines) {
      const readSize = Math.min(BLOCK, position)
      position -= readSize
      const chunk = Buffer.alloc(readSize)
      await handle.read(chunk, 0, readSize, position)
      chunks.unshift(chunk)
      newlines += chunk.filter((b) => b === 0x0a).length
      if (position === 0) reachedStart = true
    }
  } catch (err) {
    if (isMissing(err)) return ''
    throw err
  } finally {
    await handle?.close().catch(() => undefined)
  }
  const data = Buffer.concat(chunks)
  const firstNewline = data.indexOf(0x0a)
  const body = reachedStart || firstNewline === -1 ? data : data.subarray(firstNewline + 1)
  const text = body.toString('utf8')
  return text.endsWith('\n') ? text.slice(0, -1) : text
}
