import type { RunStatus } from '@shared/types'

/**
 * 渲染层展示格式化（卡片视图与列表视图共用，避免两处各抄一份）。
 */

/** 天/时/分/秒 人性化时长（卡片 uptime 与列表运行时间列同源） */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  if (m > 0) return `${m}分${sec}秒`
  return `${sec}秒`
}

/** 状态中文文案（列表视图状态列；卡片视图只有红绿灯无文字） */
export const statusLabels: Record<RunStatus, string> = {
  RUNNING: '运行中',
  STARTING: '启动中',
  STOPPED: '已停止',
  ABNORMAL_EXIT: '异常退出'
}
