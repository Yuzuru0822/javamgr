/**
 * JDK 扫描器（计划 §2.3-B / §3 S2.1）。
 *
 * 职责：
 * - 标准根目录（Program Files 下各发行版目录）+ JAVA_HOME + 用户追加目录（settings.scanRoots，
 *   由调用方并入 roots）扫描；每个根同时探测「根自身是 JDK home」与「子目录是 JDK home」两种形态
 *   （JAVA_HOME / D:\java17 直指 home，Program Files\Java 是父目录）；
 * - 候选判定：目录含 bin\java.exe（大小写不敏感，覆盖 Java.EXE 等变体）；
 * - 版本/发行方解析：release 文件（KEY="value" 格式的 JAVA_VERSION / IMPLEMENTOR）优先；
 *   无 release 或解析失败 → 执行 `java.exe -version` 解析 stderr/stdout 兜底
 *   （输出按 latin1 解码后正则取版本号——版本号是 ASCII，规避 GBK/UTF-8 转码坑）；
 *   再失败标 version "unknown"；
 * - 去重按 homePath 规范化（小写 + 去尾分隔符 + 分隔符统一）；
 * - validateJdkPath：手动添加/编辑共用同一套判定（含派生版本信息）。
 *
 * 可注入设计（可测性）：根目录列表 / JAVA_HOME / 是否跳过 -version 探测均可注入，
 * vitest 用临时目录构造假 JDK 树（release 文件 + 假 java.exe，skipVersionProbe 不执行它）。
 *
 * 本模块零 electron 依赖（fs/promises 异步遍历不阻塞），纯 Node 环境可完整测试。
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Jdk, JdkValidation, ScanProgressEvent } from '../../shared/types'

const execFileAsync = promisify(execFile)

// ---------- 扫描根 ----------

/** 扫描根规格：jdkPrefixOnly = 仅子目录名 jdk-* 前缀才算候选（C:\Program Files\Microsoft 场景，防误扫 Edge 等无关目录） */
export interface ScanRootSpec {
  dir: string
  jdkPrefixOnly?: boolean
}

/**
 * 默认扫描根（§2.3-B；随新发行版出现持续补充，见计划 ADR Follow-ups）。
 * 用户追加目录（settings.scanRoots）由调用方并入，不在此硬编码。
 */
export const DEFAULT_SCAN_ROOTS: readonly ScanRootSpec[] = Object.freeze([
  { dir: 'C:\\Program Files\\Java' },
  { dir: 'C:\\Program Files\\Eclipse Adoptium' },
  { dir: 'C:\\Program Files\\Zulu' },
  { dir: 'C:\\Program Files\\Microsoft', jdkPrefixOnly: true },
  { dir: 'C:\\Program Files\\Amazon Corretto' },
  { dir: 'C:\\Program Files (x86)\\Java' }
])

const normalizeRootSpec = (root: string | ScanRootSpec): ScanRootSpec =>
  typeof root === 'string' ? { dir: root } : root

// ---------- 路径规范化（去重键） ----------

/**
 * homePath 规范化：统一正斜杠 + 去尾部分隔符 + 小写。
 * "D:\Java17\" / "d:/java17" / "D:\java17\\" → 同一键。
 */
export function normalizeHomePath(p: string): string {
  return p
    .replace(/[/\\]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

// ---------- 候选判定：bin\java.exe（大小写兼容） ----------

/** 目录含 bin\java.exe（名字大小写不敏感）则返回其完整路径，否则 null。目录不存在/不可读同样 null。 */
async function findJavaExe(home: string): Promise<string | null> {
  try {
    const binDir = path.join(home, 'bin')
    const entries = await readdir(binDir, { withFileTypes: true })
    const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'java.exe')
    return hit ? path.join(binDir, hit.name) : null
  } catch {
    return null
  }
}

// ---------- release 文件解析 ----------

interface ReleaseInfo {
  version: string
  implementor?: string
}

/** 解析 JDK home 下 release 文件（格式 `KEY="value"`）；无文件/无 JAVA_VERSION → null（走 -version 兜底）。 */
async function parseReleaseFile(home: string): Promise<ReleaseInfo | null> {
  let text: string
  try {
    text = await readFile(path.join(home, 'release'), 'utf8')
  } catch {
    return null
  }
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)="(.*)"$/)
    if (m) fields.set(m[1]!, m[2]!)
  }
  const version = fields.get('JAVA_VERSION')
  if (!version) return null
  return { version, implementor: fields.get('IMPLEMENTOR') }
}

