/**
 * 自动更新宿主（v0.4.0，electron-updater 封装）。
 *
 * 原理：GitHub Releases 作为更新源——
 * - 构建（electron-builder.yml publish.github）在产物 resources/ 写入 app-update.yml，
 *   electron-updater 运行时据此匿名拉取 Release 资产中的 latest.yml（版本 + sha512 + 大小）；
 * - checkForUpdates → semver 比对当前 app.getVersion()；
 * - 发现新版自动 downloadUpdate（NSIS 差量：按 .blockmap 只下载变化块）；
 * - quitAndInstall(true, true) = 退出 → NSIS 静默安装（/S）→ 自动启动新版；
 *   退出走既有 before-quit → exitPolicy（keep 下托管 java 子进程存活，新版启动后
 *   按 runs.json 重识别——更新过程业务零中断）。
 *
 * 状态机：idle → checking → available →（自动）downloading → downloaded；
 * 无新版 → not-available；任一步失败 → error。全状态经 onStatus 广播
 * （IPC updater:status），getState 快照供重开设置页恢复进度。
 *
 * 本模块零 electron 依赖（isPackaged 经构造注入，纯 Node 可测）；
 * electron-updater 的 autoUpdater 经构造注入默认实例（单测换 fake）。
 */

import type { UpdateInfo, ProgressInfo } from 'electron-updater'
import type { UpdaterStatus } from '../shared/types'

/** electron-updater autoUpdater 的结构子集（注入面；生产为真实单例） */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: unknown
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-available', listener: (info: UpdateInfo) => void): unknown
  on(event: 'update-not-available', listener: (info: UpdateInfo) => void): unknown
  on(event: 'download-progress', listener: (info: ProgressInfo) => void): unknown
  on(event: 'update-downloaded', listener: (info: UpdateInfo) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterHostOptions {
  /** 生产传 app.isPackaged；开发模式 check 显式报错（无 app-update.yml 可用） */
  isPackaged: boolean
  /** 状态广播（装配层接 webContents.send updater:status） */
  onStatus: (status: UpdaterStatus) => void
  /** 默认真实 autoUpdater；单测注入 fake */
  autoUpdater?: AutoUpdaterLike
}

export class UpdaterHost {
  private readonly autoUpdater: AutoUpdaterLike
  private readonly isPackaged: boolean
  private readonly onStatus: (status: UpdaterStatus) => void
  /** available 后记住目标版本，downloading 进度载荷携带（ProgressInfo 不含版本） */
  private targetVersion: string | undefined
  private status: UpdaterStatus = { state: 'idle' }

  constructor(opts: UpdaterHostOptions) {
    this.isPackaged = opts.isPackaged
    this.onStatus = opts.onStatus
    this.autoUpdater = opts.autoUpdater ?? defaultAutoUpdater()

    // 手动检查 + 自动执行：发现新版即自动 downloadUpdate（点击"检查更新"= 检查+下载全自动，
    // 只在重启安装前征求确认）；quitAndInstall 由渲染端显式触发。
    this.autoUpdater.autoDownload = false
    // 稍后安装：下载完成后正常退出时自动静默安装，再开即新版
    this.autoUpdater.autoInstallOnAppQuit = true
    this.autoUpdater.logger = null // electron-updater 默认 console 输出过于冗长

    this.autoUpdater.on('checking-for-update', () => this.emit({ state: 'checking' }))
    this.autoUpdater.on('update-available', (info) => {
      this.targetVersion = info.version
      this.emit({ state: 'available', version: info.version })
      // "点击检查更新就自动执行更新"：发现新版无需二次确认直接进入下载；
      // 失败由 error 事件统一显式呈现（可重试）
      void this.autoUpdater.downloadUpdate().catch(() => undefined)
    })
    this.autoUpdater.on('update-not-available', (info) =>
      this.emit({ state: 'not-available', version: info.version })
    )
    this.autoUpdater.on('download-progress', (info) =>
      this.emit({
        state: 'downloading',
        ...(this.targetVersion !== undefined ? { version: this.targetVersion } : {}),
        percent: info.percent,
        transferred: info.transferred,
        total: info.total,
        bytesPerSecond: info.bytesPerSecond
      })
    )
    this.autoUpdater.on('update-downloaded', (info) =>
      this.emit({ state: 'downloaded', version: info.version })
    )
    this.autoUpdater.on('error', (err) =>
      this.emit({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    )
  }

  /** 触发检查；返回即时快照（后续经 onStatus 推送）。开发模式显式报错不静默 */
  check(): UpdaterStatus {
    if (!this.isPackaged) {
      return this.emit({
        state: 'error',
        error: '开发模式不支持检查更新（更新器依赖打包产物的 app-update.yml，请使用安装版）'
      })
    }
    if (this.status.state === 'checking' || this.status.state === 'downloading') {
      return this.status // 防重入：进行中直接返回现状态
    }
    void this.autoUpdater.checkForUpdates().catch(() => undefined) // 失败走 error 事件
    return this.status
  }

  /** 立即重启安装（仅 downloaded 态有意义；静默安装 + 装完自动启动） */
  installNow(): void {
    if (this.status.state !== 'downloaded') return
    this.autoUpdater.quitAndInstall(true, true)
  }

  getState(): UpdaterStatus {
    return { ...this.status }
  }

  private emit(status: UpdaterStatus): UpdaterStatus {
    this.status = { ...status }
    this.onStatus(this.status)
    return this.status
  }
}

/** 真实 autoUpdater 单例（延迟 require 语义：仅生产装配路径调用；单测注入 fake 不触达） */
function defaultAutoUpdater(): AutoUpdaterLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require('electron-updater') as {
    autoUpdater: AutoUpdaterLike
  }
  return autoUpdater
}
