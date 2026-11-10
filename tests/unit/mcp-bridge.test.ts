import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { McpHost } from '../../src/main/mcp/mcp-host'
import { BridgeDiscoveryError, runBridge } from '../../src/main/mcp/run-bridge'
import type { McpToolServices } from '../../src/main/mcp/tools'

/**
 * stdio 桥接函数级单测（计划 §2.3-E / §3 S5.3，A16 的发现链与转发核心，
 * 按 S5 任务书降级方案：注入 stdin/stdout 流 + 真实 HTTP 主实例，不起 GUI 主进程）：
 * - 发现链：mcp.port 文件优先命中（真实 initialize 校验 serverInfo.name="javamgr"）；
 * - stdio 握手 + tools/list 转发（Agent ↔ 主实例完整 JSON-RPC 双向流通用 pipe，非方法白名单）；
 * - 失败链：mcp.port 失联 + 递增探测全空 → BridgeDiscoveryError（stderr 明确报错、不挂起）。
 */

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

let tempDir: string
let host: McpHost | undefined
let hostPort: number
let portFile: string

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'mcp-bridge-unit-'))
  portFile = path.join(tempDir, 'mcp.port')
})

afterAll(async () => {
  await host?.stop({ removePortFile: true }).catch(() => undefined)
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

/** 解析 stdio 输出流中累计的 JSON-RPC 消息（按行分隔） */
function messagesFrom(stdout: PassThrough): JSONRPCMessage[] {
  const text = stdout.read()?.toString() ?? ''
  const messages: JSONRPCMessage[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      messages.push(JSON.parse(trimmed) as JSONRPCMessage)
    } catch {
      // 半行（流式写入中）：忽略
    }
  }
  return messages
}

/** 等待输出流中出现满足条件的消息 */
async function waitForMessage(
  stdout: PassThrough,
  predicate: (m: JSONRPCMessage) => boolean,
  timeoutMs: number,
  what: string
): Promise<JSONRPCMessage> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = messagesFrom(stdout).find(predicate)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** 取一个空闲高位端口（临听 :0 再释放；测试内注入避免与开发实例 7777 冲突） */
function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { address: string; port: number }
      probe.close(() => resolve(port))
    })
  })
}

describe('mcp-bridge：mcp.port 命中 + stdio↔HTTP 双向转发（S-5 消息级 pipe）', () => {
  it('主实例在随机高位端口：发现 → initialize/tools/list/tools/call 全程经桥接转发', async () => {
    // 起真实主实例（McpHost，随机高位端口），mcp.port 指向它
    const freePort = await getFreePort()
    hostPort = freePort
    host = new McpHost({ services, portFile, getPort: () => hostPort })
    const status = await host.start()
    expect(status.enabled).toBe(true)

    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const logs: string[] = []
    const bridgeDone = runBridge({
      portFile, // ① mcp.port 文件优先（真实 initialize 校验）
      stdin,
      stdout,
      log: (msg) => logs.push(msg)
    })
    // 桥接不应自行结束；结束时（stdin 关闭）promise resolve
    // 连接完成判定改为轮询等待（固定 200ms 在并行测试负载下偶发不够）
    const connectDeadline = Date.now() + 5_000
    while (!logs.some((l) => l.includes('已连接主实例')) && Date.now() < connectDeadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(logs.some((l) => l.includes('已连接主实例'))).toBe(true)

    // Agent 侧 stdio：initialize 握手（桥接转发到主实例，响应原路带回）
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'bridge-unit-agent', version: '1.0' }
        }
      })}\n`
    )
    const initResponse = await waitForMessage(
      stdout,
      (m) => 'id' in m && m.id === 1,
      5_000,
      'initialize 响应'
    )
    expect((initResponse as { result?: { serverInfo?: { name?: string } } }).result?.serverInfo?.name).toBe('javamgr')

    // initialized notification 也走同一管道（非方法白名单：notification 直通）
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    // tools/list 转发
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    const toolsResponse = (await waitForMessage(
      stdout,
      (m) => 'id' in m && m.id === 2,
      5_000,
      'tools/list 响应'
    )) as unknown as { result?: { tools?: Array<{ name: string }> } }
    expect((toolsResponse.result?.tools ?? []).map((t) => t.name)).toEqual(
      expect.arrayContaining(['list_projects', 'get_status', 'start_project', 'stop_project', 'restart_project', 'read_logs', 'search_logs'])
    )

    // tools/call 转发（list_projects：空项目列表经真实服务层返回）
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_projects', arguments: {} }
      })}\n`
    )
    const callResponse = (await waitForMessage(
      stdout,
      (m) => 'id' in m && m.id === 3,
      5_000,
      'tools/call 响应'
    )) as unknown as { result?: { content?: Array<{ type: string; text: string }> } }
    const payload = JSON.parse(callResponse.result?.content?.[0]?.text ?? '{}') as {
      projects?: unknown[]
    }
    expect(payload.projects).toEqual([])

    // 关闭 stdin → 桥接收尾（不挂起）
    stdin.end()
    await expect(bridgeDone).resolves.toBeUndefined()
  }, 20_000)

  it('mcp.port 指向失联端口 + 递增探测范围内无主实例 → BridgeDiscoveryError（非零退出语义）', async () => {
    // 用一个确定空闲的高位端口做"失联的 mcp.port 指向"，并把递增探测范围缩到同一空闲端口
    const deadPort = await getFreePort()
    await writeFile(path.join(tempDir, 'mcp.port'), `${deadPort}\n`, 'utf8')

    // 注意：上一用例主实例已停（afterAll 前 host 仍在运行！——此处探测范围避开其端口）
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    // 只探测 deadPort（探测范围注入 = [deadPort, deadPort]，不碰机器上的 7777-7786）
    const bridge = runBridge({ portFile, probeFrom: deadPort, probeTo: deadPort, stdin, stdout })
    await expect(bridge).rejects.toBeInstanceOf(BridgeDiscoveryError)
    await expect(bridge).rejects.toThrow(/主程序未运行|不可达/)
    // 失败必须即时（不挂起）：2s 内已返回（本断言本身即超时保护，rejects 等待默认 1s）
    stdin.end()
  }, 10_000)
})
