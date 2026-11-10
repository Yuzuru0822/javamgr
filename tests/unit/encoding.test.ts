import * as iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { DecodedLineFeeder, RunDecoder } from '../../src/main/log/encoding'

/**
 * F3 编码判定算法单测（计划 §2.3-C / S4.1，R2）。
 * 核心场景：GBK 程序首行纯 ASCII banner + 后续中文——banner 不得锁定编码（F3 决议）。
 */

const gbk = (s: string): Buffer => iconv.encode(s, 'gbk')
const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8')

const BANNER = '2026-11-09 10:00:00.001 [INFO] Loggy v1.0 starting: mode=gbk, pid=1234, charset=GBK\n'
const CN_UTF8_LINE = '2026-11-09 10:00:00.002 [INFO] 服务运行正常, 已处理 100 个请求\n'
const CN_GBK_LINE = gbk('2026-11-09 10:00:00.002 [INFO] 服务运行正常, 已处理 100 个请求\n')

describe('RunDecoder：BOM 命中即定', () => {
  it('UTF-8 BOM → 锁定 utf8，BOM 剥离不输出', () => {
    const d = new RunDecoder()
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const out = d.push(Buffer.concat([bom, utf8('hello 中文\n')]))
    expect(d.getEncoding()).toBe('utf8')
    expect(out).toBe('hello 中文\n')
  })

  it('UTF-16LE BOM → 锁定 utf16le', () => {
    const d = new RunDecoder()
    const bom = Buffer.from([0xff, 0xfe])
    const body = Buffer.from('\u670d\u52a1 ok\n', 'utf16le')
    const out = d.push(Buffer.concat([bom, body]))
    expect(d.getEncoding()).toBe('utf16le')
    expect(out).toBe('服务 ok\n')
  })

  it('BOM 撕裂跨 chunk（FF 单字节先到）仍正确判定', () => {
    const d = new RunDecoder()
    expect(d.push(Buffer.from([0xff]))).toBe('')
    const out = d.push(Buffer.concat([Buffer.from([0xfe]), Buffer.from('ab\n', 'utf16le')]))
    expect(d.getEncoding()).toBe('utf16le')
    expect(out).toBe('ab\n')
  })
})

describe('RunDecoder：纯 ASCII 段不判定不缓存（F3 核心）', () => {
  it('纯 ASCII 直接透传且保持未锁定', () => {
    const d = new RunDecoder()
    const text = '2026-11-09 10:00:00.001 [INFO] pure ascii banner line\n'
    const out = d.push(utf8(text))
    expect(out).toBe(text)
    expect(d.isLocked()).toBe(false) // 不判定
  })

  it('ASCII banner 不误锁：GBK 程序首行 banner 后中文出现才锁 GBK（F3 典型场景）', () => {
    const d = new RunDecoder()
    const bannerOut = d.push(utf8(BANNER)) // 整行 ASCII：透传
    expect(bannerOut).toBe(BANNER)
    expect(d.isLocked()).toBe(false) // banner 不触发判定

    const cnOut = d.push(CN_GBK_LINE)
    expect(d.getEncoding()).toBe('gbk') // 首个非 ASCII 完整行锁定 GBK
    expect(cnOut).toBe(
      '2026-11-09 10:00:00.002 [INFO] 服务运行正常, 已处理 100 个请求\n'
    )
  })

  it('同场景 UTF-8：中文行严格 UTF-8 校验通过 → 锁定 utf8', () => {
    const d = new RunDecoder()
    d.push(utf8(BANNER))
    const out = d.push(utf8(CN_UTF8_LINE))
    expect(d.getEncoding()).toBe('utf8')
    expect(out).toBe(CN_UTF8_LINE)
  })

  it('锁定后缓存：后续 chunk 一律按锁定编码转码（GBK run 内 ASCII 行不回检测）', () => {
    const d = new RunDecoder()
    d.push(utf8(BANNER))
    d.push(CN_GBK_LINE) // 锁 GBK
    const later = '2026-11-09 10:00:00.003 [WARN] ascii after lock\n'
    expect(d.push(utf8(later))).toBe(later)
    expect(d.getEncoding()).toBe('gbk')
  })
})

