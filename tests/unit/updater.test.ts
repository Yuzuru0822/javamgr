import { describe, expect, it, vi } from 'vitest'
import { UpdaterHost } from '../../src/main/updater'
import type { AutoUpdaterLike } from '../../src/main/updater'
import type { UpdaterStatus } from '../../src/shared/types'
import type { UpdateInfo, ProgressInfo } from 'electron-updater'

/**
 * 更新宿主单测（v0.4.0）：注入 fake autoUpdater（EventEmitter 语义）验证
 * 状态机流转、自动下载触发、防重入、installNow 守卫与开发模式报错。
 * electron-updater 真实行为（latest.yml 拉取/差量下载/静默安装）不在单测面
 * ——由打包冒烟与真实 Release 链路覆盖。
 */

/** fake autoUpdater：记录调用，测试手动 emit 事件 */
function makeFakeUpdater(): AutoUpdaterLike & {
  calls: { check: number; download: number; quit: number }
  emit(event: string, payload?: unknown): void
} {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const calls = { check: 0, download: 0, quit: 0 }
  const on = (event: string, listener: (payload: unknown) => void): unknown => {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
    return listener
  }
  return {
    calls,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: undefined,
    on: on as never,
    emit(event, payload) {
      for (const l of listeners.get(event) ?? []) l(payload)
    },
    async checkForUpdates() {
      calls.check++
      return null
    },
    async downloadUpdate() {
      calls.download++
      return null
    },
    quitAndInstall() {
      calls.quit++
    }
  } as never
}

function makeHost(isPackaged = true): {
  host: UpdaterHost
  fake: ReturnType<typeof makeFakeUpdater>
  statuses: UpdaterStatus[]
} {
  const fake = makeFakeUpdater()
  const statuses: UpdaterStatus[] = []
  const host = new UpdaterHost({
    isPackaged,
    onStatus: (s) => statuses.push({ ...s }),
    autoUpdater: fake
  })
  return { host, fake, statuses }
}

describe('updater/UpdaterHost：装配契约', () => {
  it('autoDownload=false + autoInstallOnAppQuit=true + 静音日志（手动检查+自动下载、稍后=退出时装）', () => {
    const { fake } = makeHost()
    expect(fake.autoDownload).toBe(false)
    expect(fake.autoInstallOnAppQuit).toBe(true)
    expect(fake.logger).toBeNull()
  })
})

describe('updater/UpdaterHost：状态机', () => {
  it('checking → available(vX) 自动 downloadUpdate → downloading 进度载荷 → downloaded', () => {
    const { host, fake, statuses } = makeHost()
    host.check()
    expect(fake.calls.check).toBe(1)
    fake.emit('checking-for-update') // 真实 autoUpdater 在 checkForUpdates 内部 emit；fake 手动驱动
    expect(statuses.at(-1)).toEqual({ state: 'checking' })

    fake.emit('update-available', { version: '0.5.0' } as UpdateInfo)
    expect(statuses.at(-1)).toEqual({ state: 'available', version: '0.5.0' })
    expect(fake.calls.download).toBe(1) // 发现新版无需确认直接下载

    fake.emit('download-progress', {
      percent: 42.5,
      transferred: 1024,
      total: 4096,
      bytesPerSecond: 2048
    } as ProgressInfo)
    expect(statuses.at(-1)).toEqual({
      state: 'downloading',
      version: '0.5.0',
      percent: 42.5,
      transferred: 1024,
      total: 4096,
      bytesPerSecond: 2048
    })

    fake.emit('update-downloaded', { version: '0.5.0' } as UpdateInfo)
    expect(statuses.at(-1)).toEqual({ state: 'downloaded', version: '0.5.0' })
    expect(host.getState()).toEqual({ state: 'downloaded', version: '0.5.0' })
  })

  it('update-not-available → not-available（远端版本回显）', () => {
    const { host, fake, statuses } = makeHost()
    host.check()
    fake.emit('update-not-available', { version: '0.4.0' } as UpdateInfo)
    expect(statuses.at(-1)).toEqual({ state: 'not-available', version: '0.4.0' })
  })

  it('error 事件 → error 态携带原因', () => {
    const { host, fake, statuses } = makeHost()
    host.check()
    fake.emit('error', new Error('ETIMEDOUT 连接超时'))
    expect(statuses.at(-1)).toEqual({ state: 'error', error: 'ETIMEDOUT 连接超时' })
  })

  it('防重入：checking/downloading 期间重复 check 不再触发 checkForUpdates', () => {
    const { host, fake } = makeHost()
    host.check()
    fake.emit('checking-for-update')
    host.check()
    host.check()
    expect(fake.calls.check).toBe(1)
    fake.emit('update-available', { version: '0.5.0' } as UpdateInfo)
    fake.emit('download-progress', { percent: 10 } as ProgressInfo)
    host.check()
    expect(fake.calls.check).toBe(1) // downloading 中仍不重入
  })
})

describe('updater/UpdaterHost：installNow 与开发模式', () => {
  it('installNow 仅 downloaded 态生效（静默 + 装完自启）', () => {
    const { host, fake } = makeHost()
    host.installNow()
    expect(fake.calls.quit).toBe(0) // 非 downloaded 不触发
    fake.emit('update-downloaded', { version: '0.5.0' } as UpdateInfo)
    host.installNow()
    expect(fake.calls.quit).toBe(1)
  })

  it('开发模式：check 显式报错且不触达 autoUpdater', () => {
    const { host, fake, statuses } = makeHost(false)
    const result = host.check()
    expect(result.state).toBe('error')
    expect(result.error).toContain('开发模式')
    expect(fake.calls.check).toBe(0)
    expect(statuses.at(-1)?.state).toBe('error')
  })
})

describe('updater/UpdaterHost：check 的 promise 拒绝不致未处理异常', () => {
  it('checkForUpdates 抛错由 error 事件通道呈现（catch 兜底不重复抛出）', async () => {
    const { host, fake } = makeHost()
    const checkForUpdates = vi.fn().mockRejectedValue(new Error('网络异常'))
    Object.assign(fake, { checkForUpdates })
    expect(() => host.check()).not.toThrow()
    await Promise.resolve()
    fake.emit('error', new Error('网络异常'))
    expect(host.getState().state).toBe('error')
  })
})
