import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { BuildRunner, resolveBuildWorkDir } from '../../src/main/maven/build-runner'
import type { BuildOutputEvent, BuildStatusEvent, Jdk, Maven, Project } from '../../src/shared/types'
import type { KillResult } from '../../src/main/process/task-killer'

/**
 * BuildRunner 单测（v0.7.0 构建按钮）。
 *
 * 策略：spawn 全注入（fake child = EventEmitter + stdout/stderr 流），不执行真实 cmd.exe；
 * Maven home 用临时目录构造（bin\mvn.cmd 真实存在——BuildRunner 启动前探测脚本），
 * buildDir 存在性校验同样用临时目录。输出批量推送走 200ms interval——用例直接等待
 * flushTimer 或用 vi.useFakeTimers 驱动；这里用真实定时器 + 短等待（终态 finish 前
 * 强制 flush，断言点都取在 finish 之后，不依赖 interval 时序）。
 */

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-buildrun-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

// ---------- 夹具 ----------

const jdk: Jdk = {
  id: 'jdk-17',
  name: 'Temurin 17',
  homePath: 'D:\\java17',
  version: '17.0.12',
  vendor: 'Temurin',
  source: 'manual'
}

async function makeMavenHome(dir: string): Promise<Maven> {
  await mkdir(path.join(dir, 'bin'), { recursive: true })
  await writeFile(path.join(dir, 'bin', 'mvn.cmd'), '@echo off\r\n', 'utf8')
  await mkdir(path.join(dir, 'lib'), { recursive: true })
  await writeFile(path.join(dir, 'lib', 'maven-core-3.9.9.jar'), 'fake', 'utf8')
  return {
    id: 'maven-39',
    name: 'Apache Maven 3.9.9',
    homePath: dir,
    version: '3.9.9',
    settingsPath: 'D:\\my-settings.xml',
    localRepoPath: 'D:\\m2\\repo',
    source: 'manual'
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'BuildableSvc',
    jarPath: 'D:\\proj\\target\\app.jar',
    jdkId: jdk.id,
    jvmArgs: [],
    programArgs: [],
    envVars: { APP_ENV: 'demo' },
    mavenId: 'maven-39',
    buildCommand: 'clean package -DskipTests',
    ...overrides
  }
}

