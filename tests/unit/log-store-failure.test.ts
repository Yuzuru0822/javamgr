import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { LogStore } from '../../src/main/log/log-store'
import type { LogStoreLimits } from '../../src/main/log/log-store'

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, rename: vi.fn(actual.rename) }
})

let baseDir: string
let logsDir: string
const renameMock = vi.mocked(rename)

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-logstore-failure-'))
  logsDir = path.join(baseDir, 'logs')
})

afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  renameMock.mockReset()
  renameMock.mockImplementation(actual.rename)
})

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

function limits(patch: Partial<LogStoreLimits> = {}): LogStoreLimits {
  return {
    maxFileBytes: 10,
    maxRotations: 3,
    runsToKeep: 10,
    retentionMs: 60_000,
    maxTotalBytes: 1024 * 1024,
    ...patch
  }
}

function lockError(code = 'EPERM'): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code })
}

describe('RunLogWriter：Windows 轮转失败恢复', () => {
  it('base rename 瞬态 EPERM 重试成功后正常轮转', async () => {
    const store = new LogStore({ logsDir, getLimits: () => limits({ maxFileBytes: 12 }) })
    const writer = store.openRun('p-retry', 'run-retry')
    await writer.append(['first-line'])
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let failures = 0
    renameMock.mockImplementation(async (from, to) => {
      if (String(from).endsWith('run-retry.log') && failures < 2) {
        failures += 1
        throw lockError()
      }
      return actual.rename(from, to)
    })
    await writer.append(['second-line'])
    expect(failures).toBe(2)
    expect(await readFile(path.join(logsDir, 'p-retry', 'run-retry.log.1'), 'utf8')).toBe('first-line\n')
    expect(await readFile(path.join(logsDir, 'p-retry', 'run-retry.log'), 'utf8')).toBe('second-line\n')
    await writer.close()
  })

  it('base 永久失败：磁盘零改动（历史完整）；恢复后重试不丢历史、不重复新行', async () => {
    const dir = path.join(logsDir, 'p-fail')
    const { mkdir } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'run-fail.log'), 'base-old\n')
    await writeFile(path.join(dir, 'run-fail.log.1'), 'rotation-one\n')
    await writeFile(path.join(dir, 'run-fail.log.2'), 'rotation-two\n')
    const store = new LogStore({ logsDir, getLimits: () => limits({ maxFileBytes: 10 }) })
    const writer = store.openRun('p-fail', 'run-fail')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    renameMock.mockImplementation(async (from, to) => {
      if (String(from).endsWith('run-fail.log')) throw lockError()
      return actual.rename(from, to)
    })
    await expect(writer.append(['next-line'])).rejects.toMatchObject({ code: 'EPERM' })
    // 失败必须零改动：base 与两代历史都还在原位
    expect(await readFile(path.join(dir, 'run-fail.log'), 'utf8')).toBe('base-old\n')
    expect(await readFile(path.join(dir, 'run-fail.log.1'), 'utf8')).toBe('rotation-one\n')
    expect(await readFile(path.join(dir, 'run-fail.log.2'), 'utf8')).toBe('rotation-two\n')

    renameMock.mockReset()
    renameMock.mockImplementation(actual.rename)
    await writer.append(['next-line'])
    expect(await readFile(path.join(dir, 'run-fail.log'), 'utf8')).toBe('next-line\n')
    // 恢复后三代历史必须全部保留（早期实现会静默丢掉最老一代）
    expect(await readFile(path.join(dir, 'run-fail.log.1'), 'utf8')).toBe('base-old\n')
    expect(await readFile(path.join(dir, 'run-fail.log.2'), 'utf8')).toBe('rotation-one\n')
    expect(await readFile(path.join(dir, 'run-fail.log.3'), 'utf8')).toBe('rotation-two\n')
    const names = ['run-fail.log', 'run-fail.log.1', 'run-fail.log.2', 'run-fail.log.3']
    const contents = await Promise.all(
      names.map(async (name) => {
        try {
          return await readFile(path.join(dir, name), 'utf8')
        } catch {
          return ''
        }
      })
    )
    expect(contents.join('').match(/next-line/g)).toHaveLength(1)
    await writer.close()
  })

  it('历史顺移失败：最旧代不提前删除，base 与全部历史回滚后可无损重试', async () => {
    const dir = path.join(logsDir, 'p-shift-fail')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    await actual.mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'run-shift.log'), 'base-old\n')
    await writeFile(path.join(dir, 'run-shift.log.1'), 'rotation-one\n')
    await writeFile(path.join(dir, 'run-shift.log.2'), 'rotation-two\n')
    await writeFile(path.join(dir, 'run-shift.log.3'), 'rotation-three\n')
    const store = new LogStore({ logsDir, getLimits: () => limits({ maxFileBytes: 10 }) })
    const writer = store.openRun('p-shift-fail', 'run-shift')
    renameMock.mockImplementation(async (from, to) => {
      if (String(from).endsWith('run-shift.log.2') && String(to).endsWith('run-shift.log.3')) {
        throw lockError()
      }
      return actual.rename(from, to)
    })

    await expect(writer.append(['next-line'])).rejects.toMatchObject({ code: 'EPERM' })
    expect(await readFile(path.join(dir, 'run-shift.log'), 'utf8')).toBe('base-old\n')
    expect(await readFile(path.join(dir, 'run-shift.log.1'), 'utf8')).toBe('rotation-one\n')
    expect(await readFile(path.join(dir, 'run-shift.log.2'), 'utf8')).toBe('rotation-two\n')
    expect(await readFile(path.join(dir, 'run-shift.log.3'), 'utf8')).toBe('rotation-three\n')

    renameMock.mockReset()
    renameMock.mockImplementation(actual.rename)
    await writer.append(['next-line'])
    expect(await readFile(path.join(dir, 'run-shift.log'), 'utf8')).toBe('next-line\n')
    expect(await readFile(path.join(dir, 'run-shift.log.1'), 'utf8')).toBe('base-old\n')
    expect(await readFile(path.join(dir, 'run-shift.log.2'), 'utf8')).toBe('rotation-one\n')
    expect(await readFile(path.join(dir, 'run-shift.log.3'), 'utf8')).toBe('rotation-two\n')
    await writer.close()
  })

  it('回滚最旧代也失败：显式报错并保留 .retiring，恢复后可继续轮转', async () => {
    const dir = path.join(logsDir, 'p-rollback-fail')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    await actual.mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'run-rollback.log'), 'base-old\n')
    await writeFile(path.join(dir, 'run-rollback.log.1'), 'rotation-one\n')
    await writeFile(path.join(dir, 'run-rollback.log.2'), 'rotation-two\n')
    await writeFile(path.join(dir, 'run-rollback.log.3'), 'rotation-three\n')
    const store = new LogStore({ logsDir, getLimits: () => limits({ maxFileBytes: 10 }) })
    const writer = store.openRun('p-rollback-fail', 'run-rollback')
    renameMock.mockImplementation(async (from, to) => {
      const source = String(from)
      const target = String(to)
      if (source.endsWith('run-rollback.log.2') && target.endsWith('run-rollback.log.3')) {
        throw lockError()
      }
      if (source.endsWith('run-rollback.log.retiring') && target.endsWith('run-rollback.log.3')) {
        throw lockError()
      }
      return actual.rename(from, to)
    })

    await expect(writer.append(['next-line'])).rejects.toThrow('回滚未完全恢复')
    expect(await readFile(path.join(dir, 'run-rollback.log'), 'utf8')).toBe('base-old\n')
    expect(await readFile(path.join(dir, 'run-rollback.log.retiring'), 'utf8')).toBe('rotation-three\n')

    renameMock.mockReset()
    renameMock.mockImplementation(actual.rename)
    await writer.append(['next-line'])
    expect(await readFile(path.join(dir, 'run-rollback.log'), 'utf8')).toBe('next-line\n')
    expect(await readFile(path.join(dir, 'run-rollback.log.1'), 'utf8')).toBe('base-old\n')
    expect(await readFile(path.join(dir, 'run-rollback.log.2'), 'utf8')).toBe('rotation-one\n')
    expect(await readFile(path.join(dir, 'run-rollback.log.3'), 'utf8')).toBe('rotation-two\n')
    await writer.close()
  })

  it('崩溃留下 rotating/retiring 与部分顺移：下次写入先恢复全部历史再追加', async () => {
    const dir = path.join(logsDir, 'p-crash')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    await actual.mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'run-crash.log.rotating'), 'newest-base\n')
    await writeFile(path.join(dir, 'run-crash.log.2'), 'rotation-one\n')
    await writeFile(path.join(dir, 'run-crash.log.3'), 'rotation-two\n')
    await writeFile(path.join(dir, 'run-crash.log.retiring'), 'rotation-three\n')
    const store = new LogStore({ logsDir, getLimits: () => limits({ maxFileBytes: 1024 }) })
    const writer = store.openRun('p-crash', 'run-crash')
    await writer.append(['after-recovery'])

    expect(await readFile(path.join(dir, 'run-crash.log'), 'utf8')).toBe(
      'newest-base\nafter-recovery\n'
    )
    expect(await readFile(path.join(dir, 'run-crash.log.1'), 'utf8')).toBe('rotation-one\n')
    expect(await readFile(path.join(dir, 'run-crash.log.2'), 'utf8')).toBe('rotation-two\n')
    expect(await readFile(path.join(dir, 'run-crash.log.3'), 'utf8')).toBe('rotation-three\n')
    await writer.close()
  })

  it('提交失败且第一次历史回滚失败：禁止覆盖后续世代，恢复后仍完整', async () => {
    const dir = path.join(logsDir, 'p-partial-rollback')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    await actual.mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'run-partial.log'), 'base-old\n')
    await writeFile(path.join(dir, 'run-partial.log.1'), 'rotation-one\n')
    await writeFile(path.join(dir, 'run-partial.log.2'), 'rotation-two\n')
    await writeFile(path.join(dir, 'run-partial.log.3'), 'rotation-three\n')
    const store = new LogStore({ logsDir, getLimits: () => limits({ maxFileBytes: 10 }) })
    const writer = store.openRun('p-partial-rollback', 'run-partial')
    renameMock.mockImplementation(async (from, to) => {
      const source = String(from)
      const target = String(to)
      if (source.endsWith('run-partial.log.rotating') && target.endsWith('run-partial.log.1')) {
        throw lockError()
      }
      if (source.endsWith('run-partial.log.2') && target.endsWith('run-partial.log.1')) {
        throw lockError()
      }
      return actual.rename(from, to)
    })

    await expect(writer.append(['next-line'])).rejects.toThrow('回滚未完全恢复')
    expect(await readFile(path.join(dir, 'run-partial.log'), 'utf8')).toBe('base-old\n')
    expect(await readFile(path.join(dir, 'run-partial.log.2'), 'utf8')).toBe('rotation-one\n')
    expect(await readFile(path.join(dir, 'run-partial.log.3'), 'utf8')).toBe('rotation-two\n')
    expect(await readFile(path.join(dir, 'run-partial.log.retiring'), 'utf8')).toBe(
      'rotation-three\n'
    )

    renameMock.mockReset()
    renameMock.mockImplementation(actual.rename)
    await writer.append(['next-line'])
    expect(await readFile(path.join(dir, 'run-partial.log'), 'utf8')).toBe('next-line\n')
    expect(await readFile(path.join(dir, 'run-partial.log.1'), 'utf8')).toBe('base-old\n')
    expect(await readFile(path.join(dir, 'run-partial.log.2'), 'utf8')).toBe('rotation-one\n')
    expect(await readFile(path.join(dir, 'run-partial.log.3'), 'utf8')).toBe('rotation-two\n')
    await writer.close()
  })

  it('close 拒绝新的 append，但 close 前已接受的批次仍真实落盘', async () => {
    const store = new LogStore({ logsDir, getLimits: () => limits({ maxFileBytes: 1024 }) })
    const writer = store.openRun('p-close', 'run-close')
    const accepted = writer.append(['accepted-before-close'])
    const closing = writer.close()
    await expect(writer.append(['rejected-after-close'])).rejects.toThrow('已关闭')
    await Promise.all([accepted, closing])
    expect(await readFile(path.join(logsDir, 'p-close', 'run-close.log'), 'utf8')).toBe(
      'accepted-before-close\n'
    )
  })
})
