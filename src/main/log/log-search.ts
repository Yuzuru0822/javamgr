/**
 * 日志检索（计划 §2.3-C / §3 S4.6，风险 R9，S-7/S-9 决议）。
 *
 * - 条件（AND 组合）：keyword（大小写不敏感子串）/ level（解析后匹配，UNKNOWN 行
 *   不匹配 level 查询）/ [startTime, endTime] ISO 时间窗；
 * - **无时间戳行（堆栈续行等）归属其前最近一个有时间戳的行**（S-7 流式语义），
 *   时间窗过滤不会滤掉堆栈续行；跨文件（轮转）时时间戳归属继续延续；
 * - 扫描范围：调用方给定的文件列表（旧→新，stdout 项目=当前+轮转 run 文件，
 *   file 项目=配置文件+同目录同基名最近 2 个轮转）；
 * - 防卡死：流式逐行 + 行扫描上限（默认 200k）+ maxResults 截断 + truncated 标志；
 * - **每 2000 行 setImmediate 让出 event loop**（S-9），不阻塞主进程 MCP/IPC 响应；
 * - contextLines：命中行 ±N 邻行并入结果（按 lineNo 去重排序；邻行不受过滤条件约束）。
 *
 * 本模块零 electron 依赖。读取按 UTF-8（log-store 产物恒为已解码 UTF-8；
 * logback 文件默认 UTF-8；GBK 文件的 ASCII 关键字/级别/时间戳仍可正确匹配——
 * 已知偏差见 S4 报告）。
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { LogMatch, SearchResult } from '../../shared/types'
import { parseLogLevel, parseTimestamp } from './level-parser'

/** 默认命中上限（§2.6 search_logs maxResults 默认 200） */
export const DEFAULT_MAX_RESULTS = 200

/** 行扫描上限（R9：防大文件卡死主进程） */
export const DEFAULT_MAX_SCAN_LINES = 200_000

/** event loop 让出步长（S-9：每 2000 行 setImmediate 一次） */
const YIELD_EVERY_LINES = 2_000

export interface SearchFileParams {
  keyword?: string
  level?: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'
  startTime?: string
  endTime?: string
  maxResults?: number
  contextLines?: number
  /** 行扫描上限（默认 200k；测试注入小值验证截断） */
  maxScanLines?: number
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * 在给定文件列表（旧→新）中检索。
 * lineNo 为跨文件连续行号（时间序流的全局行号）。
 */
export async function searchLogFiles(files: string[], params: SearchFileParams): Promise<SearchResult> {
  const keyword = params.keyword?.trim().toLowerCase()
  const level = params.level
  const startTime = params.startTime !== undefined ? Date.parse(params.startTime) : undefined
  const endTime = params.endTime !== undefined ? Date.parse(params.endTime) : undefined
  const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS
  const contextLines = params.contextLines ?? 0
  const maxScanLines = params.maxScanLines ?? DEFAULT_MAX_SCAN_LINES

  if (keyword === undefined && level === undefined && startTime === undefined && endTime === undefined) {
    return { matches: [], truncated: false } // 无条件防护：不做全量倾倒
  }
  if (startTime !== undefined && Number.isNaN(startTime)) {
    throw new Error(`startTime 不是合法 ISO 时间：${params.startTime}`)
  }
  if (endTime !== undefined && Number.isNaN(endTime)) {
    throw new Error(`endTime 不是合法 ISO 时间：${params.endTime}`)
  }

  const matchesByLineNo = new Map<number, LogMatch>()
  let hitCount = 0
  let truncated = false
  let lineNo = 0
  let scanned = 0
  /** S-7：最近一个有时间戳行的 epoch ms（跨文件延续） */
  let carriedTimestamp: number | undefined
  /** 命中行的前文环形缓冲（contextLines 上文） */
  const beforeRing: LogMatch[] = []
  /** 上一个命中还差的下文行数 */
  let afterRemaining = 0

  const record = (entry: LogMatch): void => {
    if (!matchesByLineNo.has(entry.lineNo)) matchesByLineNo.set(entry.lineNo, entry)
  }

  outer: for (const file of files) {
    let stream: ReturnType<typeof createReadStream> | undefined
    try {
      stream = createReadStream(file, { encoding: 'utf8' })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      for await (const text of rl) {
        if (scanned >= maxScanLines) {
          truncated = true
          break outer
        }
        scanned += 1
        lineNo += 1

        const ownTimestamp = parseTimestamp(text)
        if (ownTimestamp !== undefined) carriedTimestamp = ownTimestamp
        const effectiveTimestamp = ownTimestamp ?? carriedTimestamp

        const isMatch = testLine(text, { keyword, level, startTime, endTime, effectiveTimestamp })
        if (isMatch) {
          if (hitCount >= maxResults) {
            // 已达上限：当前行是新的命中（说明还有更多）→ 截断退出（上文已收齐）
            truncated = true
            break outer
          }
          hitCount += 1
          record({
            lineNo,
            text,
            ...(ownTimestamp !== undefined ? { timestamp: new Date(ownTimestamp).toISOString() } : {})
          })
          if (contextLines > 0) {
            for (const entry of beforeRing) record(entry) // 命中前的 N 行上文（Map 去重）
            afterRemaining = contextLines
          }
        } else if (afterRemaining > 0) {
          record({ lineNo, text })
          afterRemaining -= 1
        }

        if (contextLines > 0) {
          // 上文环形缓冲：先匹配后入环，保证命中时环内是纯前行（±contextLines 语义）
          beforeRing.push({
            lineNo,
            text,
            ...(ownTimestamp !== undefined ? { timestamp: new Date(ownTimestamp).toISOString() } : {})
          })
          if (beforeRing.length > contextLines) beforeRing.shift()
        }

        if (scanned % YIELD_EVERY_LINES === 0) await yieldToEventLoop()
      }
    } catch {
      // 单文件读取失败（不存在/权限）：跳过继续后续文件
      stream?.destroy()
    }
  }

  return { matches: [...matchesByLineNo.values()].sort((a, b) => a.lineNo - b.lineNo), truncated }
}

interface LineTestContext {
  keyword?: string
  level?: SearchFileParams['level']
  startTime?: number
  endTime?: number
  effectiveTimestamp?: number
}

function testLine(text: string, ctx: LineTestContext): boolean {
  if (ctx.keyword !== undefined && !text.toLowerCase().includes(ctx.keyword)) return false
  if (ctx.level !== undefined && parseLogLevel(text) !== ctx.level) return false
  if (ctx.startTime !== undefined || ctx.endTime !== undefined) {
    if (ctx.effectiveTimestamp === undefined) return false // 无归属时间戳：无法入窗
    if (ctx.startTime !== undefined && ctx.effectiveTimestamp < ctx.startTime) return false
    if (ctx.endTime !== undefined && ctx.effectiveTimestamp > ctx.endTime) return false
  }
  return true
}
