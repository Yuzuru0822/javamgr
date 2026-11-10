import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LogStore } from '../../src/main/log/log-store'
import type { LogStoreLimits } from '../../src/main/log/log-store'

/** log-store 单测（§2.3-C / S4.2）：追加写 + 大小轮转 + run 保留 + readTail */

let baseDir: string
let logsDir: string

const limits = (patch: Partial<LogStoreLimits> = {}): LogStoreLimits => ({
  maxFileBytes: 10 * 1024 * 1024,
  maxRotations: 3,
  runsToKeep: 10,
  ...patch
})

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-logstore-'))
  logsDir = path.join(baseDir, 'logs')
})

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('RunLogWriter：追加写与大小轮转', () => {
  it('追加写整行落盘（UTF-8，行尾 \\n）', async () => {
    const store = new LogStore({ logsDir, getLimits: () => limits() })
    const w = store.openRun('p1', 'run-a')
    await w.append(['line1', 'line2'])
    await w.append(['line3'])
    const content = await readFile(path.join(logsDir, 'p1', 'run-a.log'), 'utf8')
    expect(content).toBe('line1\nline2\nline3\n')
  })

  it('P2-4（phase4 审查）：drain 等待未 await 的 append 链真实落盘', async () => {
    const store = new LogStore({ logsDir, getLimits: () => limits() })
    const w = store.openRun('p9', 'run-drain')
    // fire-and-forget append（批量 flush 的真实调用形态）：不 await 直接发起
    void w.append(['drain-1'])
    void w.append(['drain-2'])
    await w.drain() // drain 返回即已落盘——无需额外 sleep
    const content = await readFile(path.join(logsDir, 'p9', 'run-drain.log'), 'utf8')
    expect(content).toBe('drain-1\ndrain-2\n')
  })

  it('超限轮转：base → .1，.1→.2 顺移，超出 maxRotations 删除', async () => {
    const store = new LogStore({
      logsDir,
      getLimits: () => limits({ maxFileBytes: 60, maxRotations: 2 })
    })
    const w = store.openRun('p2', 'run-b')
    const line = (i: number): string => `2026-11-09 10:00:00.000 [INFO] line-${String(i).padStart(2, '0')}`
    // 每行约 40 字节：两次 append 后超 60B 触发轮转，多轮后 .3 应被删除
    for (let i = 1; i <= 20; i += 2) {
      await w.append([line(i), line(i + 1)])
    }
    const dir = path.join(logsDir, 'p2')
    const names = (await readdir(dir)).sort()
    expect(names).toEqual(['run-b.log', 'run-b.log.1', 'run-b.log.2']) // .3 已被清理
    // 当前文件是最新行
    const current = await readFile(path.join(dir, 'run-b.log'), 'utf8')
    const currentLines = current.trim().split('\n')
    expect(currentLines[currentLines.length - 1]).toBe(line(20))
    // .1 是最近轮转（比 .2 新）
    const r1 = await readFile(path.join(dir, 'run-b.log.1'), 'utf8')
    const r2 = await readFile(path.join(dir, 'run-b.log.2'), 'utf8')
    const lastOf = (t: string): string => t.trim().split('\n').pop() ?? ''
    expect(Number(lastOf(r1).match(/line-(\d+)/)?.[1] ?? 0)).toBeGreaterThan(
      Number(lastOf(r2).match(/line-(\d+)/)?.[1] ?? 0)
    )
  })
})

describe('LogStore：run 保留清理与枚举', () => {
  it('每项目仅保留最近 runsToKeep 个 run（按 mtime）', async () => {
    const store = new LogStore({
      logsDir,
      getLimits: () => limits({ runsToKeep: 3 })
    })
    // 依次写 5 个 run，mtime 递增（后写的文件新）
    for (let i = 1; i <= 5; i += 1) {
      const w = store.openRun('p3', `run-${i}`)
      await w.append([`run-${i}-only-line`])
      w.close()
      await new Promise((r) => setTimeout(r, 15)) // mtime 分离
    }
    await store.cleanupProject('p3')
    const runs = await store.listRuns('p3')
    expect(runs.map((r) => r.runId).sort()).toEqual(['run-3', 'run-4', 'run-5'])
  })

  it('listRuns 跨轮转文件归组（旧→新排序）', async () => {
    const store = new LogStore({
      logsDir,
      getLimits: () => limits({ maxFileBytes: 40, maxRotations: 2 })
    })
    const w = store.openRun('p4', 'run-x')
    for (let i = 1; i <= 10; i += 1) await w.append([`line-${i}-abcdefghijklmnop`])
    const runs = await store.listRuns('p4')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.files.map((f) => path.basename(f))).toEqual([
      'run-x.log.2',
      'run-x.log.1',
      'run-x.log'
    ])
  })
})

describe('LogStore.readTail：最新 run 尾部（跨轮转拼接）', () => {
  it('跨轮转文件按时间序返回最后 N 行', async () => {
    const store = new LogStore({
      logsDir,
      getLimits: () => limits({ maxFileBytes: 50, maxRotations: 3 })
    })
    const w = store.openRun('p5', 'run-tail')
    for (let i = 1; i <= 12; i += 1) {
      await w.append([`line-${String(i).padStart(2, '0')}`]) // 每行 8B：l1..6 进 .1，l7..12 在当前
    }
    const tail = await store.readTail('p5', 10)
    expect(tail.runId).toBe('run-tail')
    expect(tail.lines).toEqual([
      'line-03', 'line-04', 'line-05', 'line-06',
      'line-07', 'line-08', 'line-09', 'line-10', 'line-11', 'line-12'
    ])
  })

  it('无任何历史 → 空结果', async () => {
    const store = new LogStore({ logsDir, getLimits: () => limits() })
    const tail = await store.readTail('no-such-project', 100)
    expect(tail.lines).toEqual([])
  })

  it('多个 run：取最新 run（mtime 最新）', async () => {
    const store = new LogStore({ logsDir, getLimits: () => limits() })
    const old = store.openRun('p6', 'run-old')
    await old.append(['old-line'])
    await new Promise((r) => setTimeout(r, 15))
    const fresh = store.openRun('p6', 'run-fresh')
    await fresh.append(['fresh-line'])
    const tail = await store.readTail('p6', 10)
    expect(tail.runId).toBe('run-fresh')
    expect(tail.lines).toEqual(['fresh-line'])
  })
})

describe('LogStore.latestRunFiles', () => {
  it('返回最新 run 全部现存文件（旧→新），供检索扫描', async () => {
    const dir = path.join(logsDir, 'p7')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'run-m.log.2'), 'a\n')
    await writeFile(path.join(dir, 'run-m.log'), 'c\n') // .1 不存在：跳过
    const store = new LogStore({ logsDir, getLimits: () => limits() })
    const files = await store.latestRunFiles('p7')
    expect(files.map((f) => path.basename(f))).toEqual(['run-m.log.2', 'run-m.log'])
  })
})
