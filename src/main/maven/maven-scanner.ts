/**
 * Maven 扫描器（2026-11-18 Maven 管理功能，对齐 jdk-scanner 的形态与纪律）。
 *
 * 职责：
 * - 候选判定：目录含 bin\mvn.cmd（大小写不敏感，覆盖 mvn.CMD / mvn.bat / 无扩展名 mvn 等
 *   Windows 变体）→ 视为 Maven home；
 * - 版本解析：读 lib\ 目录下 maven-core-<version>.jar 文件名（零执行、零 JDK 依赖——
 *   `mvn -version` 需要 JAVA_HOME，而本工具管理多 JDK 的用户往往没有系统级 JAVA_HOME，
 *   执行探测会误报不可用；发行版 lib 目录必有该 jar）；解析不出标 "unknown"；
 * - settings.xml 解析：正则提取 <localRepository> 元素（值不含换行的常规形态；
 *   XML 头/注释/命名空间不影响），供「仓库路径建议」与展示；不做完整 XML 解析
 *   （localRepository 是简单字符串元素，正则足够，避免引入 XML 依赖）；
 * - 环境探测（scanMavens）：M2_HOME / MAVEN_HOME（指 home）+ PATH 各目录（指 bin），
 *   按 homePath 规范化去重；无递归扫描（Maven 无 Program Files 式标准安装位，
 *   通常解压在任意目录，递归全盘误报多价值低——手动添加为主）；
 * - validateMavenPath：手动添加/编辑共用同一套判定（含派生版本信息）；
 * - mergeMavens：扫描结果与既有库合并（手动条目原样保留、scan 条目刷新元数据保 id）。
 *
 * 路径规范化复用 jdk-scanner 的 normalizeHomePath（语义相同：分隔符统一 + 去尾 + 小写）。
 *
 * 本模块零 electron 依赖，vitest 用临时目录构造假 Maven 树
 * （bin\mvn.cmd + lib\maven-core-3.9.9.jar + conf\settings.xml）完整测试。
 */

import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Maven, MavenValidation } from '../../shared/types'
import { normalizeHomePath } from '../jdk/jdk-scanner'

export { normalizeHomePath }

// ---------- 候选判定：bin 下 maven 启动脚本 ----------

/** Windows Maven 发行版 bin 下的启动脚本名（mvn.cmd 为主，兼容 mvn.bat / mvn） */
const MVN_SCRIPT_NAMES = new Set(['mvn.cmd', 'mvn.bat', 'mvn'])

/** 目录 bin\ 下存在 maven 启动脚本（名字大小写不敏感）则返回其完整路径，否则 null。目录不存在/不可读同样 null。 */
export async function findMvnScript(home: string): Promise<string | null> {
  try {
    const binDir = path.join(home, 'bin')
    const entries = await readdir(binDir, { withFileTypes: true })
    const hit = entries.find((e) => e.isFile() && MVN_SCRIPT_NAMES.has(e.name.toLowerCase()))
    return hit ? path.join(binDir, hit.name) : null
  } catch {
    return null
  }
}

// ---------- 版本解析：lib\maven-core-<version>.jar 文件名 ----------

