import type { ProjectWithRuntime, RunStatus } from '@shared/types'

/**
 * 项目列表排序（v0.6.0）：卡片视图与列表视图共用同一排序语义。
 * 纯函数零组件依赖；视图层持有 sortKey/sortOrder 状态（localStorage 持久化）。
 */

export type ProjectSortKey = 'default' | 'name' | 'status' | 'uptime' | 'pid'
export type ProjectSortOrder = 'asc' | 'desc'

/** 允许的排序字段（'default' = 不排序，保持 projects:list 返回的配置顺序） */
export const SORT_KEYS: readonly ProjectSortKey[] = ['default', 'name', 'status', 'uptime', 'pid']

export function isSortKey(value: unknown): value is ProjectSortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value)
}

/**
 * 状态语义序（非字典序）：运行中 → 启动中 → 异常退出 → 已停止。
 * 升序 = 运行中的排最前；desc 反转。
 */
const STATUS_RANK: Record<RunStatus, number> = {
  RUNNING: 0,
  STARTING: 1,
  ABNORMAL_EXIT: 2,
  STOPPED: 3
}

/** 运行时长（ms）；仅 RUNNING 且有 startTime 才有值，其余视为"无运行时间" */
export function uptimeMsOf(project: ProjectWithRuntime, now: number): number | undefined {
  if (project.status !== 'RUNNING' || project.startTime === undefined) return undefined
  return Math.max(0, now - project.startTime)
}

/**
 * 数值比较 + 缺失项处理：缺失值（未运行无 uptime / 无 pid）恒排最后，
 * 不随升降序翻转；有值部分按 dir 定向。
 */
function compareNumericWithMissing(
  a: number | undefined,
  b: number | undefined,
  dir: 1 | -1
): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return (a - b) * dir
}

/**
 * 返回排序后的新数组（不修改入参）。
 * 同主键相等时按 id 兜底，保证跨刷新顺序确定。
 */
export function sortProjects(
  projects: ProjectWithRuntime[],
  key: ProjectSortKey,
  order: ProjectSortOrder,
  now: number
): ProjectWithRuntime[] {
  const list = [...projects]
  if (key === 'default') return list

  const dir = order === 'desc' ? -1 : 1
  const byField = (a: ProjectWithRuntime, b: ProjectWithRuntime): number => {
    switch (key) {
      case 'name':
        return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }) * dir
      case 'status':
        return (STATUS_RANK[a.status] - STATUS_RANK[b.status]) * dir
      case 'uptime':
        return compareNumericWithMissing(uptimeMsOf(a, now), uptimeMsOf(b, now), dir)
      case 'pid':
        return compareNumericWithMissing(a.pid, b.pid, dir)
      default:
        return 0
    }
  }

  list.sort((a, b) => {
    const primary = byField(a, b)
    if (primary !== 0) return primary
    // 主键相等（含双方同为缺失值）时按 id 兜底，避免顺序抖动
    return a.id.localeCompare(b.id)
  })
  return list
}
