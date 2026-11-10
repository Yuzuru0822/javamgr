import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PortChangedEvent } from '../../src/shared/types'
import { McpHost } from '../../src/main/mcp/mcp-host'
import type { McpHostOptions } from '../../src/main/mcp/mcp-host'
import type { McpToolServices } from '../../src/main/mcp/tools'
import { probeJavamgrServer } from '../../src/main/mcp/port-probe'
import type { CommandRunner } from '../../src/main/process/task-killer'

/**
 * mcp-host 单测（计划 §2.3-E 端口策略 Z-1 / §3 S5.2，R4/A15 端口冲突分支）：
 * - 正常绑定：仅 127.0.0.1、mcp.port 落盘、真实 HTTP initialize 命中 serverInfo.name="javamgr"；
 * - 外部占用：显式报错（含占用进程名）+ bind-failed 广播 + 绝不递增漂移；
 * - 残留实例（serverInfo.name=java mgr）：杀掉后重试绑定自愈成功 / 终止失败显式报错；
 * - 重启语义（start 再入 = 停旧绑新）与 stop({removePortFile})。
 * 占用者用真实 http server 模拟；netstat/tasklist/taskkill 经 fake CommandRunner（不碰真进程）。
 */

// ---------- 基建 ----------

const services: McpToolServices = {
  store: {
    listProjects: () => [],
    listJdks: () => [],
    createProject: async (input) => ({ id: 'no-op', ...input }),
    updateProject: async (input) => ({ ...input }),
    deleteProject: async (input) => ({
      id: input,
      name: 'no-op',
      jarPath: 'noop.jar',
      jdkId: 'jdk-noop',
      jvmArgs: [],
      programArgs: [],
      envVars: {}
    })
  },
  processControl: {
    getRuntimeState: () => undefined,
    startProject: async () => ({ ok: false, error: 'no-op' }),
    stopProject: async () => ({ ok: true, durationMs: 0 }),
    restartProject: async () => ({ ok: false, error: 'no-op' }),
    startAllProjects: async () => ({ results: [] }),
    stopAllProjects: async () => ({ results: [] })
  },
  logService: {
    readHistory: async () => ({ source: 'stdout', lines: [] }),
    search: async () => ({ matches: [], truncated: false }),
    switchRoute: () => {}
  },
  jarScanner: {
    scanJars: async () => ({ jars: [], truncated: false, skippedDirs: [] })
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
}

function closeHttp(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

/** 取一个空闲高位端口（临听 :0 再释放；测试内注入避免与开发实例 7777 冲突） */
async function getFreePort(): Promise<number> {
  return await new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { address: string; port: number }
      probe.close(() => resolve(port))
    })
  })
}

/** 模拟"占用端口的对端"：POST /mcp 返回指定 serverInfo.name 的 initialize 响应 */
function startDummyMcpLike(port: number, serverName: string): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && (req.url ?? '').split('?')[0] === '/mcp') {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString()))
      req.on('end', () => {
        void body
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: serverName, version: '0.1.0' }
            }
          })
        )
      })
      return
    }
    res.writeHead(404).end()
  })
  return listen(server, port).then(() => server)
}

/** fake CommandRunner：netstat/tasklist 返回受控输出，记录 taskkill 调用 */
function fakeRunner(netstatLines: string, tasklistLine: string): CommandRunner & { commands: Array<{ file: string; args: string[] }> } {
  const commands: Array<{ file: string; args: string[] }> = []
  return {
    commands,
    async run(file, args) {
      commands.push({ file, args: [...args] })
      if (file === 'netstat') {
        return { code: 0, stdout: netstatLines, stderr: '', timedOut: false }
      }
      if (file === 'tasklist') {
        return { code: 0, stdout: tasklistLine, stderr: '', timedOut: false }
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false } // taskkill 等按成功处理
    }
  }
}

const netstatOf = (port: number, pid: number): string =>
  `  TCP    127.0.0.1:${port}     0.0.0.0:0              LISTENING       ${pid}\r\n` +
  `  TCP    127.0.0.1:445         0.0.0.0:0              LISTENING       4\r\n`

const tasklistOf = (image: string, pid: number): string =>
  `"${image}","${pid}","Console","1","5,120 K"\r\n`

let tempDir: string
let portFile: string

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'mcp-host-unit-'))
  portFile = path.join(tempDir, 'mcp.port')
})

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

function makeHost(
  opts: Partial<McpHostOptions> & { getPort: () => number }
): { host: McpHost; events: PortChangedEvent[] } {
  const events: PortChangedEvent[] = []
  const host = new McpHost({
    services,
    portFile,
    onPortChanged: (payload) => events.push(payload),
    ...opts
  })
  return { host, events }
}

// ---------- 正常绑定 ----------

