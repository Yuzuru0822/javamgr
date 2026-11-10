import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { LogAppendedEvent, LogSource, LogLevel } from '@shared/types'
import { ipcEvents } from '@renderer/api/ipc'

/** 可过滤级别（UNKNOWN 不出现在过滤下拉，无检索意义） */
export type FilterableLevel = Exclude<LogLevel, 'UNKNOWN'>

/**
 * 日志查看 store（计划 §2.2 / §3 S4.7）：
 * - 每项目缓冲镜像（环形上限 5000 行，更早走 logs:readHistory）；
 * - log:appended 订阅按**当前打开项目**过滤（其余项目不入缓冲，控内存）；
 * - 暂停/过滤状态（暂停只冻结视口渲染，数据仍持续入缓冲——恢复可跳最新，A6）。
 *
 * 单一权威状态在主进程 log-manager；本 store 仅做展示镜像。
 */

/** 每项目环形缓冲上限（R7） */
export const LOG_BUFFER_LIMIT = 5000

export const useLogsStore = defineStore('logs', () => {
  // ---------- 状态 ----------
  const activeProjectId = ref<string | null>(null)
  const paused = ref(false)
  const keyword = ref('')
  const levelFilter = ref<FilterableLevel | ''>('')
  /** 最近一次收到的来源（来源徽标 file/stdout） */
  const lastSource = ref<LogSource>('stdout')
  /** 暂停期间是否有新行到达（恢复提示） */
  const hasNewWhilePaused = ref(false)
  /** 当前缓冲行数（响应式镜像；内部数组非响应式防大数组开销） */
  const bufferedCount = ref(0)

  // ---------- 每项目缓冲（Map<string, string[]>，非响应式） ----------
  const buffers = new Map<string, string[]>()

  function bufferOf(projectId: string): string[] {
    let buf = buffers.get(projectId)
    if (!buf) {
      buf = []
      buffers.set(projectId, buf)
    }
    return buf
  }

  /** LogViewer 打开/切换项目时设置；null = 关闭（停止入缓冲） */
  function setActiveProject(projectId: string | null): void {
    activeProjectId.value = projectId
    hasNewWhilePaused.value = false
    if (projectId !== null) {
      const buf = bufferOf(projectId)
      bufferedCount.value = buf.length
    } else {
      bufferedCount.value = 0
    }
  }

  /** 清空某项目缓冲（切换项目重开时释放内存；历史仍可 readHistory 重读） */
  function clearBuffer(projectId: string): void {
    buffers.delete(projectId)
    if (activeProjectId.value === projectId) bufferedCount.value = 0
  }

  /** 缓冲快照（LogViewer 恢复/初始化用；拷贝防外部改写） */
  function snapshot(projectId: string): string[] {
    return [...bufferOf(projectId)]
  }

  // ---------- log:appended 订阅（App 层绑定一次） ----------

  let unsubscribe: (() => void) | null = null

  function applyAppend(payload: LogAppendedEvent): void {
    if (payload.projectId !== activeProjectId.value) return // 按当前打开项目过滤
    lastSource.value = payload.source
    const buf = bufferOf(payload.projectId)
    buf.push(...payload.lines)
    if (buf.length > LOG_BUFFER_LIMIT) buf.splice(0, buf.length - LOG_BUFFER_LIMIT)
    bufferedCount.value = buf.length
    if (paused.value) hasNewWhilePaused.value = true
  }

  function bindEvents(): void {
    if (unsubscribe) return
    unsubscribe = ipcEvents.logAppended(applyAppend)
  }

  function unbindEvents(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return {
    activeProjectId,
    paused,
    keyword,
    levelFilter,
    lastSource,
    hasNewWhilePaused,
    bufferedCount,
    setActiveProject,
    clearBuffer,
    snapshot,
    bindEvents,
    unbindEvents
  }
})
