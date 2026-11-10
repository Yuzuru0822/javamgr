/**
 * 日志文件 tail + 轮转跟随（计划 §2.3-C / §3 S4.3，风险 R3/R10）。
 *
 * - 初始：读文件尾部 initialLines（默认 200）行（残片首行丢弃，末尾未完行入残行缓冲）；
 * - 跟随：**watch 文件所在目录**（Windows 下文件级 watch 在被替换/重命名时丢事件），
 *   按文件名过滤（大小写不敏感），变更时从上次 offset 增量读；
 * - 轮转检测三通道（任一触发恢复）：① 目录 rename 事件命中当前文件名 → 重开；
 *   ② size < 上次 offset（截断/重建）→ 重开从 0 读；③ pollIntervalMs（默认 2s）
 *   stat 轮询兜底（fs.watch 在部分盘符/网络盘不可靠）；
 * - 文件/目录尚不存在：watch 失败时仅靠轮询探测，出现后自动开始（等待创建）；
 * - 重开 = 重置解码器与残行缓冲（新文件从 0 读，编码独立判定，支持 GBK 文件——
 *   一切字节经 RunDecoder，UTF-8/GBK 均可正确解码）。
 *
 * 本模块零 electron 依赖。
 */

import { stat as statCb, watch } from 'node:fs'
import { open as openHandle, stat } from 'node:fs/promises'
import type { WatchListener } from 'node:fs'
import path from 'node:path'
import { DecodedLineFeeder, RunDecoder } from './encoding'

/** 反向读取块大小 */
const TAIL_BLOCK_BYTES = 64 * 1024

/** watch 事件合并窗口（rename+change 常成对爆发，避免重复 stat） */
const EVENT_COALESCE_MS = 25

export interface FileTailerOptions {
  filePath: string
  /** 初始回读行数（默认 200，settings.tailInitialLines） */
  initialLines?: number
  /** stat 兜底轮询间隔（默认 2000ms；单测可缩短加速） */
  pollIntervalMs?: number
  /** 项目级编码覆盖（utf8/gbk；缺省自动检测） */
  encodingOverride?: 'utf8' | 'gbk'
  /** 跟随期新增行回调（增量读 / 轮转新文件 / 残行补完） */
  onLines: (lines: string[]) => void
  /**
   * 初始尾部回读行回调（N-5：缺省并入 onLines）。提供时初始历史行走此通道——
   * log-manager 据此把"旧 run 的历史内容"与"本次启动的新增输出"分开，
   * markRunning 信号仅由跟随期新增行触发（历史不证明本次启动存活）。
   */
  onInitialLines?: (lines: string[]) => void
  onError?: (err: Error) => void
}

export class FileTailer {
  private readonly filePath: string
  private readonly dir: string
  private readonly base: string
  private readonly initialLines: number
  private readonly pollIntervalMs: number
  private readonly onLines: (lines: string[]) => void
  private readonly onInitialLines?: (lines: string[]) => void
  private readonly onError?: (err: Error) => void

  private readonly decoder: RunDecoder
  private readonly feeder: DecodedLineFeeder

  private offset = 0
  /** 上次成功读取的文件身份（ino 优先，mtime 兜底）：rename 事件的重开去重依据 */
  private lastIdentity: { ino: number; mtimeMs: number } | undefined
  private watcher: ReturnType<typeof watch> | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private coalesceTimer: NodeJS.Timeout | null = null
  private pendingForceReopen = false
  private watchListener: WatchListener<string> | null = null
  private stopped = false
  private checking = false
  /** 初始尾部回读进行中（feeder 同步回调据此把历史行路由到 onInitialLines，N-5） */
  private inInitialRead = false

  constructor(opts: FileTailerOptions) {
    this.filePath = opts.filePath
    this.dir = path.dirname(opts.filePath)
    this.base = path.basename(opts.filePath)
    this.initialLines = opts.initialLines ?? 200
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000
    this.onLines = opts.onLines
    this.onInitialLines = opts.onInitialLines
    this.onError = opts.onError
    this.decoder = new RunDecoder({ encodingOverride: opts.encodingOverride })
    this.feeder = new DecodedLineFeeder(this.decoder, (lines) => this.dispatchLines(lines))
  }

  /** feeder 行出口：初始回读的历史行 → onInitialLines（N-5）；其余 → onLines（跟随期新增） */
  private dispatchLines(lines: string[]): void {
    if (this.inInitialRead && this.onInitialLines) {
      this.onInitialLines(lines)
      return
    }
    this.onLines(lines)
  }

