/**
 * jar 递归扫描器（2026-11-10 扫描导入功能）。
 *
 * 指定根目录 → 递归遍历收集 *.jar（大小写不敏感扩展名匹配）：
 * - 目录读取失败（权限拒绝等）记入 skippedDirs 后继续，不中断整体扫描；
 * - 符号链接目录跳过（防环）；
 * - 命中上限（默认 1000）停止深入并置 truncated=true；
 * - 条目按路径排序保证确定性；
 * - 已纳管标注（alreadyManaged）：与传入的纳管 jarPath 集合按规范化（resolve + 小写）
 *   比对——与 GUI 勾选互斥、MCP batch_create_projects 默认跳过同一权威口径。
 *
 * 本模块零 electron 依赖（纯 node:fs/promises），vitest 纯 Node 环境可完整测试；
 * 与 jdk-scanner 同款纪律：扫描与落库分离（调用方决定入库/创建项目）。
 */

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { JarScanEntry, JarScanResult } from '../../shared/types'

/** 单次扫描命中上限（防误扫系统盘级目录拖垮主进程） */
export const JAR_SCAN_MAX_RESULTS = 1000

/** 路径规范化（比对口径）：resolve + 小写（Windows 大小写不敏感文件系统） */
export function normalizeJarPath(p: string): string {
  return path.resolve(p).toLowerCase()
}

/** 从现有项目列表提取纳管 jar 集合（alreadyManaged 标注与去重的单一权威口径） */
export function managedJarSet(jarPaths: string[]): Set<string> {
  return new Set(jarPaths.map(normalizeJarPath))
}

export interface ScanJarsOptions {
  maxResults?: number
}

/**
 * 递归扫描目录下的 *.jar。目录不存在 / 不是目录 → 抛错（调用方转结构化错误）。
 */
export async function scanJars(
  rootDir: string,
  managed: ReadonlySet<string>,
  opts?: ScanJarsOptions
): Promise<JarScanResult> {
  const max = opts?.maxResults ?? JAR_SCAN_MAX_RESULTS
  const rootStat = await stat(rootDir)
  if (!rootStat.isDirectory()) {
    throw new Error(`扫描路径不是目录：${rootDir}`)
  }

  const jars: JarScanEntry[] = []
  const skippedDirs: string[] = []
  let truncated = false
  const queue: string[] = [path.resolve(rootDir)]

  while (queue.length > 0) {
    if (jars.length >= max) {
      truncated = true
      break
    }
    const dir = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      skippedDirs.push(dir) // 权限拒绝等：跳过该目录，继续其余
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jar')) {
        if (jars.length >= max) {
          truncated = true
          break
        }
        let sizeBytes = 0
        let mtime = new Date()
        try {
          const s = await stat(full)
          sizeBytes = s.size
          mtime = s.mtime
        } catch {
          // stat 失败（竞争删除等）：仍收录该条目，元数据降级为 0/now
        }
        jars.push({
          path: full,
          suggestedName: suggestProjectName(entry.name),
          sizeBytes,
          mtimeIso: mtime.toISOString(),
          alreadyManaged: managed.has(normalizeJarPath(full))
        })
      }
      // 符号链接（目录/文件）不跟随：dirent.isFile/isDirectory 对 symlink 均为 false
    }
  }

  jars.sort((a, b) => a.path.localeCompare(b.path))
  return { jars, truncated, skippedDirs }
}

/** 文件名 → 建议项目名：去 .jar 扩展（大小写不敏感）与首尾空白；空 stem 兜底（如 ".jar"） */
export function suggestProjectName(fileName: string): string {
  const stem = fileName.trim().replace(/\.jar$/i, '').trim()
  return stem !== '' ? stem : 'imported-project'
}
