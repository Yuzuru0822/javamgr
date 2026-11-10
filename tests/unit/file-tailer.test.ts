import * as iconv from 'iconv-lite'
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileTailer, tailFileLines } from '../../src/main/log/file-tailer'

/**
 * file-tailer 单测（§2.3-C / S4.3，R3/R10）：真实临时目录 + 真实 fs.watch +
 * 短轮询间隔（100ms）加速；waitFor 轮询断言（watch 事件时序不假设）。
 * 场景：初始 tail / 增量跟随 / rename 轮转跟随（A8）/ 截断重建 / 文件后创建 / GBK 解码。
 */

let baseDir: string

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-tailer-'))
})

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(
  probe: () => boolean,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (probe()) return
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
    await sleep(50)
  }
}

interface Harness {
  lines: string[]
  tailer: FileTailer
}

/** 起一个 tailer（短轮询加速），收集行 */
function startTailer(filePath: string, initialLines = 200): Harness {
  const lines: string[] = []
  const tailer = new FileTailer({
    filePath,
    initialLines,
    pollIntervalMs: 100,
    onLines: (ls) => lines.push(...ls)
  })
  void tailer.start()
  return { lines, tailer }
}

describe('初始尾部读取', () => {
  it('预写 300 行 → 初始只回读最后 200 行；末尾残行缓冲待补完', async () => {
    const dir = path.join(baseDir, 'init')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'app.log')
    const all: string[] = []
    for (let i = 1; i <= 300; i += 1) all.push(`line-${i}`)
    // 末行不带换行：起始截取保留最后 200 个换行行 + 残行字节入缓冲
    await writeFile(file, all.join('\n'), 'utf8')

    const h = startTailer(file, 200)
    await waitFor(() => h.lines.length >= 200, 5_000, '初始 tail')
    expect(h.lines[0]).toBe('line-100')
    expect(h.lines.length).toBe(200) // 最后 200 个完整行 = line-100..line-299；line-300 无 \n 在残行缓冲
    expect(h.lines[199]).toBe('line-299')

    // 残行补完：append "\n" + 新行 → line-300 完整输出 + 新行
    await appendFile(file, '\nafter-partial\n')
    await waitFor(() => h.lines.includes('after-partial'), 5_000, '残行补完 + 新增行')
    expect(h.lines[200]).toBe('line-300')
    expect(h.lines[201]).toBe('after-partial')
    await h.tailer.stop()
  })

  it('GBK 文件：经 RunDecoder 正确解码中文', async () => {
    const dir = path.join(baseDir, 'gbk')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'gbk.log')
    await writeFile(file, iconv.encode('2026-11-09 10:00:00.000 [INFO] 服务运行正常\n', 'gbk'))
    const h = startTailer(file, 10)
    await waitFor(() => h.lines.length >= 1, 5_000, 'GBK 初始行')
    expect(h.lines[0]).toBe('2026-11-09 10:00:00.000 [INFO] 服务运行正常')
    await h.tailer.stop()
  })

  it('N-5：初始历史行走 onInitialLines，跟随期新增行才走 onLines', async () => {
    const dir = path.join(baseDir, 'initial-split')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'split.log')
    await writeFile(file, 'hist-1\nhist-2\nhist-3\n', 'utf8')

    const initialLines: string[] = []
    const followLines: string[] = []
    const tailer = new FileTailer({
      filePath: file,
      initialLines: 200,
      pollIntervalMs: 100,
      onLines: (ls) => followLines.push(...ls),
      onInitialLines: (ls) => initialLines.push(...ls)
    })
    await tailer.start()
    // 初始回读同步完成（start() await 返回时 feeder 已推送）
    expect(initialLines).toEqual(['hist-1', 'hist-2', 'hist-3'])
    expect(followLines).toEqual([])

    await appendFile(file, 'new-after-start\n', 'utf8')
    await waitFor(() => followLines.includes('new-after-start'), 5_000, '跟随期新增行')
    expect(followLines).toEqual(['new-after-start'])
    expect(initialLines).toEqual(['hist-1', 'hist-2', 'hist-3']) // 历史不被重复推送
    await tailer.stop()
  })
})

