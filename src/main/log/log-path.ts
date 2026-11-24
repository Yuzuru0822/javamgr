/**
 * stdout 日志目录解析与可写验证（零 Electron，主进程启动装配与 settings:set 共用）。
 *
 * 配置保存的是用户选择的父目录；自定义实际根固定为 <stdoutLogDir>/javamgr-logs，
 * 避免把 javamgr 自有日志直接散落到用户目录。空配置才使用 legacy 默认 userData/logs。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const STDOUT_LOG_DIR_NAME = 'javamgr-logs'

/** 规范化待保存的父目录：去首尾空白；空串保留为默认目录语义。 */
export function normalizeStdoutLogParent(stdoutLogDir: string): string {
  const trimmed = stdoutLogDir.trim()
  return trimmed === '' ? '' : path.normalize(trimmed)
}

/**
 * 解析实际 stdout 根目录。非空配置必须是绝对路径且不能是磁盘/文件系统根，
 * 防止误把日志治理范围扩大到整个磁盘；本函数只做路径运算，不触文件系统。
 */
export function resolveStdoutLogDir(stdoutLogDir: string, defaultLogsDir: string): string {
  const parent = normalizeStdoutLogParent(stdoutLogDir)
  if (parent === '') return path.normalize(defaultLogsDir)
  if (!path.isAbsolute(parent)) {
    throw new Error(`stdout 日志父目录必须是绝对路径：${parent}`)
  }
  if (path.parse(parent).root === parent) {
    throw new Error(`stdout 日志父目录不能是磁盘或文件系统根目录：${parent}`)
  }
  return path.join(parent, STDOUT_LOG_DIR_NAME)
}

/**
 * 创建实际根并用独占临时文件验证可写。探针名含 PID + UUID 且以 wx 打开，
 * 只清理本次成功创建的探针，绝不覆盖或删除用户既有文件。
 */
export async function validateStdoutLogDir(logsDir: string): Promise<void> {
  try {
    await mkdir(logsDir, { recursive: true })
  } catch (err) {
    throw new Error(
      `无法创建 stdout 日志目录「${logsDir}」：${err instanceof Error ? err.message : String(err)}`
    )
  }

  const probe = path.join(logsDir, `.javamgr-write-probe-${process.pid}-${randomUUID()}.tmp`)
  let created = false
  let writeError: unknown
  try {
    await writeFile(probe, '', { encoding: 'utf8', flag: 'wx' })
    created = true
  } catch (err) {
    writeError = err
  } finally {
    if (created) {
      try {
        await unlink(probe)
      } catch (err) {
        // 写入已成功但探针无法清理也属于目录不可用，应显式阻止保存/启动写入。
        if (writeError === undefined) writeError = err
      }
    }
  }
  if (writeError !== undefined) {
    throw new Error(
      `stdout 日志目录不可写或无法清理写入探针「${logsDir}」：${
        writeError instanceof Error ? writeError.message : String(writeError)
      }`
    )
  }
}

/** 解析并验证实际根，供设置保存前复检；返回已验证的实际目录。 */
export async function resolveAndValidateStdoutLogDir(
  stdoutLogDir: string,
  defaultLogsDir: string
): Promise<string> {
  const logsDir = resolveStdoutLogDir(stdoutLogDir, defaultLogsDir)
  await validateStdoutLogDir(logsDir)
  return logsDir
}
