/**
 * JSON 持久化层（计划 §2.3-D / §3 S1.2）：projects.json / jdks.json / settings.json。
 *
 * 语义（S-6 决议，写死）：
 * - 内存缓存读写：读走缓存（同步、深拷贝返回），写更新缓存后立即落盘；
 * - **变更即写盘，不用防抖**——防抖会引入崩溃丢失窗口，与"状态连续性"决策驱动相悖；
 * - 原子写：写 <file>.tmp → rename 到 <file>（同目录 rename 保证卷内原子性，Windows 下
 *   libuv 使用 MoveFileEx + REPLACE_EXISTING）；
 * - 启动加载失败（JSON 损坏 / 结构不符）：把损坏文件 rename 为 <file>.corrupt-<ts>
 *   备份后重建默认值，绝不在损坏数据上继续运行，也绝不静默丢掉用户文件；
 * - EventEmitter 通知：projects:changed / jdks:changed / settings:changed，
 *   供后续 IPC 广播（renderer 刷新）与 MCP 通知复用；载荷为变更后的完整新值（深拷贝）。
 *
 * 本模块零 electron 依赖（路径经 AppPaths 注入），vitest 纯 Node 环境可完整测试。
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AppPaths } from './paths'
import type { Jdk, Project, ProjectInput, Settings } from '../../shared/types'

// ---------- 事件 ----------

export const CONFIG_EVENTS = {
  PROJECTS_CHANGED: 'projects:changed',
  JDKS_CHANGED: 'jdks:changed',
  SETTINGS_CHANGED: 'settings:changed'
} as const

// ---------- 错误 ----------

export type ConfigErrorCode = 'NOT_FOUND' | 'CONFLICT'

/** 配置层语义错误（ipc-registry 捕获后映射为结构化 IPC 错误） */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode

  constructor(code: ConfigErrorCode, message: string) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

// ---------- 设置默认值（Settings 默认值的唯一权威，§2.4 设置页/S1 拥有） ----------

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  mcpEnabled: true,
  mcpPort: 7777,
  exitPolicy: 'keep',
  startupGraceSeconds: 5,
  pollIntervalSeconds: 5,
  tailInitialLines: 200,
  logMaxFileMb: 10,
  logMaxRotations: 3,
  logRunsToKeep: 10,
  scanRoots: [],
  closeToTray: true,
  webEnabled: true,
  webPort: 7790
})

// ---------- 结构校验（加载时形状闸门：过不了 = 视为损坏走备份重建） ----------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isString = (v: unknown): v is string => typeof v === 'string'

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)

const isStringRecord = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every(isString)

const isOptional = (v: unknown, pred: (v: unknown) => boolean): boolean =>
  v === undefined || pred(v)

const ENCODINGS = new Set(['auto', 'utf8', 'gbk'])

/** 单个 Project 形状校验（宽容多余字段：向前兼容后续阶段新增配置项） */
function validateProject(v: unknown): Project | null {
  if (!isRecord(v)) return null
  const ok =
    isString(v['id']) &&
    isString(v['name']) &&
    isString(v['jarPath']) &&
    isString(v['jdkId']) &&
    isStringArray(v['jvmArgs']) &&
    isStringArray(v['programArgs']) &&
    isStringRecord(v['envVars']) &&
    isOptional(v['logFilePath'], isString) &&
    (v['encodingOverride'] === undefined || ENCODINGS.has(v['encodingOverride'] as string))
  return ok ? (v as unknown as Project) : null
}

function validateProjects(v: unknown): Project[] | null {
  if (!Array.isArray(v)) return null
  return v.every(validateProject) ? (v as Project[]) : null
}

function validateJdk(v: unknown): Jdk | null {
  if (!isRecord(v)) return null
  const ok =
    isString(v['id']) &&
    isString(v['name']) &&
    isString(v['homePath']) &&
    isString(v['version']) &&
    isString(v['vendor']) &&
    (v['source'] === 'scan' || v['source'] === 'manual')
  return ok ? (v as unknown as Jdk) : null
}