describe('mcp-host：正常绑定（127.0.0.1 + mcp.port 落盘 + javamgr 握手）', () => {
  it('start() → enabled，url 派生，mcp.port 写入实际端口，真实 initialize 探测命中', async () => {
    const port = await getFreePort()
    const { host } = makeHost({ getPort: () => port })

    const status = await host.start()
    try {
      expect(status).toMatchObject({ enabled: true, port, url: `http://127.0.0.1:${port}/mcp` })
      expect((await readFile(portFile, 'utf8')).trim()).toBe(String(port))

      // 真实探测（不注入）：验证 server 装配 + stateless HTTP 通路（serverInfo.name=javamgr）
      const probe = await probeJavamgrServer(port, 3_000)
      expect(probe).toMatchObject({ ok: true, serverName: 'javamgr' })
    } finally {
      await host.stop()
    }
    // stop 后端口释放、状态复位（mcp.port 文件默认保留）
    expect(host.getMcpStatus()).toEqual({ enabled: false })
    expect((await readFile(portFile, 'utf8')).trim()).toBe(String(port))
  })

  it('start() 重入 = 重启：改端口后重新绑定并更新 mcp.port', async () => {
    const portA = await getFreePort()
    const portB = await getFreePort()
    let current = portA
    const { host } = makeHost({ getPort: () => current })

    await host.start()
    expect(host.getMcpStatus().port).toBe(portA)
    try {
      current = portB
      const status = await host.start()
      expect(status).toMatchObject({ enabled: true, port: portB })
      expect((await readFile(portFile, 'utf8')).trim()).toBe(String(portB))
      // 旧端口已释放（探测不再命中）
      expect((await probeJavamgrServer(portA, 1_000)).ok).toBe(false)
    } finally {
      await host.stop({ removePortFile: true })
    }
    await expect(readFile(portFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('非 POST /mcp 与未知路径分别 405/404（stateless 官方语义）', async () => {
    const port = await getFreePort()
    const { host } = makeHost({ getPort: () => port })
    await host.start()
    try {
      const getRes = await fetch(`http://127.0.0.1:${port}/mcp`)
      expect(getRes.status).toBe(405)
      const notFound = await fetch(`http://127.0.0.1:${port}/other`)
      expect(notFound.status).toBe(404)
    } finally {
      await host.stop()
    }
  })
})

// ---------- Z-1 端口策略 ----------

describe('mcp-host：Z-1 外部进程占用 → 显式报错，绝不递增漂移', () => {
  it('占用进程名进入错误与 bind-failed 广播；状态失败但无异常抛出', async () => {
    const port = await getFreePort()
    const occupant = await startDummyMcpLike(port, 'someone-else-mcp') // 非 javamgr → 视为外部
    try {
      const runner = fakeRunner(netstatOf(port, 4321), tasklistOf('other.exe', 4321))
      const { host, events } = makeHost({
        getPort: () => port,
        runner
      })

      const status = await host.start()
      expect(status.enabled).toBe(false)
      expect(status.port).toBe(port) // 不漂移：状态锚定契约端口
      expect(status.occupantName).toBe('other.exe')
      expect(status.error).toContain(String(port))
      expect(status.error).toContain('other.exe')
      expect(status.error).toContain('pid=4321')
      expect(events).toEqual([
        { port, reason: 'bind-failed', occupantName: 'other.exe' }
      ])
      expect(runner.commands.some((c) => c.file === 'taskkill')).toBe(false) // 外部占用绝不擅杀
    } finally {
      await closeHttp(occupant)
    }
  })

  it('真实探测对非 javamgr 响应返回 ok=false（N-1 防误连）', async () => {
    const port = await getFreePort()
    const occupant = await startDummyMcpLike(port, 'someone-else-mcp')
    try {
      const probe = await probeJavamgrServer(port, 2_000)
      expect(probe.ok).toBe(false)
      expect(probe.serverName).toBe('someone-else-mcp')
    } finally {
      await closeHttp(occupant)
    }
  })
})

describe('mcp-host：Z-1 残留实例自愈（serverInfo.name=javamgr 的占用者）', () => {
  it('真实探测命中 javamgr → 杀掉占用者 → 重试绑定成功（真实端口释放）', async () => {
    const port = await getFreePort()
    const leftover = await startDummyMcpLike(port, 'javamgr')
    try {
      const runner = fakeRunner(netstatOf(port, 9999), tasklistOf('javamgr.exe', 9999))
      let killCount = 0
      const { host } = makeHost({
        getPort: () => port,
        runner, // 真实探测（不注入 probe）：dummy 响应 javamgr → 走自愈分支
        killOccupant: async (pid) => {
          killCount++
          expect(pid).toBe(9999)
          await closeHttp(leftover) // 真实释放端口
          return true
        }
      })

      const status = await host.start()
      expect(status).toMatchObject({ enabled: true, port })
      expect(killCount).toBe(1)
      expect((await readFile(portFile, 'utf8')).trim()).toBe(String(port))
      await host.stop()
    } finally {
      await closeHttp(leftover).catch(() => undefined)
    }
  })

  it('自愈失败（残留实例终止不掉）→ 显式报错 + bind-failed 广播，不漂移', async () => {
    const port = await getFreePort()
    const leftover = await startDummyMcpLike(port, 'javamgr')
    try {
      const runner = fakeRunner(netstatOf(port, 777), tasklistOf('javamgr.exe', 777))
      const { host, events } = makeHost({
        getPort: () => port,
        runner,
        killOccupant: async () => false // taskkill 失败
      })

      const status = await host.start()
      expect(status.enabled).toBe(false)
      expect(status.error).toContain('残留实例')
      expect(status.error).toContain('pid=777')
      expect(events).toEqual([
        { port, reason: 'bind-failed', occupantName: expect.stringContaining('残留') }
      ])
    } finally {
      await closeHttp(leftover)
    }
  })
})