  /**
   * 启动：初始尾部 + 目录 watch + 轮询兜底（文件不存在则等待创建）。
   * P2-1（phase4 审查）：teardown/switchRoute 均以 `void tailer.stop()` 发起，与本
   * `void start()` 天然存在 await 交叠窗口——stat/初始读取恢复后必须复查 stopped，
   * 否则无条件 setInterval 会造出永远无人清理的孤儿定时器（空转至应用退出），
   * 且初始历史行会在 stop 之后补发到 onInitialLines。
   */
  async start(): Promise<void> {
    if (this.stopped) return
    try {
      const st = await this.statFile()
      if (this.stopped) return // await 窗口内已 stop：不补发初始历史行
      if (st && st.size > 0) {
        const { data, bytesRead, reachedStart } = await readTailBlocks(
          this.filePath,
          st.size,
          this.initialLines
        )
        // P2-1（phase4 审查）：初始读取 await 窗口内 stop() 已执行 → 不补发历史行
        if (this.stopped) return
        // 未读到文件头且首段不以换行起始 → 丢弃起始残片行（标准 tail 行为）
        const firstNewline = data.indexOf(0x0a)
        const body = reachedStart || firstNewline === -1 ? data : data.subarray(firstNewline + 1)
        // N-5：初始历史行走 onInitialLines 通道（feeder.push 同步回调，flag 包裹精准限定）
        this.inInitialRead = true
        try {
          this.feeder.push(clipToLastLines(body, this.initialLines))
        } finally {
          this.inInitialRead = false
        }
        this.offset = bytesRead
        this.lastIdentity = { ino: st.ino, mtimeMs: st.mtimeMs }
      } else {
        this.offset = 0
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)))
      this.offset = 0
    }
    // P2-1（phase4 审查）：初始读取 await 窗口内 stop() 可能已执行——复查后再挂
    // watch 与轮询定时器，绝不创建无人清理的孤儿 interval
    if (this.stopped) return
    this.tryWatch()
    this.pollTimer = setInterval(() => {
      void this.checkFile()
    }, this.pollIntervalMs)
  }

  /** 停止：关 watch/轮询，残行 flush（进程 stop/退出时由 log-manager 调用） */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer)
    this.pendingForceReopen = false
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.closeWatcher()
    this.feeder.flush()
  }

  // ---------- 事件 → 状态检查 ----------

  private tryWatch(): void {
    if (this.stopped || this.watcher) return
    try {
      this.watchListener = (event, filename) => {
        // 目录级事件按文件名过滤（大小写不敏感，Windows 盘符/大小写现实）
        if (typeof filename !== 'string') return void this.scheduleCheck(false)
        if (filename.toLowerCase() !== this.base.toLowerCase()) return
        // ① rename 命中当前文件名 → 强制重开（轮转 rename 走后/同名新建；
        //    即使 rename+recreate 在事件处理前已完成，也从 0 读，避免把
        //    "整文件替换"误判为 append 读出半个行）
        this.scheduleCheck(event === 'rename')
      }
      this.watcher = watch(this.dir, this.watchListener)
      this.watcher.on('error', () => this.closeWatcher()) // 出错降级为纯轮询
    } catch {
      this.watcher = null // 目录不存在等：仅靠轮询（等待目录/文件出现后由 checkFile 补挂）
    }
  }

  private closeWatcher(): void {
    this.watcher?.close()
    this.watcher = null
    this.watchListener = null
  }

  private scheduleCheck(forceReopen: boolean): void {
    if (this.stopped) return
    this.pendingForceReopen = this.pendingForceReopen || forceReopen
    if (this.coalesceTimer) return
    this.coalesceTimer = setTimeout(() => {
      const reopen = this.pendingForceReopen
      this.pendingForceReopen = false
      this.coalesceTimer = null
      void this.checkFile(reopen)
    }, EVENT_COALESCE_MS)
  }

  /**
   * 三通道汇合点：stat 比对 offset 与文件身份，识别增量/轮转/截断/创建。
   * rename 事件强制重开仅当文件身份变化（ino/mtime 与上次读取不同）——
   * 既覆盖"rename+recreate 在事件处理前完成"的轮转竞态（新文件不同身份），
   * 也避免 Windows 目录 watch 的重复 rename 事件造成同文件重读（重复行）。
   */
  private async checkFile(forceReopen = false): Promise<void> {
    if (this.stopped || this.checking) return
    this.checking = true
    try {
      const st = await this.statFile()
      // P3-2（phase4 审查）：stat await 窗口内 stop() 已执行 → 立即退出，不再读取/
      // 推送（否则旧 tailer 停止后仍可能补推一行重复内容，且经 log-manager 会被
      // 标上切换后的新路由 source——P3-1 的错标窗口正在此处）
      if (this.stopped) return
      if (!st) {
        // 文件不存在：logback 轮转 rename 走后 / 尚未创建 → 重置游标等待新文件
        if (this.offset !== 0 || this.lastIdentity !== undefined) this.reopen()
        return
      }
      if (this.watcher === null) this.tryWatch() // 目录出现后补挂 watch
      const identityChanged = !this.sameAsLast(st)
      if (st.size < this.offset || (forceReopen && identityChanged)) {
        // ② 截断/重建（size < offset）/ ① rename 命中且文件身份已变：从 0 重读
        this.reopen()
      }
      if (st.size > this.offset) {
        await this.readIncrement(st)
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)))
    } finally {
      this.checking = false
    }
  }

  /** 轮转/截断重开：游标归零 + 解码器与残行缓冲重置（新文件编码独立判定） */
  private reopen(): void {
    this.offset = 0
    this.lastIdentity = undefined
    this.feeder.reset()
    this.decoder.reset()
  }

  private sameAsLast(st: { ino: number; mtimeMs: number }): boolean {
    if (!this.lastIdentity) return false
    if (st.ino !== 0 && this.lastIdentity.ino !== 0) {
      return st.ino === this.lastIdentity.ino
    }
    return st.mtimeMs === this.lastIdentity.mtimeMs
  }

  private async readIncrement(st: { size: number; ino: number; mtimeMs: number }): Promise<void> {
    const length = st.size - this.offset
    if (length <= 0) return
    const chunk = Buffer.alloc(length)
    const handle = await openHandle(this.filePath, 'r')
    try {
      const { bytesRead } = await handle.read(chunk, 0, length, this.offset)
      this.offset += bytesRead
      // P3-2（phase4 审查）：读取 await 窗口内 stop() → 不再推送（停止后不得补发行）
      if (bytesRead > 0 && !this.stopped) this.feeder.push(chunk.subarray(0, bytesRead))
      this.lastIdentity = { ino: st.ino, mtimeMs: st.mtimeMs }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  private statFile(): Promise<{ size: number; ino: number; mtimeMs: number } | null> {
    return new Promise((resolve) => {
      statCb(this.filePath, (err, st) => {
        resolve(err || !st ? null : { size: st.size, ino: st.ino, mtimeMs: st.mtimeMs })
      })
    })
  }
}

// ==================== 共享尾部读取工具 ====================

/**
 * 截取 buffer 使其至多包含最后 maxLines 个换行行（保留末尾可能无换行的残行字节）。
 * 反向扫换行定位倒数第 maxLines+1 个 \n，截掉其及之前内容。
 */
function clipToLastLines(buffer: Buffer, maxLines: number): Buffer {
  let newlineCount = 0
  for (let i = buffer.length - 1; i >= 0; i -= 1) {
    if (buffer[i] !== 0x0a) continue
    newlineCount += 1
    if (newlineCount === maxLines + 1) return buffer.subarray(i + 1)
  }
  return buffer
}

interface TailRead {
  data: Buffer
  /** 实际覆盖到的文件末尾偏移（= 读取时的 size 上界，作为后续增量起点） */
  bytesRead: number
  /** 是否读到文件头（data 起始于 0） */
  reachedStart: boolean
}

/**
 * 反向分块读取文件尾部，凑够 maxLines 行（多读 1 行作残片冗余）即止。
 */
async function readTailBlocks(file: string, size: number, maxLines: number): Promise<TailRead> {
  const chunks: Buffer[] = []
  let position = size
  let newlines = 0
  const handle = await openHandle(file, 'r')
  try {
    while (position > 0 && newlines <= maxLines) {
      const readSize = Math.min(TAIL_BLOCK_BYTES, position)
      position -= readSize
      const chunk = Buffer.alloc(readSize)
      await handle.read(chunk, 0, readSize, position)
      chunks.unshift(chunk)
      newlines += chunk.filter((b) => b === 0x0a).length
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
  return { data: Buffer.concat(chunks), bytesRead: size, reachedStart: position === 0 }
}

/**
 * 独立文件尾部读取（log-manager readHistory 的 file 路用）：
 * 返回最后 maxLines 个完整行（经 RunDecoder 解码，支持 GBK；末尾未完行也作为一行输出）。
 */
export async function tailFileLines(
  filePath: string,
  maxLines: number,
  encodingOverride?: 'utf8' | 'gbk'
): Promise<string[]> {
  const collected: string[] = []
  const decoder = new RunDecoder({ encodingOverride })
  const feeder = new DecodedLineFeeder(decoder, (lines) => collected.push(...lines))
  try {
    const size = (await stat(filePath)).size
    if (size <= 0) return []
    const { data, reachedStart } = await readTailBlocks(filePath, size, maxLines)
    // 丢弃起始残片（未读到文件头且首段不以换行起始）
    const firstNewline = data.indexOf(0x0a)
    const body = reachedStart || firstNewline === -1 ? data : data.subarray(firstNewline + 1)
    feeder.push(body)
  } catch {
    return [] // 文件不存在/不可读：空
  }
  feeder.flush()
  return collected.slice(-maxLines)
}
