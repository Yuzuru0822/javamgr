import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureUserData, ensureDirs, getPaths, getUserDataDir, resolveAppPaths } from '../../src/main/config/paths'

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('resolveAppPaths（纯函数派生，不触文件系统）', () => {
  it('按 <userData>/config + <userData>/logs 布局派生全部路径', () => {
    const userData = path.join('C:', 'Users', 'dev', 'AppData', 'Roaming', 'javamgr')
    const p = resolveAppPaths(userData)

    expect(p.userDataDir).toBe(userData)
    expect(p.configDir).toBe(path.join(userData, 'config'))
    expect(p.logsDir).toBe(path.join(userData, 'logs'))
    expect(p.projectsFile).toBe(path.join(userData, 'config', 'projects.json'))
    expect(p.jdksFile).toBe(path.join(userData, 'config', 'jdks.json'))
    expect(p.settingsFile).toBe(path.join(userData, 'config', 'settings.json'))
    expect(p.runsFile).toBe(path.join(userData, 'runs.json'))
    expect(p.mcpPortFile).toBe(path.join(userData, 'mcp.port'))
  })
})

describe('注入式 userData（纯 Node 环境零 electron 依赖）', () => {
  it('未配置时 getUserDataDir 抛出明确指引错误', () => {
    // 本文件首个用例：模块尚未经过 configureUserData（vitest 按文件隔离模块注册表）
    expect(() => getUserDataDir()).toThrow(/configureUserData/)
    expect(() => getPaths()).toThrow(/configureUserData/)
  })

  it('configureUserData 注入目录后 getPaths/ensureDirs 可用且幂等', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'jpm-paths-'))
    configureUserData(tempDir)

    const p = getPaths()
    expect(p.userDataDir).toBe(tempDir)

    await ensureDirs()
    await ensureDirs() // 幂等

    const configDir = await stat(p.configDir)
    const logsDir = await stat(p.logsDir)
    expect(configDir.isDirectory()).toBe(true)
    expect(logsDir.isDirectory()).toBe(true)
  })

  it('支持惰性求值注入（app.getPath 场景）', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'jpm-paths-lazy-'))
    configureUserData(() => tempDir as string)
    expect(getPaths().userDataDir).toBe(tempDir)
  })
})
