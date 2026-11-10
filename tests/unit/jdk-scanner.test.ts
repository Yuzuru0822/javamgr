import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SCAN_ROOTS,
  mergeJdks,
  normalizeHomePath,
  scanJdks,
  validateJdkPath
} from '../../src/main/jdk/jdk-scanner'
import type { Jdk, ScanProgressEvent } from '../../src/shared/types'

/**
 * JDK 扫描器单测（计划 §3 S2.1）。
 *
 * 策略：临时目录构造假 JDK 树——手写 release 文件 + 假 java.exe（**不执行**）：
 * 全部扫描/校验调用注入 skipVersionProbe，`-version` 兜底路径通过「跳过」覆盖主路径
 * （release 解析 + unknown 兜底）；根目录列表 / JAVA_HOME 均注入，不依赖本机真实安装。
 * 每次扫描显式 javaHome: null，防本机 JAVA_HOME 泄漏破坏计数确定性。
 */

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-jdkscan-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

const TEMURIN_RELEASE = [
  'IMPLEMENTOR="Eclipse Adoptium"',
  'JAVA_VERSION="17.0.9.9"',
  'OS_NAME="Windows"',
  'OS_ARCH="x86_64"',
  ''
].join('\n')

/**
 * 构造假 JDK：bin\<exeName>（exeName=null 则不写 exe）+ 可选 release 文件。
 * 返回 home 绝对路径。
 */
async function makeFakeJdk(dir: string, release?: string, exeName: string | null = 'java.exe') {
  await mkdir(path.join(dir, 'bin'), { recursive: true })
  if (exeName !== null) {
    await writeFile(path.join(dir, 'bin', exeName), 'fake-java', 'utf8')
  }
  if (release !== undefined) {
    await writeFile(path.join(dir, 'release'), release, 'utf8')
  }
  return dir
}

/** 无探针、无 JAVA_HOME 的封闭扫描选项（测试默认形态） */
const hermetic = { javaHome: null, skipVersionProbe: true } as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ---------- 扫描 ----------

