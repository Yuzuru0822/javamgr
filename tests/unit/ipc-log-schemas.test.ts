import { describe, expect, it } from 'vitest'
import { logCleanupSchema, settingsSetSchema } from '../../src/main/ipc/schemas'

describe('settings:set 日志治理 schema', () => {
  it('接受新字段边界值与空 stdoutLogDir', () => {
    expect(
      settingsSetSchema.parse({
        logRetentionDays: 1,
        logMaxTotalMb: 1_048_576,
        stdoutLogDir: ''
      })
    ).toEqual({ logRetentionDays: 1, logMaxTotalMb: 1_048_576, stdoutLogDir: '' })
    expect(settingsSetSchema.parse({ logRetentionDays: 365 }).logRetentionDays).toBe(365)
    expect(settingsSetSchema.parse({ stdoutLogDir: 'x'.repeat(1024) }).stdoutLogDir).toHaveLength(
      1024
    )
  })

  it('拒绝非整数、越界值与超长目录', () => {
    expect(() => settingsSetSchema.parse({ logRetentionDays: 0 })).toThrow()
    expect(() => settingsSetSchema.parse({ logRetentionDays: 366 })).toThrow()
    expect(() => settingsSetSchema.parse({ logRetentionDays: 1.5 })).toThrow()
    expect(() => settingsSetSchema.parse({ logMaxTotalMb: 0 })).toThrow()
    expect(() => settingsSetSchema.parse({ logMaxTotalMb: 1_048_577 })).toThrow()
    expect(() => settingsSetSchema.parse({ stdoutLogDir: 'x'.repeat(1025) })).toThrow()
  })
})

describe('logs:cleanup schema', () => {
  it('缺省为 current 语义，并支持显式 legacyDefault', () => {
    expect(logCleanupSchema.parse({}).scope).toBeUndefined()
    expect(logCleanupSchema.parse({ scope: 'current' }).scope).toBe('current')
    expect(logCleanupSchema.parse({ scope: 'legacyDefault' }).scope).toBe('legacyDefault')
  })

  it('拒绝未知 scope 与未知字段', () => {
    expect(() => logCleanupSchema.parse({ scope: 'all' })).toThrow()
    expect(() => logCleanupSchema.parse({ recursive: true })).toThrow()
  })
})