function validateJdks(v: unknown): Jdk[] | null {
  if (!Array.isArray(v)) return null
  return v.every(validateJdk) ? (v as Jdk[]) : null
}

/**
 * settings 形状校验：已知键类型不符 → null（损坏）；缺键 → 交给上层回补默认值。
 * 返回 Partial<Settings>，由调用方与 DEFAULT_SETTINGS 合并（向后兼容旧版本缺字段）。
 */
function validateSettingsShape(v: unknown): Partial<Settings> | null {
  if (!isRecord(v)) return null
  if (
    !isOptional(v['mcpEnabled'], (x) => typeof x === 'boolean') ||
    !isOptional(v['mcpPort'], (x) => typeof x === 'number' && Number.isInteger(x)) ||
    !isOptional(v['exitPolicy'], (x) => x === 'keep' || x === 'stopAll') ||
    !isOptional(v['startupGraceSeconds'], (x) => typeof x === 'number') ||
    !isOptional(v['pollIntervalSeconds'], (x) => typeof x === 'number') ||
    !isOptional(v['tailInitialLines'], (x) => typeof x === 'number') ||
    !isOptional(v['logMaxFileMb'], (x) => typeof x === 'number') ||
    !isOptional(v['logMaxRotations'], (x) => typeof x === 'number') ||
    !isOptional(v['logRunsToKeep'], (x) => typeof x === 'number') ||
    !isOptional(v['scanRoots'], isStringArray) ||
    !isOptional(v['closeToTray'], (x) => typeof x === 'boolean') ||
    !isOptional(v['webEnabled'], (x) => typeof x === 'boolean') ||
    !isOptional(v['webPort'], (x) => typeof x === 'number' && Number.isInteger(x))
  ) {
    return null
  }
  const partial: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(v)) {
    if (value !== undefined) partial[key] = value
  }
  return partial as Partial<Settings>
}

// ---------- 原子 JSON 文件（内存缓存 + 变更即写 + 损坏备份重建） ----------

interface AtomicJsonFileOptions<T> {
  /** 形状校验；null = 损坏 */
  validate: (raw: unknown) => T | null
  /** 新建/损坏重建时的默认值 */
  makeDefault: () => T
}

class AtomicJsonFile<T> {
  private cache: T | undefined

