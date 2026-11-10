import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/main/config/config-store'
import { resolveAppPaths } from '../../src/main/config/paths'
import { LogManager } from '../../src/main/log/log-manager'
import type { Project } from '../../src/shared/types'
import type { LogAppendedEvent } from '../../src/shared/types'

/**
 * log-manager 单测（§2.3-C / S4.5，S-1/R7）：路由互斥 / markRunning 首行信号 /
 * 200ms|100 行批量推送 / readHistory（stdout 落盘 tail）/ switchRoute 即时切换 /
 * 终态 teardown flush。管道用 PassThrough 伪造（零进程依赖）。
 */

let baseDir: string
let store: ConfigStore
let logsDir: string

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-logmgr-'))
  logsDir = path.join(baseDir, 'logs')
  store = new ConfigStore(resolveAppPaths(baseDir))
  await store.init()
})

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(probe: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (probe()) return
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
    await sleep(40)
  }
}

async function createProject(overrides: Partial<Project> = {}): Promise<Project> {
  return store.createProject({
    name: `P-${Math.random().toString(36).slice(2, 8)}`,
    jarPath: 'C:\\fake\\app.jar',
    jdkId: 'jdk-any',
    jvmArgs: [],
    programArgs: [],
    envVars: {},
    ...overrides
  })
}

describe('stdout 路：捕获/批量/首行信号/落盘', () => {
  it('markRunning 首行信号（S-1：只发信号一次）；100 行阈值即刷（不等 200ms）', async () => {
    const project = await createProject()
    const chunks: LogAppendedEvent[] = []
    const markCalls: string[] = []
    const manager = new LogManager({
      store,
      logsDir,
      broadcaster: (c) => chunks.push(c),
      markRunning: (id) => markCalls.push(id),
      tailPollIntervalMs: 100
    })
    const stdout = new PassThrough()
    manager.handleRunStarted({
      projectId: project.id,
      pid: 1,
      runId: 'run-batch',
      logSource: 'stdout',
      stdout,
      stderr: new PassThrough()
    })
    const lines: string[] = []
    for (let i = 1; i <= 100; i += 1) {
      lines.push(`2026-11-09 10:00:00.${String(i).padStart(3, '0')} [INFO] line-${i}`)
    }
    stdout.write(Buffer.from(`${lines.join('\n')}\n`, 'utf8'))
    await sleep(80) // 远小于 200ms：证明阈值触发而非定时器
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.lines).toHaveLength(100)
    expect(chunks[0]?.source).toBe('stdout')
    expect(markCalls).toEqual([project.id]) // 首行信号一次
    await manager.shutdown()
  })

  it('200ms 定时器兜底刷批量 + stderr 并流', async () => {
    const project = await createProject()
    const chunks: LogAppendedEvent[] = []
    const manager = new LogManager({
      store, logsDir, broadcaster: (c) => chunks.push(c), tailPollIntervalMs: 100
    })
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    manager.handleRunStarted({
      projectId: project.id, pid: 2, runId: 'run-timer', logSource: 'stdout', stdout, stderr
    })
    stdout.write(Buffer.from('out-line-1\n', 'utf8'))
    stderr.write(Buffer.from('err-line-1\n', 'utf8'))
    await sleep(60)
    expect(chunks).toHaveLength(0) // 未达阈值：等定时器
    await sleep(260)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.lines).toEqual(['out-line-1', 'err-line-1'])
    await manager.shutdown()
  })

  it('终态 teardown 立即 flush 残行批量（不等 200ms）', async () => {
    const project = await createProject()
    const chunks: LogAppendedEvent[] = []
    const manager = new LogManager({
      store, logsDir, broadcaster: (c) => chunks.push(c), tailPollIntervalMs: 100
    })
    const stdout = new PassThrough()
    manager.handleRunStarted({
      projectId: project.id, pid: 3, runId: 'run-teardown', logSource: 'stdout', stdout, stderr: new PassThrough()
    })
    stdout.write(Buffer.from('last-words-1\nlast-words-2\n', 'utf8'))
    await sleep(50)
    manager.handleStatusChanged({ projectId: project.id, status: 'STOPPED' })
    expect(chunks).toHaveLength(1) // 同步 flush
    expect(chunks[0]?.lines).toEqual(['last-words-1', 'last-words-2'])
    await manager.shutdown()
  })

  it('readHistory（stdout）：落盘文件尾部可读（A9）', async () => {
    const project = await createProject()
    const chunks: LogAppendedEvent[] = []
    const manager = new LogManager({
      store, logsDir, broadcaster: (c) => chunks.push(c), tailPollIntervalMs: 100
    })
    const stdout = new PassThrough()
    manager.handleRunStarted({
      projectId: project.id, pid: 4, runId: 'run-hist', logSource: 'stdout', stdout, stderr: new PassThrough()
    })
    stdout.write(Buffer.from('persist-1\npersist-2\n', 'utf8'))
    await sleep(280) // 批量落盘完成
    const r = await manager.readHistory({ projectId: project.id, lines: 10, source: 'auto' })
    expect(r.source).toBe('stdout')
    expect(r.lines).toEqual(['persist-1', 'persist-2'])
    await manager.shutdown()
  })

  it('P2-4（phase4 审查）：shutdown 等待最终批量真实落盘（退出前 200ms 窗口的残行不丢）', async () => {
    const project = await createProject()
    const manager = new LogManager({ store, logsDir, tailPollIntervalMs: 100 })
    const stdout = new PassThrough()
    manager.handleRunStarted({
      projectId: project.id, pid: 10, runId: 'run-exit-drain', logSource: 'stdout',
      stdout, stderr: new PassThrough()
    })
    stdout.write(Buffer.from('final-words-1\nfinal-words-2\n', 'utf8'))
    await sleep(40) // 行仍在批量缓冲（200ms 定时器未到）——模拟退出瞬间的残行窗口
    await manager.shutdown() // 不额外 sleep：shutdown 返回即已排空落盘（旧实现 fire-and-forget，readHistory 将读不到）
    const r = await manager.readHistory({ projectId: project.id, lines: 10, source: 'stdout' })
    expect(r.lines).toEqual(['final-words-1', 'final-words-2'])
  })
})

