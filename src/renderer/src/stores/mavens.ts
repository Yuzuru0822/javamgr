import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { Maven } from '@shared/types'
import { ipc } from '@renderer/api/ipc'

/**
 * Maven 列表镜像 + 探测/手动添加/编辑/删除（对齐 jdks store；数据落 <userData>/config/mavens.json）。
 * 各写操作返回主进程合并后的完整 Maven[]，直接替换本地镜像（单一权威源在主进程）。
 * 环境探测瞬间完成，无进度事件。
 */
export const useMavensStore = defineStore('mavens', () => {
  const mavens = ref<Maven[]>([])
  const loaded = ref(false)
  const scanning = ref(false)

  async function refresh(): Promise<void> {
    mavens.value = await ipc.maven.list()
    loaded.value = true
  }

  /** 环境探测：主进程探 M2_HOME/MAVEN_HOME/PATH，返回合并（保留手动条目）后的完整列表 */
  async function scan(): Promise<void> {
    scanning.value = true
    try {
      mavens.value = await ipc.maven.scan()
    } finally {
      scanning.value = false
    }
  }

  async function add(params: {
    homePath: string
    name?: string
    settingsPath?: string
    localRepoPath?: string
  }): Promise<void> {
    mavens.value = await ipc.maven.add(params)
  }

  async function update(params: {
    id: string
    homePath: string
    name?: string
    settingsPath?: string | null
    localRepoPath?: string | null
  }): Promise<void> {
    mavens.value = await ipc.maven.update(params)
  }

  async function remove(id: string): Promise<void> {
    mavens.value = await ipc.maven.remove(id)
  }

  return { mavens, loaded, scanning, refresh, scan, add, update, remove }
})
