/**
 * userData 路径规划（计划 §2.3-D / §3 S1.1）。
 *
 * 目录布局（<userData> 为 Electron app.getPath('userData')）：
 *   <userData>/config/projects.json   纳管项目（config-store）
 *   <userData>/config/jdks.json       已识别 JDK（config-store；S2 扫描器写入）
 *   <userData>/config/settings.json   设置（config-store；默认值见 config-store.ts）
 *   <userData>/logs/                  日志区：<projectId>/<runId>.log（S4 log-store）
 *   <userData>/runs.json              运行记录（S3 pid-registry 落盘 + 重识别）
 *   <userData>/mcp.port               主实例实际 MCP 端口（S5 stdio 桥接发现用）
 *
 * 可注入设计：本模块零 electron 依赖。主进程在 app.whenReady 后调用
 * configureUserData(app.getPath('userData'))；纯 Node 环境（vitest）注入临时目录，
 * 从而 paths / config-store 可在无 app 对象下完整测试。
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'

export interface AppPaths {
  readonly userDataDir: string
  /** <userData>/config/ —— 三个 JSON store 所在目录 */
  readonly configDir: string
  /** <userData>/logs/ —— 运行日志区（S4） */
  readonly logsDir: string
  readonly projectsFile: string
  readonly jdksFile: string
  readonly settingsFile: string
  /** <userData>/runs.json（S3） */
  readonly runsFile: string
  /** <userData>/mcp.port（S5） */
  readonly mcpPortFile: string
}

/** userData 来源：固定目录或惰性求值（app.getPath 需在 ready 前后均可取，用惰性求值最稳） */
type UserDataProvider = () => string

let userDataProvider: UserDataProvider | undefined

/** 注入 userData 目录（主进程传 app.getPath('userData')；测试传临时目录）。重复调用以最后一次为准。 */
export function configureUserData(provider: string | UserDataProvider): void {
  userDataProvider = typeof provider === 'string' ? () => provider : provider
}

export function getUserDataDir(): string {
  if (!userDataProvider) {
    throw new Error(
      'userData 未配置：请先调用 configureUserData()（主进程注入 app.getPath("userData")，测试注入临时目录）'
    )
  }
  const dir = userDataProvider()
  if (!dir) {
    throw new Error('configureUserData 解析到空的 userData 目录')
  }
  return dir
}

/** 纯函数：由 userData 目录派生全部路径（供测试与 ConfigStore 注入复用） */
export function resolveAppPaths(userDataDir: string): AppPaths {
  const configDir = path.join(userDataDir, 'config')
  const logsDir = path.join(userDataDir, 'logs')
  return {
    userDataDir,
    configDir,
    logsDir,
    projectsFile: path.join(configDir, 'projects.json'),
    jdksFile: path.join(configDir, 'jdks.json'),
    settingsFile: path.join(configDir, 'settings.json'),
    runsFile: path.join(userDataDir, 'runs.json'),
    mcpPortFile: path.join(userDataDir, 'mcp.port')
  }
}

/** 按当前注入的 userData 取路径（未配置则抛错，见 getUserDataDir） */
export function getPaths(): AppPaths {
  return resolveAppPaths(getUserDataDir())
}

/** 启动时建目录（幂等）：config/ 与 logs/。runs.json 与 mcp.port 落在 userData 根，无需预建目录。 */
export async function ensureDirs(paths: AppPaths = getPaths()): Promise<void> {
  await mkdir(paths.configDir, { recursive: true })
  await mkdir(paths.logsDir, { recursive: true })
}
