import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONFIG_EVENTS,
  ConfigError,
  ConfigStore,
  DEFAULT_SETTINGS
} from '../../src/main/config/config-store'
import type { JdkInput } from '../../src/main/config/config-store'
import { resolveAppPaths } from '../../src/main/config/paths'
import type { AppPaths } from '../../src/main/config/paths'
import type { ProjectInput, Settings } from '../../src/shared/types'

let baseDir: string
let paths: AppPaths

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-store-'))
  paths = resolveAppPaths(baseDir)
  // 损坏文件用例需要预置 config/ 目录（真实场景由 ensureDirs/上次运行创建）
  await mkdir(paths.configDir, { recursive: true })
  // 损坏自愈会走 console.warn —— 单测中静默，保持输出干净（行为断言看文件系统）
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(baseDir, { recursive: true, force: true })
})

async function makeStore(): Promise<ConfigStore> {
  const store = new ConfigStore(paths)
  await store.init()
  return store
}

function projectInput(name = 'LoggyDemo'): ProjectInput {
  return {
    name,
    jarPath: 'C:\\javamgr\\fixtures\\loggy.jar',
    jdkId: 'jdk-temurin-17',
    jvmArgs: ['-Xms128m', '-Xmx256m'],
    programArgs: ['--interval=1000'],
    envVars: { APP_ENV: 'demo' }
  }
}

function jdkInput(name = 'Temurin 17.0.9'): JdkInput {
  return {
    name,
    homePath: 'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.9.9-hotspot',
    version: '17.0.9',
    vendor: 'Eclipse Adoptium',
    source: 'manual'
  }
}

const readJsonFile = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(file, 'utf8'))

// ---------- projects CRUD + 变更即写 ----------