// ---------- java -version 兜底探测 ----------

/** -version 输出中的发行方线索（Temurin/Zulu/Corretto 等在 Runtime Environment 行自称） */
const VENDOR_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/temurin|eclipse adoptium|adoptium/i, 'Eclipse Adoptium'],
  [/zulu|azul/i, 'Azul Zulu'],
  [/corretto|amazon/i, 'Amazon Corretto'],
  [/liberica|bellsoft/i, 'Bellsoft Liberica'],
  [/graalvm|graal/i, 'GraalVM'],
  [/microsoft/i, 'Microsoft'],
  [/oracle/i, 'Oracle'],
  [/openjdk/i, 'OpenJDK']
]

function detectVendor(text: string): string {
  for (const [pattern, vendor] of VENDOR_PATTERNS) {
    if (pattern.test(text)) return vendor
  }
  return 'unknown'
}

/**
 * 执行 `<javaExe> -version` 解析版本（5s 超时防挂起，windowsHide 不闪窗）。
 * 输出按 latin1 解码：版本号 / 发行方关键词均为 ASCII，转码差异不影响正则提取。
 * 非零退出码（个别旧版 JDK）也尝试从 stdout/stderr 提取；超时/不可执行/无匹配 → null。
 */
async function probeJavaVersion(
  javaExe: string,
  timeoutMs: number
): Promise<{ version: string; vendor: string } | null> {
  const extract = (stdout: string, stderr: string): { version: string; vendor: string } | null => {
    const text = `${stdout}\n${stderr}`
    // openjdk version "17.0.12" 2024-07-16 / java version "1.8.0_392" / Implementation-Version 行
    const m = text.match(/version\s+"([^"]+)"/)
    if (!m) return null
    return { version: m[1]!, vendor: detectVendor(text) }
  }
  try {
    const { stdout, stderr } = await execFileAsync(javaExe, ['-version'], {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'latin1',
      maxBuffer: 64 * 1024
    })
    return extract(stdout, stderr)
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return extract(e.stdout ?? '', e.stderr ?? '')
  }
}

// ---------- 版本信息归并 ----------

interface JdkMeta {
  name: string
  version: string
  vendor: string
}

const buildName = (version: string, vendor: string): string =>
  vendor !== 'unknown' && vendor.length > 0 ? `${vendor} ${version}` : `JDK ${version}`

/** release 文件 → -version 探测 → unknown，三级兜底（§2.3-B）。 */
async function resolveJdkMeta(
  home: string,
  javaExe: string,
  options: JdkScanOptions
): Promise<JdkMeta> {
  const release = await parseReleaseFile(home)
  if (release) {
    const vendor = release.implementor ?? 'unknown'
    return { version: release.version, vendor, name: buildName(release.version, vendor) }
  }
  if (!options.skipVersionProbe) {
    const probed = await probeJavaVersion(javaExe, options.probeTimeoutMs ?? 5000)
    if (probed) return { ...probed, name: buildName(probed.version, probed.vendor) }
  }
  return { version: 'unknown', vendor: 'unknown', name: 'JDK unknown' }
}

async function inspectHome(home: string, options: JdkScanOptions): Promise<JdkMeta | null> {
  const javaExe = await findJavaExe(home)
  if (!javaExe) return null
  return resolveJdkMeta(home, javaExe, options)
}

// ---------- 扫描入口 ----------

export interface JdkScanOptions {
  /** 扫描根（测试可注入临时目录）；缺省 DEFAULT_SCAN_ROOTS。调用方负责并入 settings.scanRoots。 */
  roots?: Array<string | ScanRootSpec>
  /** JAVA_HOME 值；undefined = 读 process.env.JAVA_HOME；null = 显式跳过（测试固定环境） */
  javaHome?: string | null
  /** 跳过 `java -version` 兜底探测（测试注入：假 java.exe 不可执行，release 缺失时直接标 unknown） */
  skipVersionProbe?: boolean
  /** -version 探测超时 ms（默认 5000） */
  probeTimeoutMs?: number
  /** 进度回调：已扫描目录数 / 已发现 JDK 数（jdk:scanProgress 事件源） */
  onProgress?: (progress: ScanProgressEvent) => void
}

/**
 * 扫描全部根目录，返回发现的 JDK（source: 'scan'，id 已生成，合并落库时按 homePath 复用既有 id）。
 * fs/promises 异步遍历不阻塞；根目录不存在静默跳过（默认根常因未装对应发行版而不存在）。
 */