describe('file 路：tailer 路由与互斥', () => {
  it('logFilePath 存在 → tail 文件；stdout 仅排空（banner 不推送）——两路互斥', async () => {
    const dir = path.join(baseDir, 'route-file')
    await mkdir(dir, { recursive: true })
    const logFile = path.join(dir, 'app.log')
    const project = await createProject({ logFilePath: logFile })

    const chunks: LogAppendedEvent[] = []
    const markCalls: string[] = []
    const manager = new LogManager({
      store, logsDir,
      broadcaster: (c) => chunks.push(c),
      markRunning: (id) => markCalls.push(id),
      tailPollIntervalMs: 100
    })
    const stdout = new PassThrough()
    manager.handleRunStarted({
      projectId: project.id, pid: 5, runId: 'run-file', logSource: 'file', stdout, stderr: new PassThrough()
    })
    // stdout banner（file 路被排空丢弃，不得推送/不得触发 markRunning）
    stdout.write(Buffer.from('Loggy v1.0 starting console banner\n', 'utf8'))
    // 文件出现 + 追加
    await writeFile(logFile, 'file-line-1\nfile-line-2\n', 'utf8')
    await waitFor(
      () => chunks.some((c) => c.lines.includes('file-line-2')),
      6_000,
      'file 路 tail 推送'
    )
    const fileChunk = chunks.find((c) => c.source === 'file')
    expect(fileChunk?.lines).toEqual(['file-line-1', 'file-line-2'])
    expect(chunks.some((c) => c.lines.some((l) => l.includes('console banner')))).toBe(false)
    expect(markCalls).toEqual([project.id]) // 首行信号来自文件路
    await manager.shutdown()
  })

  it('N-5：初始回读的历史行不触发 markRunning；跟随期新增行才触发', async () => {
    const dir = path.join(baseDir, 'route-file-hist')
    await mkdir(dir, { recursive: true })
    const logFile = path.join(dir, 'hist.log')
    // 预写 5 行历史（旧 run 的内容，不应证明本次启动存活）
    await writeFile(logFile, 'old-1\nold-2\nold-3\nold-4\nold-5\n', 'utf8')
    const project = await createProject({ logFilePath: logFile })

    const chunks: LogAppendedEvent[] = []
    const markCalls: string[] = []
    const manager = new LogManager({
      store, logsDir,
      broadcaster: (c) => chunks.push(c),
      markRunning: (id) => markCalls.push(id),
      tailPollIntervalMs: 100
    })
    manager.handleRunStarted({
      projectId: project.id, pid: 8, runId: 'run-hist-init', logSource: 'file',
      stdout: new PassThrough(), stderr: new PassThrough()
    })
    // 历史行进入批量推送（UI 可见）但绝不触发 markRunning
    await waitFor(
      () => chunks.some((c) => c.lines.includes('old-5')),
      6_000,
      '初始历史行推送'
    )
    expect(markCalls).toEqual([]) // N-5 核心：历史行不发信号

    // 本次 run 的新增输出 → 触发一次 markRunning
    const { appendFile } = await import('node:fs/promises')
    await appendFile(logFile, 'fresh-run-line\n', 'utf8')
    await waitFor(
      () => chunks.some((c) => c.lines.includes('fresh-run-line')),
      6_000,
      '跟随期新增行推送'
    )
    expect(markCalls).toEqual([project.id])
    await manager.shutdown()
  })
})