describe('projects CRUD', () => {
  it('首次 init：空目录建默认文件（三个 JSON 均存在）', async () => {
    await makeStore()
    const files = await readdir(paths.configDir)
    expect(new Set(files)).toEqual(new Set(['projects.json', 'jdks.json', 'settings.json']))
  })

  it('create 生成 uuid id 并出现在列表与磁盘（变更即写，无防抖）', async () => {
    const store = await makeStore()
    const created = await store.createProject(projectInput())

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    expect(created.name).toBe('LoggyDemo')
    expect(store.listProjects()).toHaveLength(1)

    // await 返回即已落盘：直接读文件核对（S-6 变更即写语义）
    const onDisk = (await readJsonFile(paths.projectsFile)) as Array<{ id: string; name: string }>
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0]?.id).toBe(created.id)
    expect(onDisk[0]?.name).toBe('LoggyDemo')
  })

  it('update 全量替换字段并即时落盘；不存在则 NOT_FOUND', async () => {
    const store = await makeStore()
    const created = await store.createProject(projectInput())

    const updated = await store.updateProject({
      ...projectInput('LoggyRenamed'),
      id: created.id,
      jvmArgs: ['-Xmx512m']
    })
    expect(updated.name).toBe('LoggyRenamed')
    expect(updated.jvmArgs).toEqual(['-Xmx512m'])
    expect(store.listProjects()[0]?.name).toBe('LoggyRenamed')

    const onDisk = (await readJsonFile(paths.projectsFile)) as Array<{ name: string }>
    expect(onDisk[0]?.name).toBe('LoggyRenamed')

    await expect(store.updateProject({ ...projectInput(), id: 'no-such-id' })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it('delete 移除并即时落盘；不存在则 NOT_FOUND', async () => {
    const store = await makeStore()
    const created = await store.createProject(projectInput())

    const removed = await store.deleteProject(created.id)
    expect(removed.id).toBe(created.id)
    expect(store.listProjects()).toHaveLength(0)
    expect(await readJsonFile(paths.projectsFile)).toEqual([])

    await expect(store.deleteProject(created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('create 后返回值是深拷贝：改返回值不污染缓存与磁盘', async () => {
    const store = await makeStore()
    const created = await store.createProject(projectInput())
    ;(created as { name: string }).name = '篡改'
    expect(store.listProjects()[0]?.name).toBe('LoggyDemo')
  })

  it('重开 store（重启应用）：配置完整恢复（A12 持久化）', async () => {
    const first = await makeStore()
    await first.createProject(projectInput('KeepMe'))
    await first.setSettings({ mcpPort: 7788, exitPolicy: 'stopAll' })

    const second = await makeStore()
    expect(second.listProjects().map((p) => p.name)).toEqual(['KeepMe'])
    expect(second.getSettings().mcpPort).toBe(7788)
    expect(second.getSettings().exitPolicy).toBe('stopAll')
  })
})

// ---------- 损坏文件备份重建 ----------

describe('损坏文件备份重建', () => {
  it('projects.json JSON 非法 → rename 为 .corrupt-<ts> 备份 + 重建默认空列表', async () => {
    const garbage = '{ 不是合法 JSON'
    await writeFile(paths.projectsFile, garbage, 'utf8')

    const store = await makeStore()
    expect(store.listProjects()).toEqual([])

    const files = await readdir(paths.configDir)
    const backup = files.find((f) => /^projects\.json\.corrupt-\d+$/.test(f))
    expect(backup).toBeDefined()
    expect(await readFile(path.join(paths.configDir, backup as string), 'utf8')).toBe(garbage)

    // 重建后新文件合法且可继续工作
    await store.createProject(projectInput('AfterCorrupt'))
    const onDisk = (await readJsonFile(paths.projectsFile)) as Array<{ name: string }>
    expect(onDisk[0]?.name).toBe('AfterCorrupt')
  })

  it('结构不符（如 projects.json 存对象而非数组）→ 同样走备份重建', async () => {
    await writeFile(paths.projectsFile, JSON.stringify({ oops: true }), 'utf8')
    const store = await makeStore()
    expect(store.listProjects()).toEqual([])
    const files = await readdir(paths.configDir)
    expect(files.some((f) => /^projects\.json\.corrupt-\d+$/.test(f))).toBe(true)
  })

  it('settings.json 损坏 → 恢复默认值', async () => {
    await writeFile(paths.settingsFile, '}}}broken', 'utf8')
    const store = await makeStore()
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('settings.json 缺字段（旧版本升级）→ 回补默认值而非判损坏', async () => {
    await writeFile(paths.settingsFile, JSON.stringify({ mcpPort: 7800 }), 'utf8')
    const store = await makeStore()
    const s = store.getSettings()
    expect(s.mcpPort).toBe(7800)
    expect(s.mcpEnabled).toBe(DEFAULT_SETTINGS.mcpEnabled)
    expect(s.exitPolicy).toBe(DEFAULT_SETTINGS.exitPolicy)
  })

  it('settings.json 字段类型错乱 → 判损坏走备份重建', async () => {
    await writeFile(paths.settingsFile, JSON.stringify({ mcpPort: '七千' }), 'utf8')
    const store = await makeStore()
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
  })
})

// ---------- jdks CRUD + 引用校验 ----------

describe('jdks CRUD 与项目引用校验', () => {
  it('add 缺省 id 时生成 uuid；list/update/remove 全链路', async () => {
    const store = await makeStore()
    const added = await store.addJdk(jdkInput())
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(store.listJdks()).toHaveLength(1)

    const updated = await store.updateJdk({ ...added, name: 'Temurin 17.0.10' })
    expect(updated.name).toBe('Temurin 17.0.10')

    const removed = await store.removeJdk(added.id)
    expect(removed.id).toBe(added.id)
    expect(store.listJdks()).toHaveLength(0)
  })

  it('remove 被 JDK 引用时拒绝，错误信息含引用项目名', async () => {
    const store = await makeStore()
    const jdk = await store.addJdk(jdkInput())
    await store.createProject({ ...projectInput('LoggyDemo'), jdkId: jdk.id })
    await store.createProject({ ...projectInput('WorkerB'), jdkId: jdk.id })

    const err = await store.removeJdk(jdk.id).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect((err as ConfigError).code).toBe('CONFLICT')
    expect((err as ConfigError).message).toContain('LoggyDemo')
    expect((err as ConfigError).message).toContain('WorkerB')
    expect(store.listJdks()).toHaveLength(1) // 未被删除

    // 删除引用项目后可正常移除
    await store.deleteProject(store.listProjects()[0]!.id)
    await store.deleteProject(store.listProjects()[0]!.id)
    await expect(store.removeJdk(jdk.id)).resolves.toMatchObject({ id: jdk.id })
  })

  it('remove/update 未知 id → NOT_FOUND', async () => {
    const store = await makeStore()
    await expect(store.removeJdk('ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      store.updateJdk({ ...jdkInput(), id: 'ghost' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// ---------- settings ----------

describe('settings get/set 局部合并', () => {
  it('默认值完整（mcpPort=7777 / keep / 5s 轮询等）', async () => {
    const store = await makeStore()
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
    expect(store.getSettings().mcpPort).toBe(7777)
  })

  it('set 局部合并：只改传入键，其余保留现值，且即时落盘', async () => {
    const store = await makeStore()
    const merged = await store.setSettings({ mcpPort: 7788 })

    expect(merged.mcpPort).toBe(7788)
    expect(merged.exitPolicy).toBe('keep') // 未传键保留
    expect(store.getSettings().mcpPort).toBe(7788)

    const onDisk = (await readJsonFile(paths.settingsFile)) as Partial<Settings>
    expect(onDisk.mcpPort).toBe(7788)
    expect(onDisk.mcpEnabled).toBe(true)

    // 二次局部合并叠加
    await store.setSettings({ closeToTray: false })
    expect(store.getSettings().mcpPort).toBe(7788)
    expect(store.getSettings().closeToTray).toBe(false)
  })
})

// ---------- 事件通知（后续 IPC/MCP 广播复用） ----------

describe('变更事件（EventEmitter）', () => {
  it('projects:changed / jdks:changed / settings:changed 各自携带变更后的完整值', async () => {
    const store = await makeStore()
    const seen: Array<{ event: string; payload: unknown }> = []
    store.on(CONFIG_EVENTS.PROJECTS_CHANGED, (payload: unknown) =>
      seen.push({ event: CONFIG_EVENTS.PROJECTS_CHANGED, payload })
    )
    store.on(CONFIG_EVENTS.JDKS_CHANGED, (payload: unknown) =>
      seen.push({ event: CONFIG_EVENTS.JDKS_CHANGED, payload })
    )
    store.on(CONFIG_EVENTS.SETTINGS_CHANGED, (payload: unknown) =>
      seen.push({ event: CONFIG_EVENTS.SETTINGS_CHANGED, payload })
    )

    const project = await store.createProject(projectInput())
    await store.addJdk(jdkInput())
    await store.setSettings({ mcpPort: 7790 })
    await store.deleteProject(project.id)

    expect(seen.map((s) => s.event)).toEqual([
      CONFIG_EVENTS.PROJECTS_CHANGED,
      CONFIG_EVENTS.JDKS_CHANGED,
      CONFIG_EVENTS.SETTINGS_CHANGED,
      CONFIG_EVENTS.PROJECTS_CHANGED
    ])

    const firstProjects = seen[0]?.payload as Array<{ name: string }>
    expect(firstProjects).toHaveLength(1)
    expect(firstProjects[0]?.name).toBe('LoggyDemo')

    const lastProjects = seen[3]?.payload as unknown[]
    expect(lastProjects).toHaveLength(0)

    const settingsPayload = seen[2]?.payload as Partial<Settings>
    expect(settingsPayload.mcpPort).toBe(7790)
  })

  it('事件载荷为深拷贝：外部改动不影响 store 内部缓存', async () => {
    const store = await makeStore()
    let captured: unknown
    store.on(CONFIG_EVENTS.SETTINGS_CHANGED, (payload: unknown) => {
      captured = payload
    })
    await store.setSettings({ mcpPort: 7791 })
    ;(captured as { mcpPort: number }).mcpPort = 1
    expect(store.getSettings().mcpPort).toBe(7791)
  })
})

// ---------- 原子写 ----------

describe('原子写（tmp → rename）', () => {
  it('每次变更后磁盘文件始终为合法 JSON（无中间态可见残缺文件）', async () => {
    const store = await makeStore()
    for (let i = 0; i < 5; i++) {
      await store.createProject(projectInput(`P${i}`))
      // 逐次读取：任何一次 await 返回后文件都必须完整合法
      const names = ((await readJsonFile(paths.projectsFile)) as Array<{ name: string }>).map(
        (p) => p.name
      )
      expect(names).toHaveLength(i + 1)
    }
    // 无 .tmp 残留
    const files = await readdir(paths.configDir)
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
  })
})
