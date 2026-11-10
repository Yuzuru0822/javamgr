import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { searchLogFiles } from '../../src/main/log/log-search'

/**
 * log-search 单测（§2.3-C / S4.6，R9，S-7）：
 * keyword 大小写不敏感 / level（UNKNOWN 不匹配）/ 时间窗（无时间戳行归属前行，S-7）/
 * 上下文 / maxResults+truncated / 行扫描上限 / 跨轮转文件连续行号。
 */

let baseDir: string

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-search-'))
})

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

async function writeLog(name: string, lines: string[]): Promise<string> {
  const file = path.join(baseDir, name)
  await writeFile(file, lines.join('\n') + '\n', 'utf8')
  return file
}

/** Loggy 风格堆栈块：首行带时间戳 ERROR + 3 行无时间戳续行 */
const STACK_BLOCK = [
  '2026-11-09 10:00:01.000 [ERROR] 模拟业务异常: 订单结算失败 (order-10086)',
  'java.lang.RuntimeException: 余额不足',
  '    at com.demo.order.SettlementService.settle(SettlementService.java:88)',
  '    at com.demo.order.OrderController.submit(OrderController.java:45)'
]

describe('keyword / level 过滤', () => {
  it('keyword 大小写不敏感子串匹配', async () => {
    const file = await writeLog('kw.log', [
      '2026-11-09 10:00:00.000 [INFO] Service OK seq=1',
      '2026-11-09 10:00:01.000 [ERROR] Downstream TIMEOUT no reply',
      '2026-11-09 10:00:02.000 [INFO] Service OK seq=2'
    ])
    const r = await searchLogFiles([file], { keyword: 'timeout' })
    expect(r.matches.map((m) => m.text)).toEqual(['2026-11-09 10:00:01.000 [ERROR] Downstream TIMEOUT no reply'])
    expect(r.truncated).toBe(false)
  })

  it('level 过滤：解析后匹配；UNKNOWN 行（堆栈续行）不匹配 level 查询', async () => {
    const file = await writeLog('level.log', [
      '2026-11-09 10:00:00.000 [INFO] info line',
      '2026-11-09 10:00:01.000 [ERROR] error line',
      ...STACK_BLOCK.slice(1), // 两行纯堆栈续行（UNKNOWN、无 ERROR 词）
      '2026-11-09 10:00:03.000 [WARN] warn line'
    ])
    const r = await searchLogFiles([file], { level: 'ERROR' })
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0]?.text).toContain('[ERROR] error line')
    const w = await searchLogFiles([file], { level: 'WARN' })
    expect(w.matches.map((m) => m.text)).toEqual(['2026-11-09 10:00:03.000 [WARN] warn line'])
  })

  it('无条件防护：不倾倒全量', async () => {
    const file = await writeLog('empty-query.log', ['a', 'b'])
    const r = await searchLogFiles([file], {})
    expect(r.matches).toEqual([])
    expect(r.truncated).toBe(false)
  })
})

describe('时间窗与 S-7（无时间戳行归属其前最近一个有时间戳的行）', () => {
  it('堆栈续行归属其前 ERROR 行时间戳：时间窗不滤掉堆栈行（A7 场景正确性）', async () => {
    const file = await writeLog('s7.log', [
      '2026-11-09 10:00:00.000 [INFO] start',
      ...STACK_BLOCK, // ERROR @10:00:01 + 3 行无时间戳续行
      '2026-11-09 10:30:00.000 [INFO] much later'
    ])
    // 窗口 [10:00:00, 10:00:02]：RuntimeException 行（无时间戳）应归属 10:00:01 而命中
    const r = await searchLogFiles([file], {
      keyword: 'RuntimeException',
      startTime: '2026-11-09T10:00:00',
      endTime: '2026-11-09T10:00:02'
    })
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0]?.text).toContain('RuntimeException')
    expect(r.matches[0]?.timestamp).toBeUndefined() // 行自身无时间戳（归属不伪造）
    // 同一行在窗口外（ endTime 早于其归属时间戳）不命中
    const out = await searchLogFiles([file], {
      keyword: 'RuntimeException',
      startTime: '2026-11-09T10:00:00',
      endTime: '2026-11-09T10:00:00.500'
    })
    expect(out.matches).toHaveLength(0)
  })

  it('首个时间戳之前的行无法归属：时间过滤时不命中', async () => {
    const file = await writeLog('pre-ts.log', ['orphan line no timestamp', '2026-11-09 10:00:00.000 [INFO] x'])
    const r = await searchLogFiles([file], {
      keyword: 'orphan',
      startTime: '2026-11-09T00:00:00',
      endTime: '2026-11-09T23:00:00'
    })
    expect(r.matches).toHaveLength(0)
  })
})

