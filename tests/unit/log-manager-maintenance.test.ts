import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/main/config/config-store'
import { resolveAppPaths } from '../../src/main/config/paths'
import { LogManager } from '../../src/main/log/log-manager'
import { resolveStdoutLogDir } from '../../src/main/log/log-path'
import type { Project } from '../../src/shared/types'

const managers: LogManager[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(): Promise<{ baseDir: string; store: ConfigStore; project: Project }> {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-log-maintenance-'))
  tempDirs.push(baseDir)
  const store = new ConfigStore(resolveAppPaths(baseDir))
  await store.init()
  const project = await store.createProject({
    name: 'log-maintenance-fixture',
    jarPath: 'C:\\fake\\app.jar',
    jdkId: 'jdk-any',
    jvmArgs: [],
    programArgs: [],
    envVars: {}
  })
  return { baseDir, store, project }
}

function track(manager: LogManager): LogManager {
  managers.push(manager)
  return manager
}

async function waitUntil(probe: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe()) return
    if (Date.now() > deadline) throw new Error('等待日志维护条件超时')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}

describe('LogManager：关闭与路由切换回归', () => {
  it('shutdown 先 dispose 捕获器，未换行残行也落盘', async () => {
    const { baseDir, store, project } = await setup()
    const logsDir = path.join(baseDir, 'partial-logs')
    const manager = track(new LogManager({ store, logsDir }))
    const stdout = new PassThrough()
    manager.handleRunStarted({
      projectId: project.id,
      pid: 1,
      runId: 'run-partial',
      logSource: 'stdout',
      stdout,
      stderr: new PassThrough()
    })
    stdout.write(Buffer.from('partial-without-newline', 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 40))
    await manager.shutdown()
    const history = await manager.readHistory({ projectId: project.id, lines: 10, source: 'stdout' })
    expect(history.lines).toEqual(['partial-without-newline'])
  })

  it('stdout→file 切换前排队的 batch 仍写入旧 stdout run', async () => {
    const { baseDir, store, project } = await setup()
    const logsDir = path.join(baseDir, 'switch-logs')
    const manager = track(new LogManager({ store, logsDir, tailPollIntervalMs: 50 }))
    const stdout = new PassThrough()
    manager.handleRunStarted({
      projectId: project.id,
      pid: 2,
      runId: 'run-switch-pending',
      logSource: 'stdout',
      stdout,
      stderr: new PassThrough()
    })
    stdout.write(Buffer.from('pending-before-route\n', 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 40))
    await store.updateProject({ ...project, logFilePath: path.join(baseDir, 'external.log') })
    manager.switchRoute(project.id)
    await manager.shutdown()
    const history = await manager.readHistory({ projectId: project.id, lines: 10, source: 'stdout' })
    expect(history.lines).toEqual(['pending-before-route'])
  })

  it('存储目录失效时实时日志仍推送，但不创建 stdout 文件或回写默认目录', async () => {
    const { baseDir, store, project } = await setup()
    const logsDir = path.join(baseDir, 'unavailable', 'javamgr-logs')
    const defaultLogsDir = path.join(baseDir, 'default-logs')
    const manager = track(
      new LogManager({
        store,
        logsDir,
        legacyLogsDir: defaultLogsDir,
        storageError: '模拟目录不可用',
        broadcaster: () => undefined
      })
    )
    const stdout = new PassThrough()
    manager.handleRunStarted({
      projectId: project.id,
      pid: 3,
      runId: 'run-unavailable',
      logSource: 'stdout',
      stdout,
      stderr: new PassThrough()
    })
    stdout.write(Buffer.from('realtime-only\n', 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 250))
    const info = await manager.getStorageInfo()
    expect(info.storageError).toBe('模拟目录不可用')
    expect(info.logsDir).toBe(logsDir)
    expect(await exists(path.join(logsDir, project.id, 'run-unavailable.log'))).toBe(false)
    expect(await exists(path.join(defaultLogsDir, project.id, 'run-unavailable.log'))).toBe(false)
  })
})

