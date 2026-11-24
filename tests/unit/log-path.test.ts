import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  normalizeStdoutLogParent,
  resolveAndValidateStdoutLogDir,
  resolveStdoutLogDir,
  STDOUT_LOG_DIR_NAME,
  validateStdoutLogDir
} from '../../src/main/log/log-path'

let baseDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-log-path-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('stdout 日志目录解析', () => {
  it('空配置返回默认 userData/logs，验证时创建实际目录', async () => {
    const defaultLogsDir = path.join(baseDir, 'userData', 'logs')
    expect(resolveStdoutLogDir('', defaultLogsDir)).toBe(path.normalize(defaultLogsDir))
    expect(resolveStdoutLogDir('   ', defaultLogsDir)).toBe(path.normalize(defaultLogsDir))

    await expect(resolveAndValidateStdoutLogDir('', defaultLogsDir)).resolves.toBe(defaultLogsDir)
    expect((await stat(defaultLogsDir)).isDirectory()).toBe(true)
  })

  it('自定义绝对父目录固定追加 javamgr-logs，并规范化待保存值', async () => {
    const parent = path.join(baseDir, 'custom-parent')
    const normalized = normalizeStdoutLogParent(`  ${parent}  `)
    expect(normalized).toBe(path.normalize(parent))
    expect(resolveStdoutLogDir(normalized, path.join(baseDir, 'default-logs'))).toBe(
      path.join(parent, STDOUT_LOG_DIR_NAME)
    )

    await expect(
      resolveAndValidateStdoutLogDir(normalized, path.join(baseDir, 'default-logs'))
    ).resolves.toBe(path.join(parent, STDOUT_LOG_DIR_NAME))
    expect((await stat(path.join(parent, STDOUT_LOG_DIR_NAME))).isDirectory()).toBe(true)
  })

  it('拒绝相对路径与磁盘根目录', () => {
    const defaultLogsDir = path.join(baseDir, 'logs')
    expect(() => resolveStdoutLogDir(path.join('relative', 'logs'), defaultLogsDir)).toThrow(
      /绝对路径/
    )
    const root = path.parse(process.cwd()).root
    expect(() => resolveStdoutLogDir(root, defaultLogsDir)).toThrow(/根目录/)
  })
})

describe('stdout 日志目录写入探针', () => {
  it('验证后清理自己的探针，不删除实际根内既有文件', async () => {
    const logsDir = resolveStdoutLogDir(
      path.join(baseDir, 'parent'),
      path.join(baseDir, 'default-logs')
    )
    await mkdir(logsDir, { recursive: true })
    const sentinel = path.join(logsDir, 'keep-me.txt')
    await writeFile(sentinel, 'user-data', 'utf8')

    await validateStdoutLogDir(logsDir)

    expect(await readFile(sentinel, 'utf8')).toBe('user-data')
    const names = await readdir(logsDir)
    expect(names).toContain('keep-me.txt')
    expect(names.some((name) => name.startsWith('.javamgr-write-probe-'))).toBe(false)
  })
})
