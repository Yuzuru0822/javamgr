import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { Jdk, ScanProgressEvent } from '@shared/types'
import { ipc, ipcEvents } from '@renderer/api/ipc'

/**
 * JDK 列表镜像 + 扫描/手动添加/编辑/删除（S2 接通 jdk:* IPC，数据落 <userData>/config/jdks.json）。
 * - 扫描中状态 + jdk:scanProgress 事件镜像（进度条提示）；
 * - 各写操作返回主进程合并后的完整 Jdk[]，直接替换本地镜像（单一权威源在主进程）。
 */
export const useJdksStore = defineStore('jdks', () => {
  const jdks = ref<Jdk[]>([])
  const loaded = ref(false)
  const scanning = ref(false)
  const progress = ref<ScanProgressEvent | null>(null)

  let unsubscribeProgress: (() => void) | null = null

  async function refresh(): Promise<void> {
    jdks.value = await ipc.jdk.list()
    loaded.value = true
  }

  /** 订阅扫描进度事件（JdkView 挂载时调用；卸载时 unbindScanProgress） */
  function bindScanProgress(): void {
    if (unsubscribeProgress) return
    unsubscribeProgress = ipcEvents.scanProgress((p) => {
      progress.value = p
    })
  }

  function unbindScanProgress(): void {
    unsubscribeProgress?.()
    unsubscribeProgress = null
  }

  /** 目录扫描：主进程边扫边推进度，完成后返回合并（保留手动条目）后的完整列表 */
  async function scan(): Promise<void> {
    scanning.value = true
    progress.value = null
    try {
      jdks.value = await ipc.jdk.scan()
    } finally {
      scanning.value = false
    }
  }

  async function add(homePath: string, name?: string): Promise<void> {
    jdks.value = await ipc.jdk.add(homePath, name)
  }

  async function update(id: string, homePath: string, name?: string): Promise<void> {
    jdks.value = await ipc.jdk.update(id, homePath, name)
  }

  async function remove(id: string): Promise<void> {
    jdks.value = await ipc.jdk.remove(id)
  }

  return {
    jdks,
    loaded,
    scanning,
    progress,
    refresh,
    scan,
    add,
    update,
    remove,
    bindScanProgress,
    unbindScanProgress
  }
})
