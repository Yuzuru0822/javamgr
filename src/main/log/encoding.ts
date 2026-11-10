/**
 * stdout/日志文件编码判定与解码（计划 §2.3-C / §3 S4.1，F3 决议，风险 R2）。
 *
 * F3 算法（判定时机：非 ASCII 出现后才锁定）：
 * 1. BOM（UTF-8 EF BB BF / UTF-16LE FF FE）命中即定编码（流首最多缓冲 3 字节判定）；
 * 2. 无 BOM 时，纯 ASCII 字节段**不判定也不缓存结果**——ASCII 是 UTF-8 与 GBK 的
 *    公共子集，两种编码下行为一致，直接透传（仅保留 ≤4KB 尾部上下文供后续校验窗口用）；
 * 3. 首个非 ASCII 序列出现时，以**其所在完整字节行**为界（等待行尾 \n；UTF-8/GBK
 *    多字节序列中均不出现 0x0A，字节级行界安全），取该行连同前缀 ≤4KB 缓冲做严格
 *    UTF-8 校验（TextDecoder('utf-8',{fatal:true}) 试整段）：成功→锁定 UTF-8、
 *    失败→锁定 GBK（iconv-lite）。典型场景：GBK 程序首行纯 ASCII banner（logback
 *    初始化/Spring 横幅）不会误锁 UTF-8；
 * 4. 锁定后按 run 缓存（runId 键，由 log-manager 持有 RunDecoder 实例实现），后续
 *    chunk 一律按锁定编码流式转码（跨 chunk 撕裂的多字节序列由流式解码器缓冲）；
 * 5. 项目级 encodingOverride（utf8/gbk）覆盖即跳过自动判定（构造即锁定）。
 *
 * 本模块零 electron 依赖。
 */

import * as iconv from 'iconv-lite'

/** 锁定后的编码 */
export type LockedEncoding = 'utf8' | 'gbk' | 'utf16le'

/** F3 校验窗口大小：完整行 + 前缀上下文合计 ≤4KB */
const VALIDATE_WINDOW_BYTES = 4 * 1024

/** 单行无换行时的强制判定阈值（超长行防御，>4KB 无 \n 时截尾校验） */
const FORCE_DECIDE_BYTES = 4 * 1024

export interface RunDecoderOptions {
  /** 项目级编码覆盖（utf8/gbk 即跳过自动判定；auto/缺省 = 自动检测） */
  encodingOverride?: 'utf8' | 'gbk'
}

/** TextDecoder 实例最小面（@types/node 将 TextDecoder 声明为值，类型侧以此解耦） */
interface StreamTextDecoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string
}

/**
 * 单 run（或单 tail 会话）的解码状态机。
 * push() 输入任意切分的字节 chunk，返回当前已可输出的解码文本（可能含 \n，也可能为空
 * ——判定等待完整行期间会暂扣输出）。流结束时调用 flush() 取残余。
 */
export class RunDecoder {
  private locked: LockedEncoding | undefined
  /** 锁定 utf8 后的流式解码器（stream 模式跨 chunk 缓冲撕裂的多字节序列） */
  private utf8Stream: StreamTextDecoder | undefined
  private utf16Stream: StreamTextDecoder | undefined
  /** 锁定 gbk 后的流式解码器（iconv getDecoder 内部缓冲不完整双字节序列） */
  private gbkStream: iconv.DecoderStream | undefined

  // ---------- 检测期状态 ----------
  /** 流首 BOM 判定缓冲（≤3 字节） */
  private bomBuf: Buffer = Buffer.alloc(0)
  private bomDecided = false
  /** 未锁定期间的 ASCII 尾部上下文（≤4KB，仅作校验窗口前缀） */
  private asciiTail: Buffer = Buffer.alloc(0)
  /** 自首个非 ASCII 字节起暂扣的字节（等待行尾 \n） */
  private held: Buffer = Buffer.alloc(0)
  private holding = false

  constructor(opts: RunDecoderOptions = {}) {
    if (opts.encodingOverride === 'utf8' || opts.encodingOverride === 'gbk') {
      this.lockNow(opts.encodingOverride) // 覆盖逃生口：跳过自动判定
    }
  }

  /** 当前锁定编码（未锁定 = undefined；纯 ASCII 段保持未锁定即 F3 "不判定不缓存"） */
  getEncoding(): LockedEncoding | undefined {
    return this.locked
  }

  isLocked(): boolean {
    return this.locked !== undefined
  }

