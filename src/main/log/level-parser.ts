/**
 * 日志行级别与行首时间戳解析（计划 §2.3-C / §3 S4.4）。
 *
 * 正则与解析实现在 src/shared/log-format.ts（主进程 log-search 与渲染进程
 * LogViewer 过滤共用同一来源，防行为分叉）；本文件保留 main 侧门面与 LogLine
 * 组合封装。
 *
 * - 级别：`\b(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b`，优先行首大写独立词，
 *   行首未命中再搜行内；均未命中降级 UNKNOWN（堆栈续行等）；
 * - 时间戳：行首 `yyyy-MM-dd HH:mm:ss(.SSS)?`（logback 常见布局，毫秒分隔符
 *   `.` 或 `,` 均支持；也兼容 `T` 分隔与无毫秒），本地时区解析为 epoch ms；
 *   解析失败省略（undefined），无时间戳行在 log-search 中归属其前最近一个
 *   有时间戳的行（S-7）。
 */

import type { LogLine } from '../../shared/types'
import { parseLogLevel, parseTimestamp } from '../../shared/log-format'

export { parseLogLevel, parseTimestamp }

/** 组合解析（log-search / 展示用）；lineNo 由调用方维护 */
export function parseLine(text: string, lineNo: number): LogLine {
  const timestamp = parseTimestamp(text)
  return {
    lineNo,
    text,
    level: parseLogLevel(text),
    ...(timestamp !== undefined ? { timestamp } : {})
  }
}