describe('上下文与截断', () => {
  it('contextLines：命中行 ±N 邻行并入结果（按 lineNo 去重排序，邻行不受过滤约束）', async () => {
    const lines: string[] = []
    for (let i = 1; i <= 10; i += 1) lines.push(`2026-11-09 10:00:0${i}.000 [INFO] seq-${i} normal`)
    lines.splice(5, 0, '2026-11-09 10:00:05.500 [ERROR] boom TARGET') // 第 6 行
    const file = await writeLog('ctx.log', lines)
    const r = await searchLogFiles([file], { keyword: 'TARGET', contextLines: 2 })
    expect(r.matches.map((m) => m.lineNo)).toEqual([4, 5, 6, 7, 8])
    expect(r.matches.map((m) => m.lineNo)).toEqual([...r.matches.map((m) => m.lineNo)].sort((a, b) => a - b))
    expect(r.matches.find((m) => m.lineNo === 6)?.text).toContain('boom TARGET')
    // 命中行自身带 ISO timestamp
    expect(r.matches.find((m) => m.lineNo === 6)?.timestamp).toBe(
      new Date(2026, 10, 9, 10, 0, 5, 500).toISOString()
    )
  })

  it('maxResults 截断：命中达上限 → truncated=true；contextLines 不计上限', async () => {
    const lines: string[] = []
    for (let i = 1; i <= 20; i += 1) lines.push(`2026-11-09 10:00:${String(i).padStart(2, '0')}.000 [ERROR] err-${i} FINDME`)
    const file = await writeLog('cap.log', lines)
    const r = await searchLogFiles([file], { keyword: 'FINDME', maxResults: 3 })
    expect(r.matches.filter((m) => m.text.includes('err-'))).toHaveLength(3)
    expect(r.truncated).toBe(true)
    // 精确等于总数时不截断
    const exact = await searchLogFiles([file], { keyword: 'FINDME', maxResults: 20 })
    expect(exact.truncated).toBe(false)
    expect(exact.matches).toHaveLength(20)
  })

  it('行扫描上限（R9，默认 200k）：达上限 → truncated=true', async () => {
    const lines: string[] = []
    for (let i = 1; i <= 600; i += 1) lines.push(`line-${i}`)
    const file = await writeLog('scancap.log', lines)
    const r = await searchLogFiles([file], { keyword: 'line-599', maxScanLines: 100 })
    expect(r.matches).toEqual([]) // 未扫到即止
    expect(r.truncated).toBe(true)
  })
})

describe('跨轮转文件', () => {
  it('多文件扫描：行号跨文件连续，时间戳归属延续', async () => {
    const older = await writeLog('multi.1.log', [
      '2026-11-09 09:00:00.000 [INFO] old-1',
      'java.lang.Exception: OLD-STACK 续行' // 无时间戳，归属 09:00:00
    ])
    const current = await writeLog('multi.log', [
      '2026-11-09 10:00:00.000 [INFO] new-1',
      '2026-11-09 10:00:01.000 [ERROR] new-error FINDME'
    ])
    // 全窗检索：跨文件行号连续（1..4）
    const r = await searchLogFiles([older, current], {
      keyword: 'FINDME',
      contextLines: 1
    })
    expect(r.matches.map((m) => m.lineNo)).toEqual([3, 4])
    expect(r.matches.map((m) => m.text)).toEqual([
      '2026-11-09 10:00:00.000 [INFO] new-1',
      '2026-11-09 10:00:01.000 [ERROR] new-error FINDME'
    ])
    // 时间窗限定在旧文件时段：旧文件无时间戳续行经归属延续命中
    const oldWindow = await searchLogFiles([older, current], {
      keyword: 'OLD-STACK',
      startTime: '2026-11-09T09:00:00',
      endTime: '2026-11-09T09:59:00'
    })
    expect(oldWindow.matches).toHaveLength(1)
    expect(oldWindow.matches[0]?.lineNo).toBe(2)
  })
})
