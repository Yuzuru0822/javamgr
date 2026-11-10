/**
 * stdout 捕获日志持久化（计划 §2.3-C / §3 S4.2）。
 *
 * - 布局：`<userData>/logs/<projectId>/<runId>.log`（追加写，UTF-8 已解码文本）；
 * - 单文件超 maxFileBytes（默认 10MB，settings.logMaxFileMb）轮转：
 *   `<runId>.log` → `<runId>.log.1`（.1→.2 顺移，超出 maxRotations 删除；.1 为最近轮转）；
 * - 每 run 关闭后按目录 mtime 清理，每项目保留最近 runsToKeep 个 run（默认 10）；
 * - 提供最新 run 的尾部读取（readTail，跨轮转文件按时间序拼接）与 run 枚举。
 *
 * 本模块零 electron 依赖（logsDir 注入）。
 */

import { appendFile, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

export interface LogStoreLimits {
  maxFileBytes: number
  maxRotations: number
  runsToKeep: number
}

export interface LogStoreOptions {
  logsDir: string
  /** 每次读取时取实时 settings（日志保留参数可热更） */
  getLimits: () => LogStoreLimits
}

/** 单个 run 的概要（listRuns 产物） */
export interface RunSummary {
  runId: string
  /** 该 run 全部现存文件（旧→新：.N … .1 当前） */
  files: string[]
  /** 该 run 最新文件 mtime（保留清理排序键） */
  lastModifiedMs: number
}

/** 尾部读取结果（跨轮转文件的完整行，按时间序） */
export interface TailResult {
  lines: string[]
  /** 实际读取的 run（无任何历史时省略） */
  runId?: string
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch {
    return -1 // 不存在
  }
}

export class LogStore {
  private readonly writers = new Map<string, RunLogWriter>()

  constructor(private readonly opts: LogStoreOptions) {}

  private projectDir(projectId: string): string {
    return path.join(this.opts.logsDir, projectId)
  }

  /** 打开（或复用）一个 run 的写入器；同一 runId 幂等返回同一实例 */
  openRun(projectId: string, runId: string): RunLogWriter {
    const key = `${projectId}/${runId}`
    const existing = this.writers.get(key)
    if (existing) return existing
    const writer = new RunLogWriter(this.projectDir(projectId), runId, () => this.opts.getLimits(), () => {
      this.writers.delete(key)
      // run 结束触发保留清理（失败仅记日志，不影响主流程）
      this.cleanupProject(projectId).catch((err: unknown) => {
        console.error(`[log-store] run 保留清理失败（${projectId}）：`, err)
      })
    })
    this.writers.set(key, writer)
    return writer
  }

  /** 枚举项目全部历史 run（按 mtime 新→旧；runId 倒序 tie-break） */
  async listRuns(projectId: string): Promise<RunSummary[]> {
    const dir = this.projectDir(projectId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return [] // 目录不存在 = 无历史
    }
    const byRun = new Map<string, string[]>()
    for (const name of names) {
      const m = /^(.+)\.log(?:\.\d+)?$/.exec(name)
      if (!m) continue
      const runId = m[1] as string
      const files = byRun.get(runId) ?? []
      files.push(path.join(dir, name))
      byRun.set(runId, files)
    }
    const summaries: RunSummary[] = []
    for (const [runId, files] of byRun) {
      let lastModifiedMs = 0
      for (const file of files) {
        try {
          lastModifiedMs = Math.max(lastModifiedMs, (await stat(file)).mtimeMs)
        } catch {
          // 文件刚被轮转/删除：跳过
        }
      }
      summaries.push({ runId, files: sortRunFiles(files), lastModifiedMs })
    }
    summaries.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs || (a.runId < b.runId ? 1 : -1))
    return summaries
  }

  /** 最新 run 的全部现存文件（旧→新）；无历史返回 [] */
  async latestRunFiles(projectId: string): Promise<string[]> {
    const latest = (await this.listRuns(projectId))[0]
    if (!latest) return []
    const existing: string[] = []
    for (const file of latest.files) {
      if (await fileSize(file) >= 0) existing.push(file)
    }
    return existing
  }

  /** 最新 run 尾部 lines 行（跨轮转文件按时间序拼接） */
  async readTail(projectId: string, lines: number): Promise<TailResult> {
    const latest = (await this.listRuns(projectId))[0]
    if (!latest) return { lines: [] }
    const collected: string[] = []
    // 新→旧回读，凑够 lines 即止（写入器整行落盘，文件边界即行边界）
    for (const file of [...latest.files].reverse()) {
      if (collected.length >= lines) break
      const text = await readFileTailText(file, lines - collected.length + 1)
      if (text.length > 0) collected.unshift(...text.split('\n'))
    }
    return { lines: collected.slice(-lines), runId: latest.runId }
  }

  /** 保留策略：每项目仅保留最近 runsToKeep 个 run（按 mtime），其余整组删除 */
  async cleanupProject(projectId: string): Promise<void> {
    const limits = this.opts.getLimits()
    const runs = await this.listRuns(projectId)
    const victims = runs.slice(Math.max(0, limits.runsToKeep))
    await Promise.all(
      victims.flatMap((run) => run.files.map((f) => unlink(f).catch(() => undefined)))
    )
  }
}

