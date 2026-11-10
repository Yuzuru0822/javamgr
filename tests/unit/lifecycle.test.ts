import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/main/config/config-store'
import { resolveAppPaths } from '../../src/main/config/paths'
import { ProcessManager } from '../../src/main/process/process-manager'
import type { SpawnFn } from '../../src/main/process/process-manager'
import { prepareExit } from '../../src/main/lifecycle'
import type { TaskOps } from '../../src/main/process/task-killer'
import type { ChildProcess } from 'node:child_process'
import type { Settings } from '../../src/shared/types'

/**
 * lifecycle 单测：keep（默认）不动子进程仅落 runs.json；stopAll 并行杀树。
 * （真实退出链路属 GUI 手工走查 A13/A14；此处验证服务层语义）
 */

let baseDir: string
let store: ConfigStore
let projectId: string

function fakeSpawner(): { spawner: SpawnFn; children: EventEmitter[] } {
  const children: EventEmitter[] = []
  let nextPid = 7000
  const spawner = (() => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number
      stdout: PassThrough
      stderr: PassThrough
      unref(): void
    }
    child.pid = nextPid++
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.unref = () => {}
    children.push(child)
    return child as unknown as ChildProcess
  }) as SpawnFn
  return { spawner, children }
}

function mockTaskOps(): { taskOps: TaskOps; killed: number[] } {
  const killed: number[] = []
  const taskOps: TaskOps = {
    probeAlive(pid) {
      return !killed.includes(pid)
    },
    async isAlive(pid) {
      return { alive: !killed.includes(pid) }
    },
    async batchQueryProcesses() {
      return new Map()
    },
    async killTree(pid) {
      killed.push(pid)
      return { ok: true, durationMs: 5 }
    }
  }
  return { taskOps, killed }
}

const settings = (patch: Partial<Settings>): Settings => ({
  mcpEnabled: true,
  mcpPort: 7777,
  exitPolicy: 'keep',
  startupGraceSeconds: 60,
  pollIntervalSeconds: 5,
  tailInitialLines: 200,
  logMaxFileMb: 10,
  logMaxRotations: 3,
  logRunsToKeep: 10,
  scanRoots: [],
  closeToTray: true,
  ...patch
})

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-lifecycle-'))
  const jar = path.join(baseDir, 'app.jar')
  await writeFile(jar, 'x')
  // 自包含假 JDK 树（doStart 前置校验检查 bin\java.exe 存在性，不依赖本机安装）
  const jdkHome = path.join(baseDir, 'jdk')
  await mkdir(path.join(jdkHome, 'bin'), { recursive: true })
  await writeFile(path.join(jdkHome, 'bin', 'java.exe'), 'fake')
  store = new ConfigStore(resolveAppPaths(baseDir))
  await store.init()
  await store.addJdk({
    id: 'j',
    name: 'J',
    homePath: jdkHome,
    version: '17',
    vendor: 'v',
    source: 'manual'
  })
  projectId = (
    await store.createProject({
      name: 'P',
      jarPath: jar,
      jdkId: 'j',
      jvmArgs: [],
      programArgs: [],
      envVars: {}
    })
  ).id
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('lifecycle / prepareExit', () => {
  it('keep（默认）：不动子进程，runs.json 为存活进程续写记录', async () => {
    const { spawner } = fakeSpawner()
    const { taskOps, killed } = mockTaskOps()
    const pm = new ProcessManager({
      store,
      runsFile: resolveAppPaths(baseDir).runsFile,
      taskOps,
      spawner
    })
    await pm.startProject(projectId)

    const outcome = await prepareExit(settings({ exitPolicy: 'keep' }), pm)
    expect(outcome.policy).toBe('keep')
    expect(killed).toHaveLength(0) // 不杀
    const runs = JSON.parse(await readFile(resolveAppPaths(baseDir).runsFile, 'utf8')) as Array<{
      projectId: string
    }>
    expect(runs).toHaveLength(1) // 记录落盘（下次启动重识别）
    expect(pm.getRuntimeState(projectId)?.status).toBe('STARTING') // 状态不被退出流程破坏
  })

  it('stopAll：退出前逐项目 taskkill 并出清记录', async () => {
    const { spawner } = fakeSpawner()
    const { taskOps, killed } = mockTaskOps()
    const pm = new ProcessManager({
      store,
      runsFile: resolveAppPaths(baseDir).runsFile,
      taskOps,
      spawner
    })
    await pm.startProject(projectId)

    const outcome = await prepareExit(settings({ exitPolicy: 'stopAll' }), pm)
    expect(outcome.policy).toBe('stopAll')
    expect(outcome.attempted).toBe(1)
    expect(outcome.failed).toHaveLength(0)
    expect(killed).toHaveLength(1)
    expect(pm.getRuntimeState(projectId)?.status).toBe('STOPPED')
    const runs = JSON.parse(await readFile(resolveAppPaths(baseDir).runsFile, 'utf8')) as unknown[]
    expect(runs).toHaveLength(0)
  })
})
