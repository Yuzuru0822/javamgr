/**
 * stdout/stderr 管道捕获（计划 §2.3-C / §3 S4.2）。
 *
 * - 接 run:started 交付的 stdout/stderr 管道，**stderr 并流**（两个流各自的
 *   残行缓冲独立，避免半行互相黏连；解码器共享——同一进程输出同一编码，按 run 锁定）；
 * - 任意切分的字节 chunk → RunDecoder（F3 编码判定/转码）→ 文本级完整行切分，
 *   残行跨 chunk 缓冲；
 * - 流结束（进程退出/管道断开，'end'/'close'）时 flush 残行（半行也作为最后一行输出）；
 * - 行级回调给 log-manager（首行触发 markRunning 握手由 manager 侧处理）。
 *
 * 本模块零 electron 依赖（Readable 注入，单测可用 PassThrough 伪造）。
 */

import type { Readable } from 'node:stream'
import { DecodedLineFeeder, RunDecoder } from './encoding'

export interface StdoutCaptureOptions {
  /** 缺省的管道跳过（spawn 极端情况下 stdout/stderr 可为 null） */
  stdout?: Readable
  stderr?: Readable
  /** 本 run 共享解码器（由 log-manager 按 run 持有，实现"锁定后按 run 缓存"） */
  decoder: RunDecoder
  /** 完整行回调（stdout 与 stderr 并流后的行序即到达序） */
  onLines: (lines: string[]) => void
}

interface Attachment {
  stream: Readable
  feeder: DecodedLineFeeder
  onData: (chunk: Buffer | string) => void
  onDone: () => void
}

export class StdoutCapture {
  private readonly attachments: Attachment[] = []
  private started = false
  private disposed = false

  constructor(opts: StdoutCaptureOptions) {
    if (opts.stdout) this.attachLater(opts.stdout, opts.decoder, opts.onLines)
    if (opts.stderr) this.attachLater(opts.stderr, opts.decoder, opts.onLines)
  }

  private attachLater(stream: Readable, decoder: RunDecoder, onLines: (lines: string[]) => void): void {
    const feeder = new DecodedLineFeeder(decoder, onLines)
    const onData = (chunk: Buffer | string): void => {
      feeder.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
    }
    const onDone = (): void => {
      stream.removeListener('data', onData)
      feeder.flush() // 残行作为最后一行
    }
    this.attachments.push({ stream, feeder, onData, onDone })
  }

  /** 开始消费（挂 data 监听即进入流动模式；进程退出时流自然 end/close） */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    for (const a of this.attachments) {
      a.stream.on('data', a.onData)
      a.stream.once('end', a.onDone)
      a.stream.once('close', a.onDone)
    }
  }

  /** 停止消费并 flush 残行（进程 stop/退出时由 log-manager 调用；幂等） */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const a of this.attachments) {
      a.stream.removeListener('data', a.onData)
      a.stream.removeListener('end', a.onDone)
      a.stream.removeListener('close', a.onDone)
      a.feeder.flush()
    }
  }
}
