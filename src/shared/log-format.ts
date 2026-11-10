/**
 * 日志行格式解析（主进程 level-parser/log-search 与渲染进程 LogViewer 过滤共用，
 * 单一来源防行为分叉）。零依赖纯函数。
 */

import type { LogLevel } from './types'

/** 行首（允许前导空白）级别独立词 */
const LEVEL_AT_START = /^\s*(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b/

/** 行内任意位置级别独立词（行首未命中时降级使用） */
const LEVEL_ANYWHERE = /\b(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b/

/** 行首时间戳：yyyy-MM-dd HH:mm:ss(.SSS)?（分隔符空格或 T，毫秒 . 或 ,） */
const TIMESTAMP_AT_START =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\b/

/** 解析日志行级别；未命中降级 UNKNOWN（堆栈续行等） */
export function parseLogLevel(text: string): LogLevel {
  const start = LEVEL_AT_START.exec(text)
  if (start) return start[1] as LogLevel
  const anywhere = LEVEL_ANYWHERE.exec(text)
  if (anywhere) return anywhere[1] as LogLevel
  return 'UNKNOWN'
}

/** 解析行首时间戳（epoch ms，本地时区）；无/非法返回 undefined */
export function parseTimestamp(text: string): number | undefined {
  const m = TIMESTAMP_AT_START.exec(text)
  if (!m) return undefined
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = Number(m[6])
  const millis = m[7] !== undefined ? Number(m[7].padEnd(3, '0')) : 0
  const date = new Date(year, month - 1, day, hour, minute, second, millis)
  const time = date.getTime()
  return Number.isNaN(time) ? undefined : time
}
