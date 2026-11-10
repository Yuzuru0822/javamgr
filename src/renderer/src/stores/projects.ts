import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { BatchResult, OpResult, ProjectInput, ProjectWithRuntime } from '@shared/types'
import { ipc, ipcEvents } from '@renderer/api/ipc'

/**
 * 项目列表镜像 + 配置 CRUD + 启停操作（S3 接通真实 IPC）。
 * 实时状态：订阅 proc:statusChanged 镜像主进程 process-manager 权威状态
 * （单一权威状态源在主进程；本 store 只做展示镜像，不做状态推演）。
 */
export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<ProjectWithRuntime[]>([])
  const loaded = ref(false)

  async function refresh(): Promise<void> {
    projects.value = await ipc.projects.list()
    loaded.value = true
  }

  async function create(input: ProjectInput): Promise<void> {
    await ipc.projects.create(input)
    await refresh()
  }

  async function update(input: ProjectInput & { id: string }): Promise<void> {
    await ipc.projects.update(input)
    await refresh()
  }

  async function remove(id: string, confirm: boolean): Promise<void> {
    await ipc.projects.remove(id, confirm)
    await refresh()
  }

  // ---------- 启停操作（操作队列在主进程；此处仅转发结果） ----------

  async function start(id: string): Promise<OpResult> {
    return ipc.projects.start(id)
  }

  async function stop(id: string): Promise<OpResult> {
    return ipc.projects.stop(id)
  }

  async function restart(id: string): Promise<OpResult> {
    return ipc.projects.restart(id)
  }

  async function startAll(): Promise<BatchResult> {
    return ipc.projects.startAll()
  }

  async function stopAll(): Promise<BatchResult> {
    return ipc.projects.stopAll()
  }

  // ---------- proc:statusChanged 事件镜像（App 挂载时绑定一次） ----------

  let unsubscribeStatus: (() => void) | null = null

  function applyStatusEvent(payload: {
    projectId: string
    status: ProjectWithRuntime['status']
    pid?: number
    exitCode?: number
    startTime?: number
    note?: string
  }): void {
    const target = projects.value.find((p) => p.id === payload.projectId)
    if (!target) return
    target.status = payload.status
    target.pid = payload.pid
    target.exitCode = payload.exitCode
    target.startTime = payload.startTime
    target.note = payload.note
    // 事件载荷不含 uptime；RUNNING 态由视图层秒级 tick 派生，这里清空避免陈旧值
    target.uptimeMs =
      payload.status === 'RUNNING' && payload.startTime !== undefined
        ? Date.now() - payload.startTime
        : undefined
  }

  function bindStatusEvents(): void {
    if (unsubscribeStatus) return
    unsubscribeStatus = ipcEvents.statusChanged(applyStatusEvent)
  }

  function unbindStatusEvents(): void {
    unsubscribeStatus?.()
    unsubscribeStatus = null
  }

  return {
    projects,
    loaded,
    refresh,
    create,
    update,
    remove,
    start,
    stop,
    restart,
    startAll,
    stopAll,
    bindStatusEvents,
    unbindStatusEvents
  }
})
