import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore, DEFAULT_SETTINGS } from '../../src/main/config/config-store'
import { resolveAppPaths } from '../../src/main/config/paths'
import type { AppPaths } from '../../src/main/config/paths'

let baseDir: string
let paths: AppPaths

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-log-settings-'))
  paths = resolveAppPaths(baseDir)
  await mkdir(paths.configDir, { recursive: true })
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('stdout 日志治理设置', () => {
  it('新配置默认 7 天、512 MiB、默认目录', async () => {
    const store = new ConfigStore(paths)
    await store.init()

    expect(DEFAULT_SETTINGS.logRetentionDays).toBe(7)
    expect(DEFAULT_SETTINGS.logMaxTotalMb).toBe(512)
    expect(DEFAULT_SETTINGS.stdoutLogDir).toBe('')
    expect(store.getSettings()).toMatchObject({
      logRetentionDays: 7,
      logMaxTotalMb: 512,
      stdoutLogDir: ''
    })
  })

  it('旧配置缺少新字段时合并默认值，并保留已有设置', async () => {
    await writeFile(
      paths.settingsFile,
      JSON.stringify({ mcpPort: 7800, logRunsToKeep: 4, closeToTray: false }),
      'utf8'
    )

    const store = new ConfigStore(paths)
    await store.init()

    expect(store.getSettings()).toMatchObject({
      mcpPort: 7800,
      logRunsToKeep: 4,
      closeToTray: false,
      logRetentionDays: 7,
      logMaxTotalMb: 512,
      stdoutLogDir: ''
    })
  })

  it('日志保留参数越界时回落默认值（不得因 logRunsToKeep=0 演变为清空全部历史）', async () => {
    await writeFile(
      paths.settingsFile,
      JSON.stringify({
        mcpPort: 7800,
        logMaxFileMb: -5,
        logMaxRotations: 0,
        logRunsToKeep: -5,
        logRetentionDays: 0,
        logMaxTotalMb: 0
      }),
      'utf8'
    )

    const store = new ConfigStore(paths)
    await store.init()

    expect(store.getSettings()).toMatchObject({
      mcpPort: 7800,
      logMaxFileMb: DEFAULT_SETTINGS.logMaxFileMb,
      logMaxRotations: DEFAULT_SETTINGS.logMaxRotations,
      logRunsToKeep: DEFAULT_SETTINGS.logRunsToKeep,
      logRetentionDays: DEFAULT_SETTINGS.logRetentionDays,
      logMaxTotalMb: DEFAULT_SETTINGS.logMaxTotalMb
    })
  })

  it('非有限数与非整数同样回落默认值', async () => {
    await writeFile(
      paths.settingsFile,
      '{"mcpPort":7800,"logMaxFileMb":1e999,"logMaxRotations":1e999,"logRunsToKeep":1.5,"logRetentionDays":1e999,"logMaxTotalMb":1e999}',
      'utf8'
    )

    const store = new ConfigStore(paths)
    await store.init()

    expect(store.getSettings()).toMatchObject({
      mcpPort: 7800,
      logMaxFileMb: DEFAULT_SETTINGS.logMaxFileMb,
      logMaxRotations: DEFAULT_SETTINGS.logMaxRotations,
      logRunsToKeep: DEFAULT_SETTINGS.logRunsToKeep,
      logRetentionDays: DEFAULT_SETTINGS.logRetentionDays,
      logMaxTotalMb: DEFAULT_SETTINGS.logMaxTotalMb
    })
  })
})
