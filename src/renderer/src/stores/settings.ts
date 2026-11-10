import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { Settings } from '@shared/types'
import { ipc, ipcEvents } from '@renderer/api/ipc'

/**
 * 设置镜像（S1 接通 settings:get/set，落 <userData>/config/settings.json）。
 * App 启动时 load() 一次；save 为局部合并（只传要改的键）。
 * S5：首次 load 时订阅 mcp:portChanged——主实例端口变更（用户改端口/绑定失败）后
 * 重拉设置镜像，保证设置页与主进程契约端口状态一致（界面刷新兜底，视图层另有即时刷新）。
 * 退出策略 / 日志保留 / 扫描目录区块 S6 接入。
 */
export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings | null>(null)
  const loaded = ref(false)

  let portChangedBound = false

  function bindPortChanged(): void {
    if (portChangedBound) return
    portChangedBound = true
    ipcEvents.portChanged(() => {
      // 端口变更后主进程 settings.json 已是权威值；静默重拉（失败不打断界面）
      void ipc.settings
        .get()
        .then((next) => {
          settings.value = next
        })
        .catch(() => undefined)
    })
  }

  async function load(): Promise<void> {
    settings.value = await ipc.settings.get()
    loaded.value = true
    bindPortChanged()
  }

  /** 局部合并保存；返回完整 Settings 并更新本地镜像 */
  async function save(patch: Partial<Settings>): Promise<void> {
    settings.value = await ipc.settings.set(patch)
  }

  return { settings, loaded, load, save }
})