describe('LogManager：维护与旧目录清理', () => {
  it('startMaintenance 启动即清理，周期任务按新 run 保留配置继续收敛', async () => {
    const { baseDir, store, project } = await setup()
    await store.setSettings({ logRunsToKeep: 1 })
    const logsDir = path.join(baseDir, 'maintenance-logs')
    const projectDir = path.join(logsDir, project.id)
    await mkdir(projectDir, { recursive: true })
    await writeFile(path.join(projectDir, 'run-old.log'), 'old\n')
    await writeFile(path.join(projectDir, 'run-fresh.log'), 'fresh\n')
    const oldDate = new Date(Date.now() - 10_000)
    await utimes(path.join(projectDir, 'run-old.log'), oldDate, oldDate)
    const manager = track(new LogManager({ store, logsDir, cleanupIntervalMs: 40 }))
    manager.startMaintenance()
    await waitUntil(async () => (await manager.getStorageInfo()).totalBytes === Buffer.byteLength('fresh\n'))

    await writeFile(path.join(projectDir, 'run-later.log'), 'later\n')
    await waitUntil(async () => (await manager.getStorageInfo()).totalBytes === Buffer.byteLength('later\n'))
    const history = await manager.readHistory({ projectId: project.id, lines: 10, source: 'stdout' })
    expect(history.lines).toEqual(['later'])
  })

  it('显式 legacyDefault 清理只删除旧默认根的 javamgr 自有日志', async () => {
    const { baseDir, store } = await setup()
    const current = path.join(baseDir, 'current')
    const legacy = path.join(baseDir, 'legacy')
    await mkdir(path.join(legacy, 'p-old'), { recursive: true })
    await mkdir(path.join(legacy, 'other'), { recursive: true })
    await mkdir(path.join(current, 'p-current'), { recursive: true })
    await writeFile(path.join(legacy, 'p-old', 'run-old.log'), 'legacy\n')
    await writeFile(path.join(legacy, 'p-old', 'custom.log'), 'unknown\n')
    await writeFile(path.join(legacy, 'other', 'run-other.log'), 'other\n')
    await writeFile(path.join(current, 'p-current', 'run-current.log'), 'current\n')
    const manager = track(new LogManager({ store, logsDir: current, legacyLogsDir: legacy }))

    const result = await manager.cleanupNow('legacyDefault')
    expect(result.deletedFiles).toBe(1)
    expect(result.freedBytes).toBe(Buffer.byteLength('legacy\n'))
    expect(await exists(path.join(legacy, 'p-old', 'run-old.log'))).toBe(false)
    expect(await exists(path.join(legacy, 'p-old', 'custom.log'))).toBe(true)
    expect(await exists(path.join(legacy, 'other', 'run-other.log'))).toBe(true)
    expect(await exists(path.join(current, 'p-current', 'run-current.log'))).toBe(true)
    const info = await manager.getStorageInfo()
    expect(info.logsDir).toBe(current)
    expect(info.defaultLogsDir).toBe(legacy)
    expect(info.totalBytes).toBe(Buffer.byteLength('current\n'))
  })

  it('自定义目录：重启后只写新目录，旧默认根转入 legacyDefault 显式清理', async () => {
    const { baseDir, store, project } = await setup()
    const defaultLogsDir = path.join(baseDir, 'default-logs')
    const customRoot = resolveStdoutLogDir(path.join(baseDir, 'custom-parent'), defaultLogsDir)
    await mkdir(path.join(defaultLogsDir, 'p-old'), { recursive: true })
    await writeFile(path.join(defaultLogsDir, 'p-old', 'run-old.log'), 'legacy\n')

    const first = track(
      new LogManager({ store, logsDir: customRoot, legacyLogsDir: defaultLogsDir })
    )
    const stdout = new PassThrough()
    first.handleRunStarted({
      projectId: project.id,
      pid: 9,
      runId: 'run-custom-dir',
      logSource: 'stdout',
      stdout,
      stderr: new PassThrough()
    })
    stdout.write(Buffer.from('custom-dir-line\n', 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 260))
    await first.shutdown()

    // 新目录确实收到落盘，旧默认根未被写入
    expect(await exists(path.join(customRoot, project.id, 'run-custom-dir.log'))).toBe(true)
    expect(await exists(path.join(defaultLogsDir, project.id, 'run-custom-dir.log'))).toBe(false)

    // 模拟重启：新 LogManager 读新目录，旧默认根只经显式 legacyDefault 清理
    const second = track(
      new LogManager({ store, logsDir: customRoot, legacyLogsDir: defaultLogsDir })
    )
    const history = await second.readHistory({ projectId: project.id, lines: 10, source: 'stdout' })
    expect(history.lines).toEqual(['custom-dir-line'])
    const result = await second.cleanupNow('legacyDefault')
    expect(result.deletedFiles).toBe(1)
    expect(await exists(path.join(defaultLogsDir, 'p-old', 'run-old.log'))).toBe(false)
    expect(await exists(path.join(customRoot, project.id, 'run-custom-dir.log'))).toBe(true)
  })
})