/** 读 lib 目录解析 maven-core-<version>.jar；无 lib 目录/无匹配 → null。 */
async function parseVersionFromLib(home: string): Promise<string | null> {
  let entries
  try {
    entries = await readdir(path.join(home, 'lib'), { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (!e.isFile()) continue
    const m = e.name.match(/^maven-core-(.+)\.jar$/i)
    if (m && m[1]) return m[1]
  }
  return null
}

// ---------- settings.xml 解析 ----------

/**
 * 从 settings.xml 提取 <localRepository> 值（trim；相对路径按 maven 语义相对 settings.xml
 * 所在目录解析）。文件不存在/不可读/无元素 → null。
 */
export async function parseLocalRepoFromSettings(
  settingsXmlPath: string
): Promise<string | null> {
  let text: string
  try {
    text = await readFile(settingsXmlPath, 'utf8')
  } catch {
    return null
  }
  // 常规形态单行元素；DOTALL 容忍属性与内部空白
  const m = text.match(/<localRepository(?:\s[^>]*)?>\s*([^<]+?)\s*<\/localRepository>/)
  if (!m || !m[1]) return null
  const value = m[1]
  if (path.isAbsolute(value)) return path.normalize(value)
  return path.resolve(path.dirname(settingsXmlPath), value)
}

// ---------- 版本信息归并 ----------

interface MavenMeta {
  name: string
  version: string
}

const buildName = (version: string): string =>
  version !== 'unknown' ? `Apache Maven ${version}` : 'Maven unknown'

async function inspectHome(home: string): Promise<MavenMeta | null> {
  const script = await findMvnScript(home)
  if (!script) return null
  const version = (await parseVersionFromLib(home)) ?? 'unknown'
  return { version, name: buildName(version) }
}

// ---------- 环境探测（scanMavens） ----------

export interface MavenScanOptions {
  /** M2_HOME 值；undefined = 读 process.env.M2_HOME；null = 显式跳过（测试固定环境） */
  m2Home?: string | null
  /** MAVEN_HOME 值；undefined = 读 process.env.MAVEN_HOME；null = 显式跳过 */
  mavenHome?: string | null
  /** PATH 值（分号分隔）；undefined = 读 process.env.PATH；null = 显式跳过 */
  pathEnv?: string | null
}

/**
 * 探测本机 Maven：M2_HOME / MAVEN_HOME（home 目录）+ PATH 各目录（bin 目录，
 * 命中后取父目录为 home）。返回 source: 'scan' 的条目（id 已生成）。
 * 单个候选异常不中断整体（显式容错，静默跳过）。
 */
export async function scanMavens(options: MavenScanOptions = {}): Promise<Maven[]> {
  const m2Home = options.m2Home !== undefined ? options.m2Home : process.env.M2_HOME?.trim() || null
  const mavenHome =
    options.mavenHome !== undefined ? options.mavenHome : process.env.MAVEN_HOME?.trim() || null
  const pathEnv = options.pathEnv !== undefined ? options.pathEnv : process.env.PATH ?? null

  const found = new Map<string, Maven>() // normalized homePath → Maven（插入序即结果序）

  const consider = async (home: string): Promise<void> => {
    try {
      const meta = await inspectHome(home)
      if (meta) {
        found.set(normalizeHomePath(home), {
          id: randomUUID(),
          name: meta.name,
          homePath: home,
          version: meta.version,
          source: 'scan'
        })
      }
    } catch (err) {
      console.warn(`[maven-scanner] 检查目录失败，已跳过：${home}`, err)
    }
  }

  if (m2Home) await consider(m2Home)
  if (mavenHome && normalizeHomePath(mavenHome) !== normalizeHomePath(m2Home ?? '')) {
    await consider(mavenHome)
  }
  if (pathEnv) {
    for (const dir of pathEnv.split(';')) {
      const trimmed = dir.trim()
      if (!trimmed) continue
      // PATH 条目即 bin 目录：命中 mvn 脚本 → home = 其父目录
      try {
        const script = await findMvnScript(path.dirname(trimmed))
        if (script) await consider(path.dirname(trimmed))
      } catch {
        // 单目录不可读跳过
      }
    }
  }

  return [...found.values()]
}

// ---------- 手动添加/编辑路径校验（同一套判定） ----------

/**
 * 校验手动指定的 Maven 路径：存在 bin\mvn.cmd（或变体）→ ok + 完整 Maven（source: 'manual'，
 * id 已生成可直接入库）+ 派生信息（defaultSettingsPath = home\conf\settings.xml 存在时给出；
 * settingsLocalRepo = 该默认 settings.xml 解析出的 localRepository）；
 * 否则 ok=false + 中文原因（maven:add / maven:update / maven:validate 复用）。
 */
export async function validateMavenPath(homePath: string): Promise<MavenValidation> {
  const trimmed = homePath.trim()
  if (!trimmed) {
    return { ok: false, error: 'Maven 路径不能为空' }
  }
  const resolved = path.resolve(trimmed)
  const script = await findMvnScript(resolved)
  if (!script) {
    return {
      ok: false,
      error: `未找到 ${path.join(resolved, 'bin')}\\mvn.cmd，请确认这是 Maven 安装主目录（解压后的根目录，非 bin 目录）`
    }
  }
  const version = (await parseVersionFromLib(resolved)) ?? 'unknown'
  const validation: MavenValidation = {
    ok: true,
    maven: {
      id: randomUUID(),
      name: buildName(version),
      homePath: resolved,
      version,
      source: 'manual'
    }
  }
  const defaultSettings = path.join(resolved, 'conf', 'settings.xml')
  const localRepoFromDefault = await parseLocalRepoFromSettings(defaultSettings)
  if (localRepoFromDefault) {
    validation.defaultSettingsPath = defaultSettings
    validation.settingsLocalRepo = localRepoFromDefault
  } else {
    // 文件存在但无 localRepository：仍提示默认 settings 路径；不存在则不提示（回退 ~/.m2）
    try {
      await readFile(defaultSettings, 'utf8')
      validation.defaultSettingsPath = defaultSettings
    } catch {
      // 无 conf\settings.xml：maven 将回退 ~/.m2/settings.xml，不提示
    }
  }
  return validation
}

// ---------- 扫描结果与既有库合并（maven:scan 落库语义，对齐 mergeJdks） ----------

/**
 * 合并探测结果与既有列表（按 homePath 规范化去重）：
 * - 手动条目（source: 'manual'）原样保留，不被探测覆盖（含自定义 settings/仓库配置）；
 * - 探测条目（source: 'scan'）再次探到 → 刷新版本/名称，保留原 id（项目 mavenId 引用不失效）
 *   ——但**不覆盖**用户在该条目上改过的 settingsPath/localRepoPath；
 * - 既有条目本轮未探到 → 保留（保守合并，避免破坏项目引用）；
 * - 新发现 → 追加（source: 'scan'）。
 */
export function mergeMavens(existing: Maven[], scanned: Maven[]): Maven[] {
  const byHome = new Map<string, Maven>()
  for (const maven of existing) byHome.set(normalizeHomePath(maven.homePath), maven)
  for (const fresh of scanned) {
    const key = normalizeHomePath(fresh.homePath)
    const current = byHome.get(key)
    if (!current) {
      byHome.set(key, fresh)
    } else if (current.source === 'scan') {
      // 刷新元数据，id 与用户自定义的可选字段稳定
      byHome.set(key, {
        ...fresh,
        id: current.id,
        ...(current.settingsPath !== undefined ? { settingsPath: current.settingsPath } : {}),
        ...(current.localRepoPath !== undefined ? { localRepoPath: current.localRepoPath } : {})
      })
    }
  }
  return [...byHome.values()]
}

// ---------- 展示辅助：仓库路径的解析优先级 ----------

/**
 * 解析 Maven 条目的本地仓库展示值：显式 localRepoPath > settingsPath 解析 >
 * ~/.m2/repository（maven 缺省，仅当该目录真实存在时标注）。
 * 供 UI 展示与 MCP 输出；不参与校验。
 */
export async function resolveLocalRepo(maven: Maven): Promise<string | null> {
  if (maven.localRepoPath) return maven.localRepoPath
  if (maven.settingsPath) {
    const fromSettings = await parseLocalRepoFromSettings(maven.settingsPath)
    if (fromSettings) return fromSettings
  }
  const defaultRepo = path.join(os.homedir(), '.m2', 'repository')
  try {
    await readdir(defaultRepo)
    return defaultRepo
  } catch {
    return null
  }
}