describe('增量跟随与轮转（A8 / R3）', () => {
  it('logback 式 rename 轮转：旧文件移走 → 新文件从 0 跟随，不丢不重', async () => {
    const dir = path.join(baseDir, 'rotate')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'app.log')
    await writeFile(file, 'r1\nr2\nr3\n', 'utf8')

    const h = startTailer(file, 200)
    await waitFor(() => h.lines.length === 3, 5_000, '初始 3 行')

    // 增量
    await appendFile(file, 'r4\n')
    await waitFor(() => h.lines.includes('r4'), 5_000, '增量 r4')

    // 轮转：rename → .1，新建同名文件写新内容（r4 已确认收到后再轮转，避免读/轮转竞态）
    await rename(file, `${file}.1`)
    await writeFile(file, 'fresh-1\nfresh-2\n', 'utf8')
    await waitFor(
      () => h.lines.includes('fresh-1') && h.lines.includes('fresh-2'),
      8_000,
      '轮转后新文件内容'
    )
    // 无重复（误重读旧内容）/ 无丢失
    expect(h.lines.filter((l) => l === 'r1')).toHaveLength(1)
    expect(h.lines.filter((l) => l === 'fresh-1')).toHaveLength(1)
    await h.tailer.stop()
  })

  it('截断/重建（size < offset）：从 0 重读', async () => {
    const dir = path.join(baseDir, 'truncate')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'app.log')
    await writeFile(file, 'a1\na2\na3\na4\na5\n', 'utf8')

    const h = startTailer(file, 200)
    await waitFor(() => h.lines.length === 5, 5_000, '初始 5 行')
    await writeFile(file, 'b1\nb2\n', 'utf8') // 直接覆写变小：size < offset
    await waitFor(() => h.lines.includes('b1') && h.lines.includes('b2'), 8_000, '截断重建从 0 重读')
    expect(h.lines.slice(-2)).toEqual(['b1', 'b2'])
    await h.tailer.stop()
  })

  it('S6.2 日志文件被删：游标重置等待重建，新文件出现后恢复跟随（含 onInitialLines 不触发）', async () => {
    const dir = path.join(baseDir, 'delete-recreate')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'app.log')
    await writeFile(file, 'v1-line-1\nv1-line-2\n', 'utf8')

    const initialLines: string[] = []
    const followLines: string[] = []
    const tailer = new FileTailer({
      filePath: file,
      initialLines: 200,
      pollIntervalMs: 100,
      onLines: (ls) => followLines.push(...ls),
      onInitialLines: (ls) => initialLines.push(...ls)
    })
    await tailer.start()
    expect(initialLines).toEqual(['v1-line-1', 'v1-line-2'])

    // 跟随一段 → 删除文件（外部清理/轮转工具把文件搬走后未立即重建）
    await appendFile(file, 'v1-live-1\n', 'utf8')
    await waitFor(() => followLines.includes('v1-live-1'), 5_000, '删除前跟随')
    await rm(file, { force: true })
    await sleep(300) // 删除事件/轮询吸收（offset 重置为 0）

    // 重建（如日志框架重新创建）→ 从 0 恢复跟随，不丢新内容
    await writeFile(file, 'v2-rebuilt-1\nv2-rebuilt-2\n', 'utf8')
    await waitFor(() => followLines.includes('v2-rebuilt-2'), 5_000, '重建后恢复跟随')
    expect(followLines).toEqual(['v1-live-1', 'v2-rebuilt-1', 'v2-rebuilt-2'])
    await tailer.stop()
  })

  it('文件不存在：watch 目录等待创建，出现后从 0 跟随', async () => {
    const dir = path.join(baseDir, 'create-later')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'later.log')

    const h = startTailer(file, 200)
    await sleep(300) // tailer 启动（文件不存在路径）
    await writeFile(file, 'created-1\ncreated-2\n', 'utf8')
    await waitFor(() => h.lines.includes('created-2'), 8_000, '文件创建后跟随')
    expect(h.lines).toEqual(['created-1', 'created-2'])
    await h.tailer.stop()
  })
})

describe('tailFileLines：独立尾部读取（readHistory file 路用）', () => {
  it('返回最后 N 完整行（含末尾未完行），文件不存在返回空', async () => {
    const dir = path.join(baseDir, 'standalone')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'x.log')
    const lines: string[] = []
    for (let i = 1; i <= 50; i += 1) lines.push(`l-${i}`)
    await writeFile(file, lines.join('\n'), 'utf8') // 无结尾换行
    const tail = await tailFileLines(file, 5)
    expect(tail).toEqual(['l-46', 'l-47', 'l-48', 'l-49', 'l-50'])
    expect(await tailFileLines(path.join(dir, 'missing.log'), 5)).toEqual([])
  })
})
