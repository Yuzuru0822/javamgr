import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mergeMavens,
  normalizeHomePath,
  parseLocalRepoFromSettings,
  resolveLocalRepo,
  scanMavens,
  validateMavenPath
} from '../../src/main/maven/maven-scanner'
import type { Maven } from '../../src/shared/types'

/**
 * Maven 扫描器单测（2026-11-18，策略对齐 jdk-scanner）。
 *
 * 临时目录构造假 Maven 树：bin\mvn.cmd（假脚本，**不执行**）+ lib\maven-core-<v>.jar
 * （版本解析走文件名，零执行零 JDK 依赖）+ 可选 conf\settings.xml。
 * 环境探测注入 m2Home/mavenHome/pathEnv，不依赖本机真实安装；
 * os.homedir mock 到临时目录（resolveLocalRepo 的 ~/.m2 兜底分支不触真实家目录）。
 */

let baseDir: string
let homedirSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'jpm-mavenscan-'))
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(baseDir)
})

afterEach(async () => {
  homedirSpy.mockRestore()
  await rm(baseDir, { recursive: true, force: true })
})

const SETTINGS_WITH_REPO = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">',
  '  <!-- 注释容忍 -->',
  '  <localRepository>D:\\m2\\repo</localRepository>',
  '  <mirrors></mirrors>',
  '</settings>',
  ''
].join('\n')