/** fake spawn：记录调用参数，返回可编程 child（emitClose 手动驱动退出） */
function makeFakeSpawner() {
  const calls: Array<{
    file: string
    args: string[]
    options: Record<string, unknown> & { cwd?: string; env?: NodeJS.ProcessEnv }
  }> = []
  const children: FakeChild[] = []
  const spawner = ((file: string, args: string[], options: never): FakeChild => {
    const child = new FakeChild()
    calls.push({ file, args, options: options as unknown as Record<string, unknown> })
    children.push(child)
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { spawner, calls, children }
}

class FakeChild extends EventEmitter {
  pid = 4321
  stdout = new EventEmitter() as EventEmitter & { on: (e: string, cb: (b: Buffer) => void) => void }
  stderr = new EventEmitter() as EventEmitter & { on: (e: string, cb: (b: Buffer) => void) => void }
  kill = vi.fn()
  // process.spawn 返回 ChildProcess；BuildRunner 只用 pid/stdout/stderr/on/kill
  asChild(): ChildProcess {
    return this as unknown as ChildProcess
  }
}

function makeRunner(project: Project, maven: Maven, fake: ReturnType<typeof makeFakeSpawner>) {
  const outputs: BuildOutputEvent[] = []
  const statuses: BuildStatusEvent[] = []
  const killTree = vi.fn(async (): Promise<KillResult> => ({ ok: true, durationMs: 5 }))
  const runner = new BuildRunner({
    store: { listProjects: () => [project], listMavens: () => [maven], listJdks: () => [jdk] },
    killTree: killTree as unknown as (pid: number, timeoutMs?: number) => Promise<KillResult>,
    broadcastOutput: (e) => outputs.push(e),
    broadcastStatus: (e) => statuses.push(e),
    spawner: fake.spawner as unknown as typeof import('node:child_process').spawn
  })
  return { runner, outputs, statuses, killTree }
}

/** 等到 fn 返回真（轮询 10ms，超时 fail） */
async function until(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('until 超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------- resolveBuildWorkDir ----------

describe('resolveBuildWorkDir 构建目录推断', () => {
  it('显式 buildDir 优先（resolve 归一）', () => {
    const p = makeProject({ buildDir: 'D:\\work\\proj' })
    expect(resolveBuildWorkDir(p)).toBe('D:\\work\\proj')
  })

  it('jar 在 target\\ 下 → 项目根（上一级）', () => {
    expect(resolveBuildWorkDir(makeProject())).toBe('D:\\proj')
  })

  it('jar 与 pom 平级 → jar 所在目录', () => {
    const p = makeProject({ jarPath: 'D:\\flat\\app.jar', buildDir: undefined })
    expect(resolveBuildWorkDir(p)).toBe('D:\\flat')
  })
})

// ---------- run：命令与环境派生 ----------

describe('BuildRunner.run 命令派生', () => {
  it('拼装 cmd.exe /d /s /c + -B + settings/仓库参数 + goals；JAVA_HOME 注入绑定 JDK', async () => {
    const maven = await makeMavenHome(path.join(baseDir, 'maven'))
    const fake = makeFakeSpawner()
    const { runner } = makeRunner(makeProject(), maven, fake)

    const state = await runner.run('p1')

    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]!
    expect(call.file).toBe('cmd.exe')
    expect(call.args[0]).toBe('/d')
    expect(call.args[1]).toBe('/s')
    expect(call.args[2]).toBe('/c')
    const cmdline = call.args[3] as string
    expect(cmdline.startsWith(`"${path.join(maven.homePath, 'bin', 'mvn.cmd')}"`)).toBe(true)
    expect(cmdline).toContain('-B')
    expect(cmdline).toContain('-s D:\\my-settings.xml')
    expect(cmdline).toContain('-Dmaven.repo.local=D:\\m2\\repo')
    expect(cmdline).toContain('clean package -DskipTests')
    // cwd = target 上一级（项目根）；env 注入 JAVA_HOME / PATH 前置 / 项目 envVars
    expect(call.options.cwd).toBe('D:\\proj')
    const env = call.options.env as NodeJS.ProcessEnv
    expect(env.JAVA_HOME).toBe('D:\\java17')
    expect(env.PATH!.startsWith('D:\\java17\\bin' + path.delimiter)).toBe(true)
    expect(env.APP_ENV).toBe('demo')
    expect(state.status).toBe('running')
    expect(state.commandLine).toBe(cmdline)
    expect(state.workDir).toBe('D:\\proj')
  })

  it('未配 buildCommand → 缺省 clean package；settings/仓库未配则不追加参数', async () => {
    const maven = await makeMavenHome(path.join(baseDir, 'maven'))
    delete maven.settingsPath
    delete maven.localRepoPath
    const fake = makeFakeSpawner()
    const { runner } = makeRunner(makeProject({ buildCommand: undefined }), maven, fake)

    await runner.run('p1')

    const cmdline = fake.calls[0]!.args[3] as string
    expect(cmdline.endsWith('-B clean package')).toBe(true)
  })

  it('未绑定 Maven / Maven 缺失 / JDK 缺失 → 中文错误，不 spawn', async () => {
    const maven = await makeMavenHome(path.join(baseDir, 'maven'))
    const fake = makeFakeSpawner()
    const { runner } = makeRunner(makeProject({ mavenId: undefined }), maven, fake)
    await expect(runner.run('p1')).rejects.toThrow('未配置构建信息')

    const fake2 = makeFakeSpawner()
    const { runner: runner2 } = makeRunner(makeProject({ mavenId: 'gone' }), maven, fake2)
    await expect(runner2.run('p1')).rejects.toThrow('Maven 已不存在')

    const fake3 = makeFakeSpawner()
    const { runner: runner3 } = makeRunner(makeProject({ jdkId: 'gone' }), maven, fake3)
    await expect(runner3.run('p1')).rejects.toThrow('JDK 已不存在')

    expect(fake.calls).toHaveLength(0)
    expect(fake2.calls).toHaveLength(0)
    expect(fake3.calls).toHaveLength(0)
  })

  it('显式 buildDir 不存在 → 报错；存在 → 使用该目录', async () => {
    const maven = await makeMavenHome(path.join(baseDir, 'maven'))
    const fake = makeFakeSpawner()
    const { runner } = makeRunner(makeProject({ buildDir: path.join(baseDir, 'nope') }), maven, fake)
    await expect(runner.run('p1')).rejects.toThrow('构建目录不存在')

    const workDir = path.join(baseDir, 'proj-root')
    await mkdir(workDir, { recursive: true })
    const fake2 = makeFakeSpawner()
    const { runner: runner2 } = makeRunner(makeProject({ buildDir: workDir }), maven, fake2)
    const state = await runner2.run('p1')
    expect(fake2.calls[0]!.options.cwd).toBe(workDir)
    expect(state.workDir).toBe(workDir)
  })

  it('同一项目重复 run → 报错；不同项目互不影响', async () => {
    const maven = await makeMavenHome(path.join(baseDir, 'maven'))
    const fake = makeFakeSpawner()
    const { runner } = makeRunner(makeProject(), maven, fake)
    await runner.run('p1')
    await expect(runner.run('p1')).rejects.toThrow('正在构建中')
    expect(fake.calls).toHaveLength(1)
  })
})

// ---------- 输出流与终态 ----------

describe('BuildRunner 输出流与终态', () => {
  it('stdout/stderr 合并行切分（\r 剥离 + 跨块字节拼接）；退出码 0 → success', async () => {
    const maven = await makeMavenHome(path.join(baseDir, 'maven'))
    const fake = makeFakeSpawner()
    const { runner, outputs, statuses } = makeRunner(makeProject(), maven, fake)
    await runner.run('p1')
    const child = fake.children[0]!

    child.stdout.emit('data', Buffer.from('[INFO] Scanning for projects...\r\n[INFO] Build'))
    child.stderr.emit('data', Buffer.from('ing...',)) // 拼接跨块
    child.stdout.emit('data', Buffer.from('\n[ERROR] boom\r\n'))

    child.emit('close', 0)
    await until(() => statuses.length > 0)

    const state = runner.getState('p1')!
    expect(state.status).toBe('success')
    expect(state.exitCode).toBe(0)
    expect(state.durationMs).toBeGreaterThanOrEqual(0)
    expect(state.lines).toEqual([
      '[INFO] Scanning for projects...',
      '[INFO] Building...',
      '[ERROR] boom',
      expect.stringContaining('构建结束：成功')
    ])
    // 事件：输出批量（≥1 批）+ 终态
    const outputLines = outputs.flatMap((o) => o.lines)
    expect(outputLines).toContain('[ERROR] boom')
    expect(statuses[0]).toMatchObject({ projectId: 'p1', status: 'success', exitCode: 0 })
  })

  it('非零退出码 → failure；GBK 行回退解码', async () => {
    const maven = await makeMavenHome(path.join(baseDir, 'maven'))
    const fake = makeFakeSpawner()
    const { runner, statuses } = makeRunner(makeProject(), maven, fake)
    await runner.run('p1')
    const child = fake.children[0]!

    // GBK 编码的「构建失败」(B9 B9 BD A8 CA A7 B0 DC)
    child.stdout.emit('data', Buffer.concat([Buffer.from('GBK: '), Buffer.from([0xb9, 0xb9, 0xbd, 0xa8, 0xca, 0xa7, 0xb0, 0xdc]), Buffer.from('\n')]))
    child.emit('close', 1)
    await until(() => statuses.length > 0)

    const state = runner.getState('p1')!
    expect(state.status).toBe('failure')
    expect(state.exitCode).toBe(1)
    expect(state.lines.some((l) => l.includes('构建失败'))).toBe(true)
  })

  it('取消：stop 杀树 + cancelled 终态（无退出码）', async () => {
    const maven = await makeMavenHome(path.join(baseDir, 'maven'))
    const fake = makeFakeSpawner()
    const { runner, killTree, statuses } = makeRunner(makeProject(), maven, fake)
    await runner.run('p1')
    const child = fake.children[0]!

    await runner.stop('p1')
    expect(killTree).toHaveBeenCalledWith(4321, 8000)

    child.emit('close', 1) // 杀树后 close（码任意）
    await until(() => statuses.length > 0)

    const state = runner.getState('p1')!
    expect(state.status).toBe('cancelled')
    expect(state.exitCode).toBeUndefined()
    expect(state.lines.some((l) => l.includes('取消'))).toBe(true)
    // 幂等：非 running 再 stop 不炸
    await expect(runner.stop('p1')).resolves.toBeUndefined()
  })

  it('终态后可再次 run（状态重置）；getState 未构建项目 → null', async () => {
    const maven = await makeMavenHome(path.join(baseDir, 'maven'))
    const fake = makeFakeSpawner()
    const { runner, statuses } = makeRunner(makeProject(), maven, fake)
    await runner.run('p1')
    fake.children[0]!.emit('close', 0)
    await until(() => statuses.length > 0)

    const again = await runner.run('p1')
    expect(again.status).toBe('running')
    expect(again.lines).toEqual([]) // 新构建输出从头计

    expect(runner.getState('ghost')).toBeNull()
  })

  it('输出缓冲上限：超 5000 行丢头保尾', async () => {
    vi.setConfig({ testTimeout: 30_000 })
    const maven = await makeMavenHome(path.join(baseDir, 'maven'))
    const fake = makeFakeSpawner()
    const { runner } = makeRunner(makeProject(), maven, fake)
    await runner.run('p1')
    const child = fake.children[0]!

    const big = Buffer.from(
      Array.from({ length: 5_100 }, (_, i) => `line-${i}\n`).join('')
    )
    child.stdout.emit('data', big)
    child.emit('close', 0)
    await until(() => runner.getState('p1')?.status === 'success')

    const lines = runner.getState('p1')!.lines
    expect(lines.length).toBeLessThanOrEqual(5_000 + 2) // 上限 + 收尾行
    expect(lines).toContain('line-5099')
    expect(lines).not.toContain('line-0')
  })
})
