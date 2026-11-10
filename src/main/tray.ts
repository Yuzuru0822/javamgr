/**
 * 系统托盘（计划 §2.4 / §3 S3.5）：显示/隐藏面板、全部启动、全部停止、退出。
 *
 * 退出菜单只调 app.quit()——退出策略（keep | stopAll）统一由 index.ts 挂接的
 * before-quit → lifecycle.prepareExit 执行（单一出口，托盘与窗口关闭不各自为政）。
 *
 * 托盘图标：程序化生成的 base64 PNG（nativeImage.createFromDataURL），不引外部
 * 资产文件（打包期无 ico 资产时的占位方案，S6 可替换正式图标）。
 */

import { app, Menu, nativeImage, Tray } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ProcessManager } from './process/process-manager'

/** 16×16 绿色圆角方块 PNG（data URL；见文件头注释） */
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMElEQVR4nGNggALpOIX/pGAGdKBXa/SfFMyAbDOpmmEY7JJRA0YNGCYGUJyZKM3OALpBsZDU15+8AAAAAElFTkSuQmCC'

export interface TrayDependencies {
  processManager: ProcessManager
  /** 取主面板窗口（不存在时由调用方决定是否新建；托盘只负责显示/隐藏） */
  getMainWindow: () => BrowserWindow | undefined
  /** 显示面板（无窗口时新建） */
  showPanel: () => void
}

/**
 * 托盘 tooltip 文案（S6.2：MCP bind-failed 状态在托盘呈现）。
 * 纯函数：成功 → 端口标注；失败 → 显式"不可用 + 端口被占"（绝不静默漂移，R4/A15）。
 */
export function mcpTrayTooltip(
  status: { enabled: boolean; port?: number; error?: string } | undefined
): string {
  if (!status) return 'Java 进程管理器'
  if (status.enabled) {
    return status.port !== undefined ? `Java 进程管理器（MCP :${status.port}）` : 'Java 进程管理器'
  }
  if (status.error) {
    return `Java 进程管理器 — MCP 不可用${
      status.port !== undefined ? `（端口 ${status.port} 被占用）` : ''
    }，其余功能正常`
  }
  return 'Java 进程管理器'
}

export function createTray(deps: TrayDependencies): Tray {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  const tray = new Tray(icon)
  tray.setToolTip('Java 进程管理器')

  const rebuildMenu = (): void => {
    const menu = Menu.buildFromTemplate([
      {
        label: '显示面板',
        click: () => {
          const win = deps.getMainWindow()
          if (win === undefined || win.isDestroyed()) {
            deps.showPanel()
            return
          }
          if (win.isVisible()) {
            win.hide()
          } else {
            win.show()
            win.focus()
          }
        }
      },
      { type: 'separator' },
      {
        label: '全部启动',
        click: () => {
          void deps.processManager.startAllProjects().then((batch) => {
            const failed = batch.results.filter((r) => !r.ok)
            const suffix =
              failed.length > 0 ? `（${failed.length} 个失败，详见面板）` : '（全部成功）'
            tray.displayBalloon?.({ title: 'Java 进程管理器', content: `全部启动完成${suffix}` })
          })
        }
      },
      {
        label: '全部停止',
        click: () => {
          void deps.processManager.stopAllProjects().then((batch) => {
            const failed = batch.results.filter((r) => !r.ok)
            const suffix =
              failed.length > 0 ? `（${failed.length} 个失败，详见面板）` : '（全部成功）'
            tray.displayBalloon?.({ title: 'Java 进程管理器', content: `全部停止完成${suffix}` })
          })
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit() // before-quit → lifecycle.prepareExit（exitPolicy：keep | stopAll）
        }
      }
    ])
    tray.setContextMenu(menu)
  }

  rebuildMenu()
  return tray
}
