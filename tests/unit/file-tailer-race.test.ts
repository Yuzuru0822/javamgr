import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileTailer } from '../../src/main/log/file-tailer'

/**
 * file-tailer 启停竞态单测（P2-1 / P3-2，phase4 审查）。
 *
 * 竞态窗口在真实 fs 上只有微秒级，无法稳定触发——本文件用 vi.mock 延迟 node:fs 的
 * stat 回调（statDelay.ms 可控），把 start()/checkFile() 的 await 窗口拉宽到确定可
 * 交叠的 80ms，再用 stop() 在窗口内执行，断言恢复后的行为（不建孤儿 interval /
 * 不补发行）。node:fs/promises（读写文件用）不经 mock，测试数据写入真实 fs。
 */

const statDelay = vi.hoisted(() => ({ ms: 0 }))
const openDelay = vi.hoisted(() => ({ ms: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    // 仅延迟 stat 回调：statFile() 的 Promise 完成被推迟 statDelay.ms，
    // start()/checkFile() 停在 await this.statFile() 的时间可控
    stat: ((
      target: string,
      cb: (err: NodeJS.ErrnoException | null, st: import('node:fs').Stats) => void
    ) => {
      if (statDelay.ms <= 0) return actual.stat(target, cb)
      setTimeout(() => actual.stat(target, cb), statDelay.ms)
    }) as typeof actual.stat
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    // 仅延迟文件句柄 open：readTailBlocks/readIncrement 停在 openHandle 的时间可控
    // （测试自身的 writeFile/appendFile 等不经此路径，不受影响）
    open: (async (target: string, flags?: string | number) => {
      if (openDelay.ms > 0) await new Promise((r) => setTimeout(r, openDelay.ms))
      return actual.open(target, flags)
    }) as typeof actual.open
  }
})

let baseDir: string

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-tailer-race-'))
})

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('P2-1：start() 的 stat await 窗口内 stop()', () => {
  it('恢复后不得创建轮询 interval（孤儿定时器）也不得补发初始历史行', async () => {
    const dir = path.join(baseDir, 'p21')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'app.log')
    await writeFile(file, 'seed-1\nseed-2\n', 'utf8')

    const initialLines: string[] = []
    const followLines: string[] = []
    const tailer = new FileTailer({
      filePath: file,
      initialLines: 200,
      pollIntervalMs: 100,
      onLines: (ls) => followLines.push(...ls),
      onInitialLines: (ls) => initialLines.push(...ls)
    })

    statDelay.ms = 80
    try {
      const starting = tailer.start()
      await sleep(20) // start() 停在 statFile await（80ms 窗口）
      await tailer.stop() // 窗口内 stop：pollTimer 此刻为 null，被清的是"还没有的"定时器
      await starting // start() 恢复——旧实现将无条件 setInterval 且永不清理
      await sleep(60)

      // 无孤儿 interval：pollTimer 从未被赋值（旧实现此处是一个无人清理的 Timeout）
      expect((tailer as unknown as { pollTimer: NodeJS.Timeout | null }).pollTimer).toBeNull()
      // 初始历史行不得在 stop 之后补发
      expect(initialLines).toEqual([])
      expect(followLines).toEqual([])
    } finally {
      statDelay.ms = 0
      await tailer.stop()
    }
  })

  it('stop 落在初始读取（readTailBlocks）窗口内 → 同样不建 interval、不补发历史行', async () => {
    const dir = path.join(baseDir, 'p21b')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'app.log')
    await writeFile(file, 'seed-1\nseed-2\n', 'utf8')

    const initialLines: string[] = []
    const tailer = new FileTailer({
      filePath: file,
      initialLines: 200,
      pollIntervalMs: 100,
      onLines: () => {},
      onInitialLines: (ls) => initialLines.push(...ls)
    })

    openDelay.ms = 80 // stat 即时完成、初始读取的 open 被拉宽
    try {
      const starting = tailer.start()
      await sleep(20) // start() 已过 statFile，停在 readTailBlocks 的 open await
      await tailer.stop()
      await starting
      await sleep(60)

      expect((tailer as unknown as { pollTimer: NodeJS.Timeout | null }).pollTimer).toBeNull()
      expect(initialLines).toEqual([]) // 历史行不得越过 stop 补发
    } finally {
      openDelay.ms = 0
      await tailer.stop()
    }
  })
})

describe('P3-2：checkFile() 的 stat await 窗口内 stop()', () => {
  it('恢复后不得再推送行（停止后无重复/错标 source 的补推）', async () => {
    const dir = path.join(baseDir, 'p32')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'app.log')
    await writeFile(file, 'a-1\n', 'utf8')

    const lines: string[] = []
    const tailer = new FileTailer({
      filePath: file,
      initialLines: 200,
      pollIntervalMs: 2_000, // 轮询兜底不介入：本用例直接驱动 checkFile
      onLines: (ls) => lines.push(...ls)
    })
    await tailer.start()
    expect(lines).toEqual(['a-1']) // 初始 tail 完成（无延迟路径）

    statDelay.ms = 80
    try {
      await appendFile(file, 'late-1\n', 'utf8')
      // 直接触发一次检查（与 watch/轮询殊途同归的内部入口），停在 stat await
      const checking = (
        tailer as unknown as { checkFile(): Promise<void> }
      ).checkFile()
      await sleep(20)
      await tailer.stop() // stat 窗口内停止
      await checking // 恢复：旧实现会继续 readIncrement 并补推 'late-1'
      await sleep(60)
      expect(lines).toEqual(['a-1']) // 停止后零补推
    } finally {
      statDelay.ms = 0
      await tailer.stop()
    }
  })
})