  /** 喂入一个字节 chunk，返回可输出的解码文本 */
  push(chunk: Buffer): string {
    if (chunk.length === 0) return ''
    if (this.locked) return this.decodeLocked(chunk)

    // ---- BOM 判定（仅流首；凑满 3 字节或可排除即放行） ----
    if (!this.bomDecided) {
      this.bomBuf = Buffer.concat([this.bomBuf, chunk])
      if (this.bomBuf.length < 2) return ''
      // UTF-8 BOM 需要 3 字节：EF BB 前缀且未满 3 字节时继续等
      if (this.bomBuf.length === 2 && this.bomBuf[0] === 0xef && this.bomBuf[1] === 0xbb) {
        return ''
      }
      this.bomDecided = true
      if (this.bomBuf[0] === 0xff && this.bomBuf[1] === 0xfe) {
        this.lockNow('utf16le')
        const rest = this.bomBuf.subarray(2)
        this.bomBuf = Buffer.alloc(0)
        return rest.length > 0 ? this.decodeLocked(rest) : ''
      }
      if (
        this.bomBuf.length >= 3 &&
        this.bomBuf[0] === 0xef &&
        this.bomBuf[1] === 0xbb &&
        this.bomBuf[2] === 0xbf
      ) {
        this.lockNow('utf8')
        const rest = this.bomBuf.subarray(3)
        this.bomBuf = Buffer.alloc(0)
        return rest.length > 0 ? this.decodeLocked(rest) : ''
      }
      // 非 BOM：整段转入检测流程
      const data = this.bomBuf
      this.bomBuf = Buffer.alloc(0)
      return this.detect(data)
    }
    return this.detect(chunk)
  }

  /** 流结束：排空流式解码器；检测期仍持有未锁字节时就地强制判定（无行尾容忍） */
  flush(): string {
    if (this.locked) {
      const tail = this.gbkStream?.end()
      return tail ?? ''
    }
    if (this.holding && this.held.length > 0) {
      return this.forceDecide()
    }
    return ''
  }

  /** 重置为全新状态（文件 tailer 轮转重开时复用实例） */
  reset(): void {
    this.locked = undefined
    this.utf8Stream = undefined
    this.utf16Stream = undefined
    this.gbkStream = undefined
    this.bomBuf = Buffer.alloc(0)
    this.bomDecided = false
    this.asciiTail = Buffer.alloc(0)
    this.held = Buffer.alloc(0)
    this.holding = false
  }

  // ---------- 检测期 ----------

  private detect(chunk: Buffer): string {
    if (this.holding) {
      // 已在暂扣中：追加后找行尾
      this.held = Buffer.concat([this.held, chunk])
      return this.drainHeld()
    }
    const firstNonAscii = chunk.findIndex((b) => b >= 0x80)
    if (firstNonAscii === -1) {
      // 纯 ASCII 段：直接透传，不判定不缓存（仅留 ≤4KB 尾部上下文）
      this.asciiTail = keepTail(this.asciiTail, chunk, VALIDATE_WINDOW_BYTES)
      return chunk.toString('utf8') // ASCII 下 utf8 与 latin1 结果一致
    }
    const asciiPart = chunk.subarray(0, firstNonAscii)
    const rest = chunk.subarray(firstNonAscii)
    this.asciiTail = keepTail(this.asciiTail, asciiPart, VALIDATE_WINDOW_BYTES)
    this.holding = true
    this.held = rest
    const emitted = asciiPart.length > 0 ? asciiPart.toString('utf8') : ''
    return emitted + this.drainHeld()
  }

  /** 暂扣字节中找完整行并触发锁定；返回可输出文本 */
  private drainHeld(): string {
    const held = this.held
    const newlineIdx = held.indexOf(0x0a)
    if (newlineIdx === -1) {
      return held.length >= FORCE_DECIDE_BYTES ? this.forceDecide() : '' // 等待行尾 \n
    }
    const line = held.subarray(0, newlineIdx + 1) // 含行尾
    const after = held.subarray(newlineIdx + 1)
    const window = clipWindow(Buffer.concat([this.asciiTail, line]))
    const enc = this.validateUtf8(window) ? 'utf8' : 'gbk'
    this.lockNow(enc)
    return this.decodeLocked(line) + this.decodeLocked(after)
  }

  /**
   * 无行尾时的强制判定（流结束/超长行）：截到安全边界（剥离可能撕裂多字节序列的
   * 尾部字节）校验锁定；held 全量按锁定编码解码输出，不丢字节。
   */
  private forceDecide(): string {
    const held = this.held
    const window = clipWindow(trimPossibleIncompleteTail(Buffer.concat([this.asciiTail, held])))
    const enc = this.validateUtf8(window) ? 'utf8' : 'gbk'
    const consumed = Math.max(0, window.length - this.asciiTail.length) // held 中参与校验的字节数
    this.lockNow(enc)
    return this.decodeLocked(held.subarray(0, consumed)) + this.decodeLocked(held.subarray(consumed))
  }