describe('scanJdks 目录扫描', () => {
  it('release 文件解析版本与发行方（含 IMPLEMENTOR），来源标记 scan', async () => {
    const home = await makeFakeJdk(path.join(baseDir, 'jdk-17.0.9.9-hotspot'), TEMURIN_RELEASE)

    const found = await scanJdks({ ...hermetic, roots: [baseDir] })

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      version: '17.0.9.9',
      vendor: 'Eclipse Adoptium',
      name: 'Eclipse Adoptium 17.0.9.9',
      source: 'scan'
    })
    expect(found[0]!.id).toMatch(UUID_RE)
    expect(normalizeHomePath(found[0]!.homePath)).toBe(normalizeHomePath(home))
  })

  it('release 无 IMPLEMENTOR → 发行方 unknown，名称退化为 JDK <version>', async () => {
    await makeFakeJdk(path.join(baseDir, 'jdk8'), 'JAVA_VERSION="1.8.0_392"\n')

    const found = await scanJdks({ ...hermetic, roots: [baseDir] })

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      version: '1.8.0_392',
      vendor: 'unknown',
      name: 'JDK 1.8.0_392'
    })
  })

  it('无 release 文件 + 跳过探测（skipVersionProbe 注入）→ version/vendor 标 unknown', async () => {
    await makeFakeJdk(path.join(baseDir, 'jdk-norelease'))

    const found = await scanJdks({ ...hermetic, roots: [baseDir] })

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ version: 'unknown', vendor: 'unknown', name: 'JDK unknown' })
  })

  it('release 存在但无 JAVA_VERSION（解析失败）→ 同样落入 unknown 兜底', async () => {
    await makeFakeJdk(path.join(baseDir, 'jdk-badrelease'), 'OS_NAME="Windows"\n')

    const found = await scanJdks({ ...hermetic, roots: [baseDir] })

    expect(found).toHaveLength(1)
    expect(found[0]!.version).toBe('unknown')
  })

  it('JAVA_HOME 注入：直指 JDK home 即候选（自身就是 home，非父目录）', async () => {
    const home = await makeFakeJdk(path.join(baseDir, 'from-env'), TEMURIN_RELEASE)

    const found = await scanJdks({ javaHome: home, skipVersionProbe: true, roots: [] })

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ version: '17.0.9.9', source: 'scan' })
    expect(normalizeHomePath(found[0]!.homePath)).toBe(normalizeHomePath(home))
  })

  it('用户自定义根直指 JDK home（D:\\java17 形态）：根自身通过 bin\\java.exe 判定', async () => {
    const home = await makeFakeJdk(path.join(baseDir, 'jdk17'), TEMURIN_RELEASE)

    const found = await scanJdks({ ...hermetic, roots: [home] })

    expect(found).toHaveLength(1)
    expect(found[0]!.version).toBe('17.0.9.9')
  })

  it('非 JDK 目录忽略：无 bin、bin 下无 java.exe、普通文件均不入选', async () => {
    await makeFakeJdk(path.join(baseDir, 'jdk-real'), TEMURIN_RELEASE)
    await mkdir(path.join(baseDir, 'only-javac', 'bin'), { recursive: true })
    await writeFile(path.join(baseDir, 'only-javac', 'bin', 'javac.exe'), 'x', 'utf8')
    await mkdir(path.join(baseDir, 'no-bin'), { recursive: true })
    await writeFile(path.join(baseDir, 'readme.txt'), 'not a dir', 'utf8')

    const found = await scanJdks({ ...hermetic, roots: [baseDir] })

    expect(found).toHaveLength(1)
    expect(normalizeHomePath(found[0]!.homePath)).toBe(
      normalizeHomePath(path.join(baseDir, 'jdk-real'))
    )
  })

  it('jdkPrefixOnly 根（Program Files\\Microsoft 场景）：仅 jdk-* 子目录候选', async () => {
    await makeFakeJdk(path.join(baseDir, 'jdk-17.0.9'), TEMURIN_RELEASE)
    await makeFakeJdk(path.join(baseDir, 'edge'), TEMURIN_RELEASE) // 同样含 java.exe 但非 jdk-* 前缀

    const filtered = await scanJdks({ ...hermetic, roots: [{ dir: baseDir, jdkPrefixOnly: true }] })
    expect(filtered).toHaveLength(1)
    expect(normalizeHomePath(filtered[0]!.homePath)).toBe(
      normalizeHomePath(path.join(baseDir, 'jdk-17.0.9'))
    )

    // 对照：无过滤标记时两个都入选（过滤规则只属于 Microsoft 根）
    const unfiltered = await scanJdks({ ...hermetic, roots: [baseDir] })
    expect(unfiltered).toHaveLength(2)
  })

  it('去重：JAVA_HOME 大小写/尾斜杠变体与扫描根命中同一 home → 单条结果', async () => {
    const home = await makeFakeJdk(path.join(baseDir, 'MyJdk'), TEMURIN_RELEASE)
    // Windows 文件系统大小写不敏感：整体大写 + 尾反斜杠与原路径指向同一目录
    const variant = `${home.toUpperCase()}\\`

    const found = await scanJdks({ javaHome: variant, skipVersionProbe: true, roots: [baseDir, `${baseDir}\\`] })

    expect(found).toHaveLength(1)
    expect(normalizeHomePath(found[0]!.homePath)).toBe(normalizeHomePath(home))
  })

  it('扫描根不存在 → 静默返回空结果（默认根常因未装对应发行版而缺失，不抛错）', async () => {
    const found = await scanJdks({
      ...hermetic,
      roots: ['Z:\\jpm-definitely-not-exists']
    })
    expect(found).toEqual([])
  })

  it('进度事件：scanned 单调不减，最终 found 与结果数一致（jdk:scanProgress 事件源）', async () => {
    await makeFakeJdk(path.join(baseDir, 'jdk-a'), TEMURIN_RELEASE)
    await makeFakeJdk(path.join(baseDir, 'jdk-b'), TEMURIN_RELEASE)
    await mkdir(path.join(baseDir, 'not-jdk'), { recursive: true })

    const events: ScanProgressEvent[] = []
    const found = await scanJdks({
      ...hermetic,
      roots: [baseDir],
      onProgress: (p) => events.push({ ...p })
    })

    expect(events.length).toBeGreaterThan(0)
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.scanned).toBeGreaterThanOrEqual(events[i - 1]!.scanned)
      expect(events[i]!.found).toBeGreaterThanOrEqual(events[i - 1]!.found)
    }
    const last = events[events.length - 1]!
    expect(last.found).toBe(found.length)
    expect(last.scanned).toBeGreaterThanOrEqual(3) // 根自身 + 3 个子目录
  })
})

// ---------- 路径规范化 ----------

describe('normalizeHomePath 去重键', () => {
  it('大小写 / 尾分隔符 / 分隔符方向变体归一为同一键', () => {
    expect(normalizeHomePath('D:\\Java17\\')).toBe('d:/java17')
    expect(normalizeHomePath('d:/java17')).toBe('d:/java17')
    expect(normalizeHomePath('D:\\java17\\\\/')).toBe('d:/java17')
    expect(normalizeHomePath('C:\\Program Files\\JAVA')).toBe(normalizeHomePath(
      'c:\\program files\\java\\'
    ))
  })
})

// ---------- 手动添加校验（同一套判定） ----------