  constructor(
    private readonly file: string,
    private readonly options: AtomicJsonFileOptions<T>
  ) {}

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // 首次运行：写入默认值（同时把 config/ 目录建出来）
        this.cache = this.options.makeDefault()
        await this.persist()
        return
      }
      throw err
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.recoverFromCorrupt()
      return
    }
    const validated = this.options.validate(parsed)
    if (validated === null) {
      await this.recoverFromCorrupt()
      return
    }
    this.cache = validated
  }

  /** 损坏自愈：rename 备份原文件 → 重建默认值落盘。备份失败仅记日志（不阻塞启动，persist 会覆盖坏文件）。 */
  private async recoverFromCorrupt(): Promise<void> {
    const backup = `${this.file}.corrupt-${Date.now()}`
    try {
      await rename(this.file, backup)
      console.warn(`[config-store] 配置文件损坏，已备份为 ${backup} 并重建默认值`)
    } catch (err) {
      console.error(`[config-store] 损坏文件备份失败（${this.file} → ${backup}）：`, err)
    }
    this.cache = this.options.makeDefault()
    await this.persist()
  }

  /** 读缓存（深拷贝，杜绝调用方直改内部状态）；未 load 先抛错 */
  get(): T {
    return structuredClone(this.requireCache())
  }

  /** 更新缓存并立即原子写盘（变更即写，不防抖） */
  async set(value: T): Promise<void> {
    this.requireCache()
    this.cache = structuredClone(value)
    await this.persist()
  }

  private requireCache(): T {
    if (this.cache === undefined) {
      throw new Error(`配置文件尚未加载：${this.file}（先 await ConfigStore.init()）`)
    }
    return this.cache
  }

  private async persist(): Promise<void> {
    // TODO(P3-4, phase4 审查)：rename 无 EPERM/EACCES/EBUSY 退避重试——与 pid-registry
    // 的 renameWithRetry 健壮性不一致（Windows 杀软/索引器瞬态锁同源风险）；设置保存
    // 偶发失败会以 IPC 错误暴露（缓存/盘一致性无损，下次写盘修复），后续可复用同款重试。
    await mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.cache, null, 2)}\n`, 'utf8')
    await rename(tmp, this.file)
  }
}

// ---------- 输入类型 ----------

/** jdk:add 请求体（channel 表为 Jdk，id 允许缺省由 store 生成） */
export type JdkInput = Omit<Jdk, 'id'> & { id?: string }

// ---------- ConfigStore 门面 ----------

/**
 * 三个 JSON store 的门面 + CRUD + 事件。
 * 读方法同步（缓存），写方法异步（变更即写盘，await 返回即已落盘）。
 */
export class ConfigStore extends EventEmitter {
  private readonly projectsFile: AtomicJsonFile<Project[]>
  private readonly jdksFile: AtomicJsonFile<Jdk[]>
  private readonly settingsFile: AtomicJsonFile<Settings>

  constructor(paths: AppPaths) {
    super()
    this.projectsFile = new AtomicJsonFile<Project[]>(paths.projectsFile, {
      validate: validateProjects,
      makeDefault: () => []
    })
    this.jdksFile = new AtomicJsonFile<Jdk[]>(paths.jdksFile, {
      validate: validateJdks,
      makeDefault: () => []
    })
    this.settingsFile = new AtomicJsonFile<Settings>(paths.settingsFile, {
      validate: (raw) => {
        const partial = validateSettingsShape(raw)
        return partial === null ? null : { ...structuredClone(DEFAULT_SETTINGS), ...partial }
      },
      makeDefault: () => structuredClone(DEFAULT_SETTINGS)
    })
  }

  /** 启动加载（文件缺失→建默认；损坏→备份重建）。主进程 whenReady 后调用一次。 */
  async init(): Promise<void> {
    await Promise.all([
      this.projectsFile.load(),
      this.jdksFile.load(),
      this.settingsFile.load()
    ])
  }

  // ---------- projects ----------

  listProjects(): Project[] {
    return this.projectsFile.get()
  }

  async createProject(input: ProjectInput): Promise<Project> {
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      jarPath: input.jarPath,
      jdkId: input.jdkId,
      jvmArgs: [...input.jvmArgs],
      programArgs: [...input.programArgs],
      envVars: { ...input.envVars },
      ...(input.logFilePath !== undefined ? { logFilePath: input.logFilePath } : {}),
      ...(input.encodingOverride !== undefined
        ? { encodingOverride: input.encodingOverride }
        : {})
    }
    const next = [...this.projectsFile.get(), project]
    await this.projectsFile.set(next)
    this.emitChanged(CONFIG_EVENTS.PROJECTS_CHANGED, next)
    return structuredClone(project)
  }

  /** 整体替换语义（§2.5 update 携带全量 ProjectInput）；运行中项目的"重启后生效"提示由上层负责 */
  async updateProject(input: ProjectInput & { id: string }): Promise<Project> {
    const list = this.projectsFile.get()
    const index = list.findIndex((p) => p.id === input.id)
    if (index === -1) {
      throw new ConfigError('NOT_FOUND', `项目不存在：${input.id}`)
    }
    const updated: Project = {
      id: input.id,
      name: input.name,
      jarPath: input.jarPath,
      jdkId: input.jdkId,
      jvmArgs: [...input.jvmArgs],
      programArgs: [...input.programArgs],
      envVars: { ...input.envVars },
      ...(input.logFilePath !== undefined ? { logFilePath: input.logFilePath } : {}),
      ...(input.encodingOverride !== undefined
        ? { encodingOverride: input.encodingOverride }
        : {})
    }
    list[index] = updated
    await this.projectsFile.set(list)
    this.emitChanged(CONFIG_EVENTS.PROJECTS_CHANGED, list)
    return structuredClone(updated)
  }

  /** 仅删配置。运行中项目的"先 stop 再删"编排（confirm=true）在 ipc-registry 注入的 ProcessControl 中（S3 前无进程概念，直接删）。 */
  async deleteProject(id: string): Promise<Project> {
    const list = this.projectsFile.get()
    const index = list.findIndex((p) => p.id === id)
    if (index === -1) {
      throw new ConfigError('NOT_FOUND', `项目不存在：${id}`)
    }
    const removed = list[index]
    const next = list.filter((p) => p.id !== id)
    await this.projectsFile.set(next)
    this.emitChanged(CONFIG_EVENTS.PROJECTS_CHANGED, next)
    return structuredClone(removed)
  }

  // ---------- jdks ----------

  listJdks(): Jdk[] {
    return this.jdksFile.get()
  }

  /** id 缺省时生成（S2 扫描器/手动添加共用） */
  async addJdk(input: JdkInput): Promise<Jdk> {
    const jdk: Jdk = {
      id: input.id ?? randomUUID(),
      name: input.name,
      homePath: input.homePath,
      version: input.version,
      vendor: input.vendor,
      source: input.source
    }
    const next = [...this.jdksFile.get(), jdk]
    await this.jdksFile.set(next)
    this.emitChanged(CONFIG_EVENTS.JDKS_CHANGED, next)
    return structuredClone(jdk)
  }

  async updateJdk(jdk: Jdk): Promise<Jdk> {
    const list = this.jdksFile.get()
    const index = list.findIndex((j) => j.id === jdk.id)
    if (index === -1) {
      throw new ConfigError('NOT_FOUND', `JDK 不存在：${jdk.id}`)
    }
    list[index] = { ...jdk }
    await this.jdksFile.set(list)
    this.emitChanged(CONFIG_EVENTS.JDKS_CHANGED, list)
    return structuredClone(list[index])
  }

  /**
   * 整体替换 jdks 列表（S2 扫描合并落库：jdk-scanner.mergeJdks 产物一次性写回；
   * id 生成/引用校验在合并逻辑与 removeJdk 各自负责，此处不做逐条语义校验）。
   */
  async replaceJdks(jdks: Jdk[]): Promise<Jdk[]> {
    const next = structuredClone(jdks)
    await this.jdksFile.set(next)
    this.emitChanged(CONFIG_EVENTS.JDKS_CHANGED, next)
    return structuredClone(next)
  }

  /** 被项目引用时拒绝（错误信息含引用项目名，UI/Agent 可据此引导改绑） */
  async removeJdk(id: string): Promise<Jdk> {
    const jdks = this.jdksFile.get()
    const index = jdks.findIndex((j) => j.id === id)
    if (index === -1) {
      throw new ConfigError('NOT_FOUND', `JDK 不存在：${id}`)
    }
    const target = jdks[index]
    const referrers = this.projectsFile.get().filter((p) => p.jdkId === id)
    if (referrers.length > 0) {
      const names = referrers.map((p) => p.name).join('、')
      throw new ConfigError(
        'CONFLICT',
        `JDK「${target.name}」正被 ${referrers.length} 个项目引用：${names}；请先删除这些项目或改绑其他 JDK`
      )
    }
    const next = jdks.filter((j) => j.id !== id)
    await this.jdksFile.set(next)
    this.emitChanged(CONFIG_EVENTS.JDKS_CHANGED, next)
    return structuredClone(target)
  }

  // ---------- settings ----------

  getSettings(): Settings {
    return this.settingsFile.get()
  }

  /** 局部合并：只传要改的键，其余保留现值（未出现的键不覆盖） */
  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    const merged: Settings = { ...this.settingsFile.get(), ...patch }
    await this.settingsFile.set(merged)
    this.emitChanged(CONFIG_EVENTS.SETTINGS_CHANGED, merged)
    return structuredClone(merged)
  }

  // ---------- 事件 ----------

  private emitChanged(event: string, payload: unknown): void {
    this.emit(event, structuredClone(payload))
  }
}