  // ---------- 锁定后 ----------

  private lockNow(enc: LockedEncoding): void {
    this.locked = enc
    this.asciiTail = Buffer.alloc(0)
    this.held = Buffer.alloc(0)
    this.holding = false
    if (enc === 'utf8') this.utf8Stream = new TextDecoder('utf-8')
    else if (enc === 'utf16le') this.utf16Stream = new TextDecoder('utf-16le')
    else this.gbkStream = iconv.getDecoder('gbk')
  }

  private decodeLocked(chunk: Buffer): string {
    if (chunk.length === 0) return ''
    if (this.locked === 'utf8' && this.utf8Stream) {
      return this.utf8Stream.decode(chunk, { stream: true })
    }
    if (this.locked === 'utf16le' && this.utf16Stream) {
      return this.utf16Stream.decode(chunk, { stream: true })
    }
    if (this.locked === 'gbk' && this.gbkStream) {
      return this.gbkStream.write(chunk)
    }
    return chunk.toString('utf8')
  }

  /** 严格 UTF-8 校验（fatal：任何非法序列抛出） */
  private validateUtf8(window: Buffer): boolean {
    try {
      strictUtf8.decode(window)
      return true
    } catch {
      return false
    }
  }
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** 保留 a+b 的末尾 ≤max 字节 */
function keepTail(a: Buffer, b: Buffer, max: number): Buffer {
  const merged = Buffer.concat([a, b])
  return merged.length <= max ? merged : merged.subarray(merged.length - max)
}

/** 校验窗口截取：保留末尾 ≤VALIDATE_WINDOW_BYTES 字节 */
function clipWindow(window: Buffer): Buffer {
  return window.length <= VALIDATE_WINDOW_BYTES
    ? window
    : window.subarray(window.length - VALIDATE_WINDOW_BYTES)
}

/**
 * 剥离末尾可能撕裂多字节序列的字节（≤3 个 ≥0x80 的尾部字节），保证截断窗口
 * 不因半个字符误判 GBK。仅在无行尾的强制判定路径使用。
 */
function trimPossibleIncompleteTail(buf: Buffer): Buffer {
  let end = buf.length
  let stripped = 0
  while (end > 0 && stripped < 3 && buf[end - 1] >= 0x80) {
    end -= 1
    stripped += 1
  }
  return end === buf.length ? buf : buf.subarray(0, end)
}

// ==================== DecodedLineFeeder ====================

/**
 * 解码后的按行装配器：原始字节 chunk → RunDecoder → 文本 → 完整行切分。
 * stdout-capture 与 file-tailer 共用；残行（无 \n 结尾的尾部文本）跨 chunk 缓冲，
 * flush() 在流/会话结束时把残余作为最后一行输出（残行 flush 要求）。
 */
export class DecodedLineFeeder {
  private pendingText = ''
  private ended = false

  constructor(
    private readonly decoder: RunDecoder,
    private readonly onLines: (lines: string[]) => void
  ) {}

  /** 喂入原始字节 chunk；切出的完整行立即回调（\r\n 与 \n 均按行尾处理） */
  push(chunk: Buffer): void {
    if (this.ended || chunk.length === 0) return
    this.pendingText += this.decoder.push(chunk)
    this.emitComplete()
  }

  /** 流结束：解码器残余 + 残行作为最后一行输出（仅一次） */
  flush(): void {
    if (this.ended) return
    this.ended = true
    const tail = this.decoder.flush()
    if (tail) this.pendingText += tail
    if (this.pendingText.length > 0) {
      const line = stripCR(this.pendingText)
      this.pendingText = ''
      if (line.length > 0) this.onLines([line])
    }
  }

  /** 清空残行（tailer 轮转重开时与 decoder.reset() 配套；旧文件的半个行不带入新文件） */
  reset(): void {
    this.pendingText = ''
  }

  private emitComplete(): void {
    const lastNewline = this.pendingText.lastIndexOf('\n')
    if (lastNewline === -1) return
    const complete = this.pendingText.slice(0, lastNewline)
    this.pendingText = this.pendingText.slice(lastNewline + 1)
    const lines = complete.split('\n').map(stripCR)
    if (lines.length > 0) this.onLines(lines)
  }
}

function stripCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}