describe('validateJdkPath 手动路径校验', () => {
  it('合法 JDK 目录 → ok + 完整 Jdk 草稿（source: manual，路径解析为绝对路径）', async () => {
    const home = await makeFakeJdk(path.join(baseDir, 'manual-jdk'), TEMURIN_RELEASE)

    const v = await validateJdkPath(home, { skipVersionProbe: true })

    expect(v.ok).toBe(true)
    expect(v.jdk).toMatchObject({
      version: '17.0.9.9',
      vendor: 'Eclipse Adoptium',
      name: 'Eclipse Adoptium 17.0.9.9',
      source: 'manual',
      homePath: path.resolve(home)
    })
    expect(v.jdk!.id).toMatch(UUID_RE)
  })

  it('bin\\java.exe 大小写变体（JAVA.EXE）同样通过（Windows 大小写兼容）', async () => {
    const home = await makeFakeJdk(path.join(baseDir, 'upper-exe'), TEMURIN_RELEASE, 'JAVA.EXE')

    const v = await validateJdkPath(home, { skipVersionProbe: true })
    expect(v.ok).toBe(true)
  })

  it('缺少 bin\\java.exe → ok=false，错误信息指向 bin\\java.exe', async () => {
    await mkdir(path.join(baseDir, 'not-jdk', 'bin'), { recursive: true })
    await writeFile(path.join(baseDir, 'not-jdk', 'bin', 'javac.exe'), 'x', 'utf8')

    const v = await validateJdkPath(path.join(baseDir, 'not-jdk'))
    expect(v.ok).toBe(false)
    expect(v.jdk).toBeUndefined()
    expect(v.error).toContain('java.exe')
  })

  it('目录不存在 → ok=false；空/空白路径 → ok=false', async () => {
    const missing = await validateJdkPath(path.join(baseDir, 'nope'))
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('java.exe')

    expect((await validateJdkPath('')).ok).toBe(false)
    expect((await validateJdkPath('   ')).ok).toBe(false)
  })
})

// ---------- 合并（jdk:scan 落库语义） ----------

function jdkOf(overrides: Partial<Jdk> & Pick<Jdk, 'homePath'>): Jdk {
  return {
    id: 'id-x',
    name: 'Test JDK',
    version: '17',
    vendor: 'TestVendor',
    source: 'scan',
    ...overrides
  }
}

describe('mergeJdks 扫描合并', () => {
  const homeX = 'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.9.9-hotspot'
  const homeXVariant = 'c:\\program files\\eclipse adoptium\\jdk-17.0.9.9-hotspot\\'

  it('手动条目原样保留：扫描命中同一路径不覆盖用户自定义（名称/版本/id 均不动）', () => {
    const existing = [
      jdkOf({ id: 'm1', homePath: homeX, name: '我的常用17', version: '自定义版本', source: 'manual' })
    ]
    const scanned = [
      jdkOf({ id: 'fresh', homePath: homeXVariant, name: 'Eclipse Adoptium 17.0.9.9', version: '17.0.9.9' })
    ]

    const merged = mergeJdks(existing, scanned)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 'm1', name: '我的常用17', version: '自定义版本', source: 'manual' })
  })

  it('扫描条目再次扫到 → 刷新元数据但保留原 id（项目 jdkId 引用不失效）', () => {
    const existing = [jdkOf({ id: 's1', homePath: homeX, version: '16', vendor: 'Old' })]
    const scanned = [
      jdkOf({ id: 'fresh', homePath: homeXVariant, version: '17.0.9.9', vendor: 'Eclipse Adoptium' })
    ]

    const merged = mergeJdks(existing, scanned)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 's1',
      version: '17.0.9.9',
      vendor: 'Eclipse Adoptium',
      source: 'scan'
    })
  })

  it('既有条目本轮未扫到（已卸载/移除盘）→ 保留（保守合并，避免破坏项目引用）', () => {
    const existing = [jdkOf({ id: 'gone', homePath: 'E:\\removed-jdk' })]
    expect(mergeJdks(existing, [])).toHaveLength(1)
  })

  it('新发现 → 追加（携带扫描生成的 id）；无交集时并集返回', () => {
    const existing = [jdkOf({ id: 'm1', homePath: homeX, source: 'manual' })]
    const scanned = [jdkOf({ id: 'fresh', homePath: 'D:\\java17' })]

    const merged = mergeJdks(existing, scanned)

    expect(merged).toHaveLength(2)
    expect(merged.map((j) => j.id)).toEqual(['m1', 'fresh'])
  })
})

// ---------- 默认根（不触盘，仅断言常量） ----------

describe('DEFAULT_SCAN_ROOTS 默认扫描根', () => {
  it('覆盖计划 §2.3-B 全部六个标准根；仅 Microsoft 根启用 jdk-* 前缀过滤', () => {
    const dirs = DEFAULT_SCAN_ROOTS.map((r) => normalizeHomePath(r.dir))
    expect(dirs).toEqual([
      'c:/program files/java',
      'c:/program files/eclipse adoptium',
      'c:/program files/zulu',
      'c:/program files/microsoft',
      'c:/program files/amazon corretto',
      'c:/program files (x86)/java'
    ])
    const flagged = DEFAULT_SCAN_ROOTS.filter((r) => r.jdkPrefixOnly)
    expect(flagged).toHaveLength(1)
    expect(normalizeHomePath(flagged[0]!.dir)).toBe('c:/program files/microsoft')
  })
})
