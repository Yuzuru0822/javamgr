import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  JAR_SCAN_MAX_RESULTS,
  managedJarSet,
  normalizeJarPath,
  scanJars,
  suggestProjectName
} from '../../src/main/jar/jar-scanner'

/**
 * jar 扫描器单测（2026-11-10 扫描导入）：真实临时目录递归收集 / 已纳管标注 /
 * 截断上限 / 非目录报错 / 权限目录跳过（Windows chmod 不可靠，该分支按跳过目录
 * 行为间接覆盖）/ suggestProjectName 纯函数。
 */

let baseDir: string

async function touch(rel: string, size = 16): Promise<string> {
  const full = path.join(baseDir, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, Buffer.alloc(size))
  return full
}

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), 'jar-scan-'))
})

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('jar/scanner：递归收集与标注', () => {
  it('递归子目录收集 *.jar（大小写不敏感扩展名），非 jar 文件忽略，按路径排序', async () => {
    const a = await touch('svc/alpha.jar')
    const b = await touch('nested/deep/beta.JAR') // 大写扩展名
    await touch('svc/notes.txt')
    await touch('notajar.jar.bak')

    const result = await scanJars(baseDir, new Set())
    const paths = result.jars.map((j) => j.path)
    expect(paths).toEqual([a, b].sort((x, y) => x.localeCompare(y)))
    expect(result.truncated).toBe(false)
    expect(result.skippedDirs).toEqual([])
  })

  it('alreadyManaged：与纳管 jarPath 集合按规范化（小写）比对命中', async () => {
    const managed = await touch('managed/existing.jar')
    const free = await touch('managed/free.jar')
    // 大小写不敏感：集合存大写路径也应命中实际小写文件
    const set = managedJarSet([managed.toUpperCase()])
    const result = await scanJars(path.join(baseDir, 'managed'), set)
    const byPath = new Map(result.jars.map((j) => [j.path.toLowerCase(), j]))
    expect(byPath.get(normalizeJarPath(managed))?.alreadyManaged).toBe(true)
    expect(byPath.get(normalizeJarPath(free))?.alreadyManaged).toBe(false)
  })

  it('元数据：sizeBytes/mtimeIso/suggestedName（文件名去扩展）填充', async () => {
    await touch('meta/Order-Service.jar', 2048)
    const result = await scanJars(path.join(baseDir, 'meta'), new Set())
    expect(result.jars).toHaveLength(1)
    const entry = result.jars[0]!
    expect(entry.suggestedName).toBe('Order-Service')
    expect(entry.sizeBytes).toBe(2048)
    expect(() => new Date(entry.mtimeIso)).not.toThrow()
  })

  it('命中上限截断（truncated=true，不再深入）', async () => {
    const dir = path.join(baseDir, 'trunc')
    for (let i = 0; i < 5; i++) await touch(`trunc/t${i}.jar`)
    const result = await scanJars(dir, new Set(), { maxResults: 3 })
    expect(result.jars).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('上限值导出存在（防误调）', () => {
    expect(JAR_SCAN_MAX_RESULTS).toBeGreaterThan(0)
  })

  it('根目录不存在 → 抛错；根是文件 → 抛错', async () => {
    await expect(scanJars(path.join(baseDir, 'no-such-dir'), new Set())).rejects.toThrow()
    const file = await touch('plain/file.txt')
    await expect(scanJars(file, new Set())).rejects.toThrow('不是目录')
  })
})

describe('jar/scanner：suggestProjectName 纯函数', () => {
  it('去 .jar 扩展（大小写不敏感）与首尾空白；空 stem 兜底', () => {
    expect(suggestProjectName('order.jar')).toBe('order')
    expect(suggestProjectName('Order.Service.JAR')).toBe('Order.Service')
    expect(suggestProjectName('  spaced.jar  ')).toBe('spaced')
    expect(suggestProjectName('.jar')).toBe('imported-project')
  })
})
