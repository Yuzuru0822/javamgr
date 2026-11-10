import { describe, expect, it } from 'vitest'
import { parseLine, parseLogLevel, parseTimestamp } from '../../src/main/log/level-parser'

/** 级别/时间戳解析单测（§2.3-C / S4.4；正则单一来源 src/shared/log-format.ts） */

describe('parseLogLevel', () => {
  it('行首大写独立词优先', () => {
    expect(parseLogLevel('2026-11-09 10:00:00.000 [ERROR] boom')).toBe('ERROR')
    expect(parseLogLevel('  WARN  前导空白容忍')).toBe('WARN')
    expect(parseLogLevel('INFO 直接开头')).toBe('INFO')
  })

  it('行首未命中时行内独立词降级匹配', () => {
    expect(parseLogLevel('2026-11-09 10:00:00.000 some context ERROR then more')).toBe('ERROR')
  })

  it('词边界：ERRORS/WARNING 等不误命中', () => {
    expect(parseLogLevel('error lowercase 不命中')).toBe('UNKNOWN')
    expect(parseLogLevel('2026-11-09 10:00:00.000 [INFO] ERRORS增多')).toBe('INFO') // ERRORS 非独立词，INFO 命中
  })

  it('堆栈续行降级 UNKNOWN', () => {
    expect(parseLogLevel('java.lang.RuntimeException: 余额不足')).toBe('UNKNOWN')
    expect(parseLogLevel('    at com.demo.order.SettlementService.settle(SettlementService.java:88)')).toBe('UNKNOWN')
    expect(parseLogLevel('Caused by: java.io.IOException: timeout')).toBe('UNKNOWN')
  })
})

describe('parseTimestamp', () => {
  it('yyyy-MM-dd HH:mm:ss.SSS（logback 常见布局）', () => {
    const ms = parseTimestamp('2026-11-09 10:00:00.123 [INFO] x')
    expect(ms).toBe(new Date(2026, 10, 9, 10, 0, 0, 123).getTime())
  })

  it('毫秒逗号分隔（logback 默认 ,SSS）与无毫秒', () => {
    expect(parseTimestamp('2026-11-09 10:00:00,456 [INFO] x')).toBe(
      new Date(2026, 10, 9, 10, 0, 0, 456).getTime()
    )
    expect(parseTimestamp('2026-11-09 10:00:00 [INFO] x')).toBe(
      new Date(2026, 10, 9, 10, 0, 0, 0).getTime()
    )
  })

  it('非行首时间戳/无时间戳 → undefined', () => {
    expect(parseTimestamp('java.lang.RuntimeException: 2026-11-09 10:00:00.000')).toBeUndefined()
    expect(parseTimestamp('    at com.demo.Foo.bar(Foo.java:1)')).toBeUndefined()
  })
})

describe('parseLine 组合', () => {
  it('Loggy 行：INFO + 时间戳齐备', () => {
    const line = parseLine('2026-11-09 10:00:00.001 [INFO] 服务运行正常, 已处理 100 个请求', 7)
    expect(line.level).toBe('INFO')
    expect(line.lineNo).toBe(7)
    expect(line.timestamp).toBe(new Date(2026, 10, 9, 10, 0, 0, 1).getTime())
  })

  it('堆栈块：首行 ERROR 有时间戳，续行 UNKNOWN 无时间戳（S-7 检索归属的输入形态）', () => {
    const head = parseLine('2026-11-09 10:00:01.000 [ERROR] 模拟业务异常: 订单结算失败 (order-10086)', 50)
    const cont = parseLine('java.lang.RuntimeException: 余额不足', 51)
    expect(head.level).toBe('ERROR')
    expect(head.timestamp).toBeDefined()
    expect(cont.level).toBe('UNKNOWN')
    expect(cont.timestamp).toBeUndefined()
  })
})