/**
 * 单 run 文件写入器：追加写 + 大小轮转。
 * append 经内部 promise 链串行化：轮转与追加交错时保持文件内容一致。
 */
export class RunLogWriter {
  private size = -1 // 惰性：首次 append 前探测（支持 run 中途接管已存在文件）
  private closed = false
  private dirReady = false
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly runId: string,
    private readonly getLimits: () => LogStoreLimits,
    private readonly onClosed: () => void
  ) {}

  private get base(): string {
    return path.join(this.dir, `${this.runId}.log`)
  }

  /** 追加整行批次（每行以 \n 落盘）；超限先轮转 */
  append(lines: string[]): Promise<void> {
    if (this.closed || lines.length === 0) return Promise.resolve()
    const run = async (): Promise<void> => {
      const data = Buffer.from(`${lines.join('\n')}\n`, 'utf8')
      const limits = this.getLimits()
      if (!this.dirReady) {
        await mkdir(this.dir, { recursive: true })
        this.dirReady = true
      }
      if (this.size < 0) this.size = await fileSize(this.base)
      if (this.size > 0 && this.size + data.length > limits.maxFileBytes) {
        await this.rotate(limits.maxRotations)
      }
      await appendFile(this.base, data)
      this.size += data.length
    }
    this.tail = this.tail.then(run, run)
    return this.tail
  }

  /** 关闭（幂等）；触发保留清理 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.onClosed()
  }

  /**
   * 等待已排队的追加全部落盘（P2-4，phase4 审查）：append 返回的 promise 常被
   * fire-and-forget 调用（批量 flush），退出路径必须经此显式排空——Electron quit
   * 不保证等待挂起的 fs 请求，不等则最后一批日志可能丢盘。
   */
  drain(): Promise<void> {
    return this.tail
  }

  /** 轮转：保留 .1…maxRotations 共 maxRotations 个轮转文件（base → .1，.1→.2…顺移，最旧删除） */
  private async rotate(maxRotations: number): Promise<void> {
    await unlink(`${this.base}.${maxRotations}`).catch(() => undefined)
    for (let i = maxRotations - 1; i >= 1; i -= 1) {
      await rename(`${this.base}.${i}`, `${this.base}.${i + 1}`).catch(() => undefined)
    }
    await rename(this.base, `${this.base}.1`).catch(() => undefined)
    this.size = 0
  }
}

/** 同一 run 的文件排序：旧→新（.N … .2 .1 当前；轮转号越大越旧） */
function sortRunFiles(files: string[]): string[] {
  const rotationKey = (f: string): number => {
    const m = /\.log\.(\d+)$/.exec(f)
    return m ? -Number(m[1]) : Number.MAX_SAFE_INTEGER // 当前文件最新（排末尾）
  }
  return [...files].sort((a, b) => rotationKey(a) - rotationKey(b))
}

/**
 * 读文件末尾文本（64KB 块反向读取，凑够 maxLines 行即止）。
 * 返回 utf8 文本（结尾换行符已剥；未读到文件头时起始残片行已丢弃）。
 * log-store 自有文件恒为 UTF-8 整行落盘，无需编码判定。
 */
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
  } catch {
    return '' // 读取失败按空处理（调用方跳过该文件）
  } finally {
    await handle?.close().catch(() => undefined)
  }
  const data = Buffer.concat(chunks)
  const firstNewline = data.indexOf(0x0a)
  // 未读到文件头且首段不以换行起始 → 首行为残片，丢弃
  const body = reachedStart || firstNewline === -1 ? data : data.subarray(firstNewline + 1)
  const text = body.toString('utf8')
  return text.endsWith('\n') ? text.slice(0, -1) : text
}
