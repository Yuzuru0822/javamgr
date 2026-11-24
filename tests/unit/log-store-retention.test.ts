import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LogStore } from '../../src/main/log/log-store'
import type { LogStoreLimits } from '../../src/main/log/log-store'

let baseDir: string
let logsDir: string

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-logstore-retention-'))
  logsDir = path.join(baseDir, 'logs')
})

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

function limits(patch: Partial<LogStoreLimits> = {}): LogStoreLimits {
  return {
    maxFileBytes: 1024 * 1024,
    maxRotations: 3,
    runsToKeep: 10,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    maxTotalBytes: 512 * 1024 * 1024,
    ...patch
  }
}

async function put(
  projectId: string,
  runId: string,
  content: string,
  mtimeMs: number,
  suffix = '',
  root = logsDir
): Promise<string> {
  const dir = path.join(root, projectId)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${runId}.log${suffix}`)
  await writeFile(file, content)
  const date = new Date(mtimeMs)
  await utimes(file, date, date)
  return file
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}

describe('LogStore：超龄与活动 run 保护', () => {
  it('mtime 等于 cutoff 的非活动 run 被清理，同龄活动 run 保留', async () => {
    const now = Date.parse('2026-11-24T00:00:00.000Z')
    const cutoff = now - 7 * 24 * 60 * 60 * 1000
    const store = new LogStore({ logsDir, getLimits: () => limits(), now: () => now })
    const expired = await put('p-age', 'run-expired', 'expired\n', cutoff)
    const fresh = await put('p-age', 'run-fresh', 'fresh\n', now - 1000)
    const activeWriter = store.openRun('p-active', 'run-active')
    await activeWriter.append(['active'])
    const active = path.join(logsDir, 'p-active', 'run-active.log')
    const date = new Date(cutoff)
    await utimes(active, date, date)

    const result = await store.cleanup('current')
    expect(await exists(expired)).toBe(false)
    expect(await exists(fresh)).toBe(true)
    expect(await exists(active)).toBe(true)
    expect(result.activeBytes).toBeGreaterThan(0)
    expect(result.freedBytes).toBe(Buffer.byteLength('expired\n'))

    await activeWriter.close()
    expect(await exists(active)).toBe(false)
    expect(await exists(fresh)).toBe(true)
  })
})

describe('LogStore：全局目标容量', () => {
  it('跨项目最旧非活动 run 优先整组回收；只剩活动时允许高于目标', async () => {
    const now = Date.parse('2026-11-24T00:00:00.000Z')
    const root = path.join(baseDir, 'quota')
    const old = path.join(root, 'p-old')
    const fresh = path.join(root, 'p-fresh')
    await mkdir(old, { recursive: true })
    await mkdir(fresh, { recursive: true })
    await writeFile(path.join(old, 'run-old.log'), 'x'.repeat(50))
    await writeFile(path.join(fresh, 'run-fresh.log'), 'y'.repeat(50))
    const oldDate = new Date(now - 3000)
    const freshDate = new Date(now - 2000)
    await utimes(path.join(old, 'run-old.log'), oldDate, oldDate)
    await utimes(path.join(fresh, 'run-fresh.log'), freshDate, freshDate)
    const store = new LogStore({
      logsDir: root,
      getLimits: () => limits({ maxTotalBytes: 1 }),
      now: () => now
    })
    const activeWriter = store.openRun('p-quota-active', 'run-active')
    await activeWriter.append(['z'.repeat(50)])

    const result = await store.cleanup('current')
    expect(result.remainingBytes).toBe(result.activeBytes)
    expect(result.remainingBytes).toBeGreaterThan(1)
    expect(await exists(path.join(old, 'run-old.log'))).toBe(false)
    expect(await exists(path.join(fresh, 'run-fresh.log'))).toBe(false)
    expect(await exists(path.join(root, 'p-quota-active', 'run-active.log'))).toBe(true)
    await activeWriter.close()
  })
})

describe('LogStore：轮转降配与安全文件边界', () => {
  it('清理非活动 run 的多余高后缀；未知日志、文件和项目目录不动', async () => {
    const root = path.join(baseDir, 'rotations')
    const now = Date.now()
    const files = [
      await put('p-rotate', 'run-high', 'base', now, '', root),
      await put('p-rotate', 'run-high', 'one', now, '.1', root),
      await put('p-rotate', 'run-high', 'two', now, '.2', root)
    ]
    const high3 = await put('p-rotate', 'run-high', 'three', now, '.3', root)
    const high8 = await put('p-rotate', 'run-high', 'eight', now, '.8', root)
    const unknownLog = await put('p-rotate', 'custom', 'user owned', now, '', root)
    const unknownDirFile = await put('other', 'run-other', 'unknown project', now, '', root)
    const store = new LogStore({ logsDir: root, getLimits: () => limits({ maxRotations: 2 }) })

    const result = await store.cleanup('current')
    expect(result.deletedFiles).toBe(2)
    expect(result.freedBytes).toBe(Buffer.byteLength('three') + Buffer.byteLength('eight'))
    expect(await exists(high3)).toBe(false)
    expect(await exists(high8)).toBe(false)
    expect(await exists(unknownLog)).toBe(true)
    expect(await exists(unknownDirFile)).toBe(true)
    for (const file of files) expect(await exists(file)).toBe(true)
  })

  it('.rotating 残留按较新 base 读取，常规后缀清理不得误删', async () => {
    const root = path.join(baseDir, 'rotating-residue')
    const older = await put('p-residue', 'run-residue', 'older-rotation\n', Date.now(), '.1', root)
    const rotating = await put(
      'p-residue',
      'run-residue',
      'newest-base\n',
      Date.now(),
      '.rotating',
      root
    )
    const store = new LogStore({ logsDir: root, getLimits: () => limits() })
    const tail = await store.readTail('p-residue', 10)
    expect(tail.lines).toEqual(['older-rotation', 'newest-base'])

    const result = await store.cleanup('current')
    expect(result.deletedFiles).toBe(0)
    expect(await exists(older)).toBe(true)
    expect(await exists(rotating)).toBe(true)
  })

  it('base 与 rotating 并存时读取顺序仍为 .1 → rotating → base', async () => {
    const root = path.join(baseDir, 'rotating-with-base')
    await put('p-order', 'run-order', 'one-oldest\n', Date.now(), '.1', root)
    await put('p-order', 'run-order', 'two-recovered\n', Date.now(), '.rotating', root)
    await put('p-order', 'run-order', 'three-current\n', Date.now(), '', root)
    const store = new LogStore({ logsDir: root, getLimits: () => limits() })
    expect((await store.readTail('p-order', 10)).lines).toEqual([
      'one-oldest',
      'two-recovered',
      'three-current'
    ])
    expect((await store.readTail('p-order', 1)).lines).toEqual(['three-current'])
  })

  it('未提交 retiring 不参与常规后缀清理，只能随后续恢复或整 run 回收', async () => {
    const root = path.join(baseDir, 'retiring-residue')
    const base = await put('p-retiring', 'run-retiring', 'base\n', Date.now(), '', root)
    const one = await put('p-retiring', 'run-retiring', 'one\n', Date.now(), '.1', root)
    const two = await put('p-retiring', 'run-retiring', 'two\n', Date.now(), '.2', root)
    const retiring = await put(
      'p-retiring',
      'run-retiring',
      'three-oldest\n',
      Date.now(),
      '.retiring',
      root
    )
    const store = new LogStore({ logsDir: root, getLimits: () => limits({ maxRotations: 3 }) })
    const result = await store.cleanup('current')
    expect(result.deletedFiles).toBe(0)
    for (const file of [base, one, two, retiring]) expect(await exists(file)).toBe(true)
  })

  it('legacyDefault 仅在专用实例（allowPurge）上全量清理自有日志，活动项仍保护', async () => {
    const root = path.join(baseDir, 'legacy')
    const store = new LogStore({ logsDir: root, getLimits: () => limits(), allowPurge: true })
    const writer = store.openRun('p-legacy', 'run-active')
    await writer.append(['active'])
    const inactive = await put('p-legacy', 'run-inactive', 'inactive', Date.now(), '', root)
    const unknown = await put('p-legacy', 'custom', 'unknown', Date.now(), '', root)
    const result = await store.cleanup('legacyDefault')
    expect(result.deletedFiles).toBe(1)
    expect(await exists(inactive)).toBe(false)
    expect(await exists(unknown)).toBe(true)
    expect(await exists(path.join(root, 'p-legacy', 'run-active.log'))).toBe(true)
    await writer.close()
  })

  it('并发触发共用同一 single-flight Promise，并等待 dirty 重跑完成', async () => {
    const store = new LogStore({ logsDir: path.join(baseDir, 'single-flight'), getLimits: () => limits() })
    const first = store.cleanup('current')
    const second = store.cleanup('current')
    expect(second).toBe(first)
    const [a, b] = await Promise.all([first, second])
    expect(a.cleanedAt).toBe(b.cleanedAt)
  })

  it('当前目录实例收到 legacyDefault 请求会明确拒绝，不以全删名义执行保留清理', async () => {
    const root = path.join(baseDir, 'scope-guard')
    const keep = await put('p-guard', 'run-keep', 'keep\n', Date.now(), '', root)
    const store = new LogStore({ logsDir: root, getLimits: () => limits() })
    await expect(store.cleanup('legacyDefault')).rejects.toThrow('不允许 legacyDefault')
    expect(await exists(keep)).toBe(true)
  })
})

describe('LogStore：保留配额口径', () => {
  it('活动 run 不占用 runsToKeep 配额：仍保留最近 N 个历史 run', async () => {
    const root = path.join(baseDir, 'quota-count')
    const now = Date.now()
    const oldHistory = await put('p-count', 'run-old-history', 'old-history\n', now - 3000, '', root)
    const newHistory = await put('p-count', 'run-new-history', 'new-history\n', now - 2000, '', root)
    const store = new LogStore({
      logsDir: root,
      getLimits: () => limits({ runsToKeep: 1, retentionMs: 60_000 })
    })
    const activeWriter = store.openRun('p-count', 'run-active')
    await activeWriter.append(['active'])
    // 活动 run 的 mtime 刷成最旧（长跑无输出场景）
    const oldDate = new Date(now - 5000)
    await utimes(path.join(root, 'p-count', 'run-active.log'), oldDate, oldDate)

    await store.cleanup('current')
    expect(await exists(oldHistory)).toBe(false) // 超出配额的最旧历史被清理
    expect(await exists(newHistory)).toBe(true) // 配额内的历史保留
    expect(await exists(path.join(root, 'p-count', 'run-active.log'))).toBe(true) // 活动 run 不受影响
    await activeWriter.close()
  })

  it('全局容量跨项目按最旧优先整 run 回收', async () => {
    const root = path.join(baseDir, 'quota-multi')
    const now = Date.now()
    const p1 = await put('p-multi-1', 'run-a', 'a'.repeat(40), now - 3000, '', root)
    const p2 = await put('p-multi-2', 'run-b', 'b'.repeat(40), now - 2000, '', root)
    const store = new LogStore({
      logsDir: root,
      getLimits: () => limits({ maxTotalBytes: 45, retentionMs: 60_000 })
    })
    const result = await store.cleanup('current')
    expect(result.deletedFiles).toBe(1)
    expect(await exists(p1)).toBe(false) // 更旧的项目先被回收
    expect(await exists(p2)).toBe(true)
    expect(result.remainingBytes).toBe(40)
  })
})
