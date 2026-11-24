// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import SettingsView from '@renderer/views/SettingsView.vue'
import type {
  LogCleanupResult,
  LogCleanupScope,
  LogStorageInfo,
  Settings
} from '@shared/types'

vi.setConfig({ testTimeout: 30_000 })

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

let settings: Settings
let storage: LogStorageInfo
let settingsPatches: Array<Partial<Settings>>
let cleanupScopes: Array<LogCleanupScope | undefined>

const cleanupResult = (scope: LogCleanupScope): LogCleanupResult => ({
  scope,
  logsDir:
    scope === 'current'
      ? 'D:\\javamgr-data\\javamgr-logs'
      : 'C:\\Users\\test\\AppData\\Roaming\\javamgr\\logs',
  freedBytes: 1024,
  deletedFiles: 1,
  remainingBytes: 2048,
  activeBytes: 512,
  errors: [],
  cleanedAt: '2026-11-24T01:00:00.000Z'
})

function mockWindowApi(): void {
  Object.assign(window, {
    api: {
      invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
        if (channel === 'settings:get') return structuredClone(settings)
        if (channel === 'settings:set') {
          const patch = args[0] as Partial<Settings>
          settingsPatches.push(patch)
          settings = { ...settings, ...patch }
          return structuredClone(settings)
        }
        if (channel === 'logs:getStorageInfo') return structuredClone(storage)
        if (channel === 'logs:cleanup') {
          const scope = (args[0] as { scope?: LogCleanupScope }).scope
          cleanupScopes.push(scope)
          return cleanupResult(scope ?? 'current')
        }
        if (channel === 'app:pickFile') return 'D:\\new-log-parent'
        if (channel === 'app:getMcpInfo') {
          return {
            enabled: false,
            port: 7777,
            url: 'http://127.0.0.1:7777/mcp',
            bridgeCommand: 'javamgr.exe --mcp-stdio'
          }
        }
        if (channel === 'app:getWebInfo') {
          return { enabled: false, port: 7790, url: 'http://127.0.0.1:7790' }
        }
        if (channel === 'app:getVersion') return '0.7.0-test'
        if (channel === 'updater:getState') return { state: 'idle' }
        if (channel === 'app:getEventLoopMetrics') {
          return { lastMs: 0, p95Ms: 0, samples: 0, windowMs: 30_000, sustainedHigh: false }
        }
        return {}
      },
      on: () => () => {}
    }
  })
}

async function mountView() {
  const wrapper = mount(SettingsView, {
    global: { plugins: [ElementPlus] },
    attachTo: document.body
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  settings = {
    mcpEnabled: true,
    mcpPort: 7777,
    exitPolicy: 'keep',
    startupGraceSeconds: 5,
    pollIntervalSeconds: 5,
    tailInitialLines: 200,
    logMaxFileMb: 10,
    logMaxRotations: 3,
    logRunsToKeep: 10,
    logRetentionDays: 7,
    logMaxTotalMb: 512,
    stdoutLogDir: 'D:\\javamgr-data',
    scanRoots: [],
    closeToTray: true,
    webEnabled: false,
    webPort: 7790
  }
  storage = {
    logsDir: 'D:\\javamgr-data\\javamgr-logs',
    defaultLogsDir: 'C:\\Users\\test\\AppData\\Roaming\\javamgr\\logs',
    totalBytes: 4096,
    activeBytes: 512,
    lastCleanupAt: '2026-11-24T00:00:00.000Z',
    errors: []
  }
  settingsPatches = []
  cleanupScopes = []
  setActivePinia(createPinia())
  mockWindowApi()
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('设置页 stdout 日志治理', () => {
  it('同步新设置并展示实际目录、用量和旧默认清理入口', async () => {
    const wrapper = await mountView()

    expect((wrapper.find('.retention-days-input input').element as HTMLInputElement).value).toBe('7')
    expect((wrapper.find('.max-total-mb-input input').element as HTMLInputElement).value).toBe('512')
    expect((wrapper.find('.stdout-parent-input input').element as HTMLInputElement).value).toBe(
      'D:\\javamgr-data'
    )
    expect((wrapper.find('.actual-log-dir input').element as HTMLInputElement).value).toBe(
      'D:\\javamgr-data\\javamgr-logs'
    )
    expect(wrapper.text()).toContain('总占用 4 KB')
    expect(wrapper.find('.cleanup-legacy').exists()).toBe(true)
    wrapper.unmount()
  })

  it('选择父目录立即保存并提示重启语义由卡片说明，当前目录清理传 current', async () => {
    const wrapper = await mountView()

    await wrapper.find('.choose-stdout-dir').trigger('click')
    await flushPromises()
    expect(settingsPatches).toContainEqual({ stdoutLogDir: 'D:\\new-log-parent' })

    await wrapper.find('.cleanup-current').trigger('click')
    await flushPromises()
    expect(cleanupScopes).toEqual(['current'])
    expect(wrapper.find('.cleanup-result').text()).toContain('释放 1 KB')
    expect(wrapper.find('.cleanup-result').text()).toContain('剩余 2 KB')
    wrapper.unmount()
  })

  it('旧默认目录清理经二次确认后显式传 legacyDefault', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm')
    const wrapper = await mountView()

    await wrapper.find('.cleanup-legacy').trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]?.[0]).toContain('全部 javamgr stdout 历史日志')
    expect(confirm.mock.calls[0]?.[0]).toContain('不会删除或检索项目外部 logback 日志')
    expect(cleanupScopes).toEqual(['legacyDefault'])
    wrapper.unmount()
  })
})