export async function scanJdks(options: JdkScanOptions = {}): Promise<Jdk[]> {
  const rootSpecs = (options.roots ?? DEFAULT_SCAN_ROOTS).map(normalizeRootSpec)
  const javaHome =
    options.javaHome !== undefined ? options.javaHome : process.env.JAVA_HOME?.trim() || null

  const found = new Map<string, Jdk>() // normalized homePath → Jdk（插入序即结果序）
  let scanned = 0
  let foundCount = 0

  const consider = async (home: string): Promise<void> => {
    scanned++
    try {
      const meta = await inspectHome(home, options)
      if (meta) {
        foundCount++
        found.set(normalizeHomePath(home), {
          id: randomUUID(),
          name: meta.name,
          homePath: home,
          version: meta.version,
          vendor: meta.vendor,
          source: 'scan'
        })
      }
    } catch (err) {
      // 单个目录异常不中断整体扫描（扫描要显式容错，静默跳过）
      console.warn(`[jdk-scanner] 检查目录失败，已跳过：${home}`, err)
    }
    options.onProgress?.({ scanned, found: foundCount })
  }

  // JAVA_HOME 直指 JDK home（自身即候选）
  if (javaHome) await consider(javaHome)

  for (const spec of rootSpecs) {
    await consider(spec.dir) // 根自身可能是 home（用户根 D:\java17 这类）
    let children
    try {
      children = await readdir(spec.dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[jdk-scanner] 扫描根不可读，已跳过：${spec.dir}`, err)
      }
      continue
    }
    for (const child of children) {
      if (!(child.isDirectory() || child.isSymbolicLink())) continue
      if (spec.jdkPrefixOnly && !/^jdk-/i.test(child.name)) continue
      await consider(path.join(spec.dir, child.name))
    }
  }

  return [...found.values()]
}

// ---------- 手动添加/编辑路径校验（同一套判定） ----------

/**
 * 校验手动指定的 JDK 路径：存在 bin\java.exe 且能派生版本信息 → ok + 完整 Jdk（source: 'manual'，
 * id 已生成可直接入库）；否则 ok=false + 中文原因（jdk:add / jdk:update / jdk:validate 复用）。
 */
export async function validateJdkPath(
  homePath: string,
  options: Pick<JdkScanOptions, 'skipVersionProbe' | 'probeTimeoutMs'> = {}
): Promise<JdkValidation> {
  const trimmed = homePath.trim()
  if (!trimmed) {
    return { ok: false, error: 'JDK 路径不能为空' }
  }
  const resolved = path.resolve(trimmed)
  const javaExe = await findJavaExe(resolved)
  if (!javaExe) {
    return {
      ok: false,
      error: `未找到 ${path.join(resolved, 'bin')}\\java.exe，请确认这是 JDK 安装主目录`
    }
  }
  const meta = await resolveJdkMeta(resolved, javaExe, options)
  return {
    ok: true,
    jdk: {
      id: randomUUID(),
      name: meta.name,
      homePath: resolved,
      version: meta.version,
      vendor: meta.vendor,
      source: 'manual'
    }
  }
}

// ---------- 扫描结果与既有库合并（jdk:scan 落库语义） ----------

/**
 * 合并扫描结果与既有列表（按 homePath 规范化去重）：
 * - 手动条目（source: 'manual'）**原样保留**，不被扫描覆盖（用户自定义不丢）；
 * - 扫描条目（source: 'scan'）再次扫到 → 刷新版本/发行方/名称，**保留原 id**（项目 jdkId 引用不失效）；
 * - 既有条目本轮未扫到（如卸载/移除盘）→ 保留（保守合并，避免破坏项目引用；未扫到的 scan 条目
 *   用户可在页面手动删除）；
 * - 新发现 → 追加（source: 'scan'）。
 */
export function mergeJdks(existing: Jdk[], scanned: Jdk[]): Jdk[] {
  const byHome = new Map<string, Jdk>()
  for (const jdk of existing) byHome.set(normalizeHomePath(jdk.homePath), jdk)
  for (const fresh of scanned) {
    const key = normalizeHomePath(fresh.homePath)
    const current = byHome.get(key)
    if (!current) {
      byHome.set(key, fresh)
    } else if (current.source === 'scan') {
      byHome.set(key, { ...fresh, id: current.id }) // 刷新元数据，id 稳定
    }
    // manual：保留用户自定义条目
  }
  return [...byHome.values()]
}
