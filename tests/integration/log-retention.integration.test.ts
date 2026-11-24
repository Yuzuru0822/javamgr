import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/main/config/config-store'
import { resolveAppPaths } from '../../src/main/config/paths'
import { LogManager } from '../../src/main/log/log-manager'
import { ProcessManager } from '../../src/main/process/process-manager'
import type { RunStartedEvent } from '../../src/main/process/process-manager'
import { createTaskOps } from '../../src/main/process/task-killer'

/**
 * stdout 日志磁盘治理真实进程集成测试：
 * 1. 真实 Java 高频输出触发单文件上限轮转（真实文件大小受 maxFileMb 约束）；
 * 2. 进程结束后全局目标容量回收真实释放磁盘（活动 run 期间不强删，结束后按最旧优先回收）。
 *
 * 前置：本机 D:\java17\jdk-17.0.12；夹具现场编译。
 */

const run = promisify(execFile)

const JDK_HOME = 'D:\\java17\\jdk-17.0.12'
const FIXTURES_DIR = path.resolve(__dirname, '../../scripts/fixtures')
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024

const taskOps = createTaskOps()
const launchedPids = new Set<number>()

let baseDir: string
let store: ConfigStore
let logsDir: string
let projectId: string
let jarPath: string

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(
  probe: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe()) return
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
    await sleep(200)
  }
}

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-logretention-it-'))
  logsDir = path.join(baseDir, 'logs')
  const buildDir = path.join(baseDir, 'fixture-build')
  jarPath = path.join(buildDir, 'loggy.jar')
  await run(path.join(JDK_HOME, 'bin', 'javac.exe'), [
    '-encoding', 'UTF-8', '-d', buildDir, path.join(FIXTURES_DIR, 'Loggy.java')
  ])
  await run(path.join(JDK_HOME, 'bin', 'jar.exe'), [
    '--create', '--file', jarPath, '--main-class', 'Loggy', '-C', buildDir, '.'
  ])

  store = new ConfigStore(resolveAppPaths(baseDir))
  await store.init()
  await store.addJdk({
    id: 'jdk-it', name: 'Temurin 17.0.12', homePath: JDK_HOME,
    version: '17.0.12', vendor: 'Eclipse Temurin', source: 'manual'
  })
  const created = await store.createProject({
    name: 'LoggyRetentionIT', jarPath, jdkId: 'jdk-it',
    jvmArgs: [], programArgs: [], envVars: {}
  })
  projectId = created.id
  await store.setSettings({
    logMaxFileMb: 1,
    logMaxRotations: 2,
    logRunsToKeep: 1,
    logMaxTotalMb: 2,
    logRetentionDays: 7
  })
}, 120_000)

afterAll(async () => {
  for (const pid of launchedPids) {
    try {
      await run(
        'powershell',
        ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
        { timeout: 10_000 }
      )
    } catch {
      // 已死则忽略
    }
  }
  if (baseDir) await rm(baseDir, { recursive: true, force: true })
}, 60_000)

describe('integration/log-retention：磁盘占用治理', () => {
  it('高频 stdout 触发真实轮转；进程结束后全局目标容量回收实际释放磁盘', async () => {
    const chunks: string[] = []
    const pm = new ProcessManager({
      store,
      runsFile: resolveAppPaths(baseDir).runsFile,
      taskOps,
      broadcaster: () => undefined
    })
    const lm = new LogManager({
      store,
      logsDir,
      tailPollIntervalMs: 300,
      broadcaster: (chunk) => chunks.push(...chunk.lines)
    })
    pm.setLogHooks({
      onRunStarted: (event: RunStartedEvent) => {
        launchedPids.add(event.pid)
        lm.handleRunStarted(event)
      }
    })

    const current = store.listProjects().find((p) => p.id === projectId)
    if (!current) throw new Error('测试项目不存在')
    await store.updateProject({
      ...current,
      programArgs: ['--interval=0', '--duration=120']
    })

    const started = await pm.startProject(projectId)
    expect(started.ok).toBe(true)

    const runDir = path.join(logsDir, projectId)
    await waitFor(
      async () => {
        try {
          const names = await readdir(runDir)
          return (
            names.some((name) => /\.log\.\d+$/.test(name)) &&
            (await lm.getStorageInfo()).totalBytes > MAX_TOTAL_BYTES
          )
        } catch {
          return false
        }
      },
      90_000,
      '真实 stdout 输出触发单文件轮转'
    )

    const names = await readdir(runDir)
    const baseName = names.find((name) => /^\d{8}-\d{6}-[0-9a-f]{8}\.log$/.test(name))
    expect(baseName).toBeDefined()
    const baseStat = await stat(path.join(runDir, baseName as string))
    // 单文件上限真实生效：当前文件不超过上限 + 一个批次余量
    expect(baseStat.size).toBeLessThanOrEqual(MAX_FILE_BYTES + 256 * 1024)
    expect(chunks.length).toBeGreaterThan(100)

    const before = await lm.getStorageInfo()
    expect(before.totalBytes).toBeGreaterThan(MAX_TOTAL_BYTES)

    await pm.stopProject(projectId)
    await pm.prepareForExit()
    await lm.shutdown()

    const after = await lm.getStorageInfo()
    // 目标上限是可回收目标：活动 run 结束后超限部分必须被真实回收
    expect(after.totalBytes).toBeLessThanOrEqual(MAX_TOTAL_BYTES)
    expect(after.totalBytes).toBeLessThan(before.totalBytes)
    expect(after.errors).toEqual([])
  }, 150_000)
})