describe('RunDecoder：跨 chunk 撕裂与残行', () => {
  it('非 ASCII 行首到行尾跨 chunk（ASCII 前缀透传，非 ASCII 暂扣至 \\n 到达才锁定）', () => {
    const d = new RunDecoder()
    const full = gbk('2026-11-09 10:00:00.002 [INFO] 服务运行正常\n')
    const cut = full.length - 5 // 中文+换行撕裂
    // 前缀纯 ASCII 段直接透传（F3）；非 ASCII 起暂扣，不锁定
    expect(d.push(full.subarray(0, cut))).toBe('2026-11-09 10:00:00.002 [INFO] ')
    expect(d.isLocked()).toBe(false)
    const out = d.push(full.subarray(cut))
    expect(d.getEncoding()).toBe('gbk')
    expect(out).toBe('服务运行正常\n')
  })

  it('锁定后 UTF-8 多字节字符跨 chunk 撕裂（stream 缓冲补全）', () => {
    const d = new RunDecoder()
    d.push(utf8('x 中文\n')) // 锁 utf8
    const line = utf8('2026-11-09 10:00:00.004 [INFO] 缓冲区使用率 88%\n')
    const cut = line.indexOf(0xe7) // 在中文字符中间撕开
    const part1 = d.push(line.subarray(0, cut))
    const part2 = d.push(line.subarray(cut))
    expect(part1 + part2).toBe('2026-11-09 10:00:00.004 [INFO] 缓冲区使用率 88%\n')
  })

  it('锁定后 GBK 双字节字符跨 chunk 撕裂（iconv 流式解码器缓冲补全）', () => {
    const d = new RunDecoder()
    d.push(gbk('中文首行\n')) // 锁 gbk
    const line = gbk('中文双字节撕裂续行\n')
    const cut = 3 // 双字节字符中间
    const part1 = d.push(line.subarray(0, cut))
    const part2 = d.push(line.subarray(cut))
    expect(part1 + part2).toBe('中文双字节撕裂续行\n')
  })

  it('flush：流结束时未锁定的非 ASCII 残段就地强制判定', () => {
    const d = new RunDecoder()
    d.push(utf8(BANNER))
    // ASCII 前缀透传，中文段无换行暂扣
    expect(d.push(CN_GBK_LINE.subarray(0, CN_GBK_LINE.length - 1))).toBe(
      '2026-11-09 10:00:00.002 [INFO] '
    )
    const tail = d.flush()
    expect(d.getEncoding()).toBe('gbk')
    expect(tail).toContain('服务运行正常')
  })
})

describe('RunDecoder：编码覆盖逃生口', () => {
  it('override gbk：构造即锁定，跳过自动判定', () => {
    const d = new RunDecoder({ encodingOverride: 'gbk' })
    expect(d.getEncoding()).toBe('gbk')
    const out = d.push(gbk('服务运行正常\n'))
    expect(out).toBe('服务运行正常\n')
  })

  it('override utf8：GBK 字节按 utf8 强解（乱码容忍，不抛错不误判流程）', () => {
    const d = new RunDecoder({ encodingOverride: 'utf8' })
    expect(d.getEncoding()).toBe('utf8')
    const out = d.push(gbk('服务运行正常\n'))
    expect(out).not.toBe('') // 有输出（替换字符形式）
    expect(out).not.toContain('服务运行正常') // 不会"碰巧"正确解码
  })
})

describe('DecodedLineFeeder：文本级行切分', () => {
  it('完整行切分 + \\r\\n 剥离 + 残行跨 chunk 缓冲', () => {
    const lines: string[] = []
    const feeder = new DecodedLineFeeder(new RunDecoder(), (ls) => lines.push(...ls))
    feeder.push(utf8('line1\r\nline2\n'))
    expect(lines).toEqual(['line1', 'line2'])
    feeder.push(utf8('partial-without')) // 残行暂存
    expect(lines).toEqual(['line1', 'line2'])
    feeder.push(utf8('-newline\nline4\n'))
    expect(lines).toEqual(['line1', 'line2', 'partial-without-newline', 'line4'])
  })

  it('flush：残行作为最后一行输出（流结束残行 flush 要求）', () => {
    const lines: string[] = []
    const feeder = new DecodedLineFeeder(new RunDecoder(), (ls) => lines.push(...ls))
    feeder.push(utf8('a\ntrailing-partial'))
    feeder.flush()
    expect(lines).toEqual(['a', 'trailing-partial'])
    feeder.flush() // 幂等
    expect(lines).toEqual(['a', 'trailing-partial'])
  })

  it('GBK 数据经 feeder 全链路：字节 chunk → 正确中文行', () => {
    const lines: string[] = []
    const feeder = new DecodedLineFeeder(new RunDecoder(), (ls) => lines.push(...ls))
    feeder.push(utf8('Loggy banner\n'))
    feeder.push(gbk('2026-11-09 10:00:00.005 [INFO] 服务运行正常, 已处理 200 个请求\n'))
    feeder.push(gbk('中文续行无换行'))
    feeder.flush()
    expect(lines).toEqual([
      'Loggy banner',
      '2026-11-09 10:00:00.005 [INFO] 服务运行正常, 已处理 200 个请求',
      '中文续行无换行'
    ])
  })
})