/** 构造假 Maven home：bin\mvn.cmd + lib\maven-core-<version>.jar + 可选 conf\settings.xml */
async function makeFakeMaven(dir: string, version = '3.9.9', settings?: string) {
  await mkdir(path.join(dir, 'bin'), { recursive: true })
  await writeFile(path.join(dir, 'bin', 'mvn.cmd'), '@echo off\r\n', 'utf8')
  await mkdir(path.join(dir, 'lib'), { recursive: true })
  await writeFile(path.join(dir, 'lib', `maven-core-${version}.jar`), 'fake-jar', 'utf8')
  if (settings !== undefined) {
    await mkdir(path.join(dir, 'conf'), { recursive: true })
    await writeFile(path.join(dir, 'conf', 'settings.xml'), settings, 'utf8')
  }
  return dir
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ---------- validateMavenPath ----------

describe('validateMavenPath 手动路径校验', () => {
  it('bin\\mvn.cmd + lib jar → 版本派生 + 默认 settings 建议解析', async () => {
    const home = await makeFakeMaven(path.join(baseDir, 'apache-maven-3.9.9'), '3.9.9', SETTINGS_WITH_REPO)

    const validation = await validateMavenPath(home)

    expect(validation.ok).toBe(true)
    expect(validation.maven).toMatchObject({
      name: 'Apache Maven 3.9.9',
      version: '3.9.9',
      source: 'manual'
    })
    expect(validation.maven!.id).toMatch(UUID_RE)
    expect(normalizeHomePath(validation.maven!.homePath)).toBe(normalizeHomePath(home))
    expect(validation.defaultSettingsPath).toBe(path.join(home, 'conf', 'settings.xml'))
    expect(validation.settingsLocalRepo).toBe('D:\\m2\\repo')
  })

  it('无 conf\\settings.xml → 不给默认 settings 建议', async () => {
    const home = await makeFakeMaven(path.join(baseDir, 'maven-bare'))

    const validation = await validateMavenPath(home)

    expect(validation.ok).toBe(true)
    expect(validation.defaultSettingsPath).toBeUndefined()
    expect(validation.settingsLocalRepo).toBeUndefined()
  })

  it('settings.xml 存在但无 localRepository → 只给默认 settings 建议', async () => {
    const home = await makeFakeMaven(path.join(baseDir, 'maven-norepo'), '3.8.8', '<settings></settings>')

    const validation = await validateMavenPath(home)

    expect(validation.ok).toBe(true)
    expect(validation.defaultSettingsPath).toBe(path.join(home, 'conf', 'settings.xml'))
    expect(validation.settingsLocalRepo).toBeUndefined()
  })

  it('lib 无 maven-core jar → 版本 unknown，校验仍通过', async () => {
    const home = path.join(baseDir, 'maven-nolib')
    await mkdir(path.join(home, 'bin'), { recursive: true })
    await writeFile(path.join(home, 'bin', 'mvn.cmd'), '@echo off\r\n', 'utf8')
    await mkdir(path.join(home, 'lib'), { recursive: true })
    await writeFile(path.join(home, 'lib', 'maven-plugin-api-3.5.jar'), 'fake', 'utf8')

    const validation = await validateMavenPath(home)

    expect(validation.ok).toBe(true)
    expect(validation.maven).toMatchObject({ version: 'unknown', name: 'Maven unknown' })
  })

  it('启动脚本大小写变体（mvn.CMD / mvn.bat / mvn）均命中', async () => {
    for (const [i, scriptName] of ['mvn.CMD', 'mvn.bat', 'mvn'].entries()) {
      const home = path.join(baseDir, `maven-case-${i}`)
      await mkdir(path.join(home, 'bin'), { recursive: true })
      await writeFile(path.join(home, 'bin', scriptName), '@echo off\r\n', 'utf8')
      await mkdir(path.join(home, 'lib'), { recursive: true })
      await writeFile(path.join(home, 'lib', 'maven-core-3.6.3.jar'), 'fake', 'utf8')
      const validation = await validateMavenPath(home)
      expect(validation.ok, scriptName).toBe(true)
    }
  })

  it('空路径 / 无 bin\\mvn 脚本 → 中文错误', async () => {
    expect((await validateMavenPath('   ')).error).toBe('Maven 路径不能为空')
    const notMaven = path.join(baseDir, 'not-maven')
    await mkdir(notMaven, { recursive: true })
    const bad = await validateMavenPath(notMaven)
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('mvn.cmd')
    // bin 目录而非 home 目录 → 同样失败并提示"非 bin 目录"
    const binOnly = path.join(baseDir, 'maven-with-bin', 'bin')
    await mkdir(binOnly, { recursive: true })
    await writeFile(path.join(binOnly, 'mvn.cmd'), '@echo off\r\n', 'utf8')
    expect((await validateMavenPath(binOnly)).ok).toBe(false)
  })
})

// ---------- parseLocalRepoFromSettings ----------

describe('parseLocalRepoFromSettings', () => {
  it('相对路径按 settings.xml 所在目录解析', async () => {
    const file = path.join(baseDir, 'custom-settings.xml')
    await writeFile(file, '<settings><localRepository>../shared-repo</localRepository></settings>', 'utf8')

    expect(await parseLocalRepoFromSettings(file)).toBe(path.resolve(baseDir, '../shared-repo'))
  })

  it('元素缺失 / 文件不存在 → null', async () => {
    const noElement = path.join(baseDir, 'no-element.xml')
    await writeFile(noElement, '<settings><mirrors/></settings>', 'utf8')
    expect(await parseLocalRepoFromSettings(noElement)).toBeNull()
    expect(await parseLocalRepoFromSettings(path.join(baseDir, 'absent.xml'))).toBeNull()
  })
})

// ---------- scanMavens ----------

describe('scanMavens 环境探测', () => {
  it('M2_HOME / MAVEN_HOME / PATH 三来源合并去重（PATH 条目为 bin 目录）', async () => {
    const homeA = await makeFakeMaven(path.join(baseDir, 'maven-a'), '3.9.9')
    const homeB = await makeFakeMaven(path.join(baseDir, 'maven-b'), '3.8.8')
    const notMavenDir = path.join(baseDir, 'plain-dir')
    await mkdir(notMavenDir, { recursive: true })

    const found = await scanMavens({
      m2Home: homeA,
      mavenHome: homeA, // 与 M2_HOME 同值 → 去重
      pathEnv: [path.join(homeB, 'bin'), notMavenDir, ''].join(';')
    })

    expect(found).toHaveLength(2)
    const versions = found.map((m) => m.version).sort()
    expect(versions).toEqual(['3.8.8', '3.9.9'])
    for (const m of found) {
      expect(m.source).toBe('scan')
      expect(m.id).toMatch(UUID_RE)
    }
  })

  it('m2Home=null + pathEnv=null → 空结果（不读本机环境，测试封闭）', async () => {
    await makeFakeMaven(path.join(baseDir, 'ignored'), '3.9.9')
    expect(await scanMavens({ m2Home: null, mavenHome: null, pathEnv: null })).toEqual([])
  })

  it('环境变量指向非 Maven 目录 → 静默跳过', async () => {
    const notMaven = path.join(baseDir, 'not-maven')
    await mkdir(notMaven, { recursive: true })
    expect(await scanMavens({ m2Home: notMaven, mavenHome: null, pathEnv: null })).toEqual([])
  })
})

// ---------- mergeMavens ----------

describe('mergeMavens 合并语义', () => {
  const home = 'D:\\apache-maven-3.9.9'

  function make(overrides: Partial<Maven> & Pick<Maven, 'id' | 'source'>): Maven {
    return {
      name: 'Apache Maven 3.9.9',
      homePath: home,
      version: '3.9.9',
      ...overrides
    }
  }

  it('手动条目原样保留（含自定义 settings/仓库），不被探测覆盖', () => {
    const manual = make({
      id: 'm-manual',
      source: 'manual',
      settingsPath: 'D:\\my-settings.xml',
      localRepoPath: 'D:\\my-repo'
    })
    const scanned = [make({ id: 'm-scan', source: 'scan' })]

    const merged = mergeMavens([manual], scanned)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toEqual(manual)
  })

  it('scan 条目再次探到 → 刷新元数据保 id，且不覆盖用户改过的可选字段', () => {
    const scanOld = make({ id: 'm-scan', source: 'scan', version: '3.9.9' })
    const drifted = make({ id: 'm-scan', source: 'scan', settingsPath: 'D:\\my-settings.xml' })
    const fresh = [make({ id: 'm-new', source: 'scan', version: '3.9.10' })]

    const [refreshed] = mergeMavens([scanOld, drifted], fresh)
    expect(refreshed.id).toBe('m-scan') // 项目 mavenId 引用不失效
    expect(refreshed.version).toBe('3.9.10')
    expect(refreshed.settingsPath).toBe('D:\\my-settings.xml') // 用户自定义不丢
  })

  it('本轮未探到 → 保留；新发现 → 追加', () => {
    const existing = [make({ id: 'm-1', source: 'scan' })]
    const scanned = [
      make({ id: 'm-2', source: 'scan', homePath: 'D:\\apache-maven-3.6.3', version: '3.6.3' })
    ]

    const merged = mergeMavens(existing, scanned)

    expect(merged.map((m) => m.id).sort()).toEqual(['m-1', 'm-2'])
  })
})

// ---------- resolveLocalRepo ----------

describe('resolveLocalRepo 展示优先级', () => {
  it('显式 localRepoPath 最优先', async () => {
    const maven: Maven = {
      id: 'm',
      name: 'Apache Maven 3.9.9',
      homePath: 'D:\\maven',
      version: '3.9.9',
      localRepoPath: 'D:\\explicit-repo',
      source: 'manual'
    }
    expect(await resolveLocalRepo(maven)).toBe('D:\\explicit-repo')
  })

  it('无显式时从 settings.xml 解析', async () => {
    const settings = path.join(baseDir, 'settings.xml')
    await writeFile(settings, '<settings><localRepository>D:\\from-settings</localRepository></settings>', 'utf8')
    const maven: Maven = {
      id: 'm',
      name: 'Apache Maven 3.9.9',
      homePath: 'D:\\maven',
      version: '3.9.9',
      settingsPath: settings,
      source: 'manual'
    }
    expect(await resolveLocalRepo(maven)).toBe('D:\\from-settings')
  })

  it('均无 → null（不猜测 ~/.m2/repository，未实测存在不展示）', async () => {
    const maven: Maven = {
      id: 'm',
      name: 'Apache Maven 3.9.9',
      homePath: 'D:\\maven',
      version: '3.9.9',
      source: 'manual'
    }
    expect(await resolveLocalRepo(maven)).toBeNull()
  })
})