describe('switchRoute：logFilePath 变更即时切换（重置游标）', () => {
  it('file → file 改路径：新文件从初始 tail 开始跟随', async () => {
    const dirA = path.join(baseDir, 'switch-a')
    const dirB = path.join(baseDir, 'switch-b')
    await mkdir(dirA, { recursive: true })
    await mkdir(dirB, { recursive: true })
    const fileA = path.join(dirA, 'a.log')
    const fileB = path.join(dirB, 'b.log')
    await writeFile(fileA, 'a-1\na-2\n', 'utf8')
    const project = await createProject({ logFilePath: fileA })

    const chunks: LogAppendedEvent[] = []
    const manager = new LogManager({
      store, logsDir, broadcaster: (c) => chunks.push(c), tailPollIntervalMs: 100
    })
    manager.handleRunStarted({
      projectId: project.id, pid: 6, runId: 'run-switch', logSource: 'file',
      stdout: new PassThrough(), stderr: new PassThrough()
    })
    await waitFor(() => chunks.some((c) => c.lines.includes('a-2')), 6_000, '初始 tail fileA')

    // 变更 logFilePath → store.updateProject → switchRoute（ipc-registry diff 后同款调用）
    const current = store.listProjects().find((p) => p.id === project.id)
    if (!current) throw new Error('项目丢失')
    await writeFile(fileB, 'b-1\nb-2\n', 'utf8')
    await store.updateProject({ ...current, logFilePath: fileB })
    manager.switchRoute(project.id)
    await waitFor(() => chunks.some((c) => c.lines.includes('b-2')), 6_000, '切换后 tail fileB')
    // 新文件从初始 tail 开始（b-1 也在），旧文件不再跟随
    expect(chunks.some((c) => c.lines.includes('b-1'))).toBe(true)
    await manager.shutdown()
  })

  it('file → stdout：接管转发并落盘（自切换点起）', async () => {
    const dir = path.join(baseDir, 'switch-to-stdout')
    await mkdir(dir, { recursive: true })
    const logFile = path.join(dir, 'app.log')
    await writeFile(logFile, 'f-only-1\n', 'utf8')
    const project = await createProject({ logFilePath: logFile })

    const chunks: LogAppendedEvent[] = []
    const manager = new LogManager({
      store, logsDir, broadcaster: (c) => chunks.push(c), tailPollIntervalMs: 100
    })
    const stdout = new PassThrough()
    manager.handleRunStarted({
      projectId: project.id, pid: 7, runId: 'run-f2s', logSource: 'file', stdout, stderr: new PassThrough()
    })
    await waitFor(() => chunks.some((c) => c.lines.includes('f-only-1')), 6_000, 'file 初始 tail')

    const current = store.listProjects().find((p) => p.id === project.id)
    if (!current) throw new Error('项目丢失')
    await store.updateProject({ ...current, logFilePath: undefined })
    manager.switchRoute(project.id)
    stdout.write(Buffer.from('after-switch-stdout-1\n', 'utf8'))
    await waitFor(() => chunks.some((c) => c.lines.includes('after-switch-stdout-1')), 3_000, 'stdout 接管转发')
    const last = chunks[chunks.length - 1]
    expect(last?.source).toBe('stdout')
    await sleep(120)
    const hist = await manager.readHistory({ projectId: project.id, lines: 10, source: 'auto' })
    expect(hist.source).toBe('stdout')
    expect(hist.lines).toContain('after-switch-stdout-1')
    await manager.shutdown()
  })
})

describe('readHistory（file 路）：直接 tail 配置文件', () => {
  it('auto 路由 file：返回配置文件尾部（不依赖运行状态）', async () => {
    const dir = path.join(baseDir, 'hist-file')
    await mkdir(dir, { recursive: true })
    const logFile = path.join(dir, 'h.log')
    const lines: string[] = []
    for (let i = 1; i <= 30; i += 1) lines.push(`h-${i}`)
    await writeFile(logFile, lines.join('\n') + '\n', 'utf8')
    const project = await createProject({ logFilePath: logFile })
    const manager = new LogManager({ store, logsDir, tailPollIntervalMs: 100 })
    const r = await manager.readHistory({ projectId: project.id, lines: 5, source: 'auto' })
    expect(r.source).toBe('file')
    expect(r.lines).toEqual(['h-26', 'h-27', 'h-28', 'h-29', 'h-30'])
    await manager.shutdown()
  })
})
