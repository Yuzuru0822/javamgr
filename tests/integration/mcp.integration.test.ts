import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ConfigStore } from '../../src/main/config/config-store'
import { resolveAppPaths } from '../../src/main/config/paths'
import { LogManager } from '../../src/main/log/log-manager'
import { McpHost } from '../../src/main/mcp/mcp-host'
import { ProcessManager } from '../../src/main/process/process-manager'
import { createTaskOps } from '../../src/main/process/task-killer'

/**
 * MCP HTTP 通道端到端集成（计划 §3 S5 / §4 A15+A17+A18 的 MCP 侧预演 / §6 R4 演练基础）：
 * 真实服务层（ProcessManager + LogManager 同源接线，与主进程装配一致）+ 夹具 jar +
 * McpHost 随机高位端口（注入避免与开发实例 7777 冲突）+ SDK Client 经 Streamable HTTP 接入：
 * 1. initialize + tools/list 返回 7 工具（A15）；
 * 2. start_project 真起进程 → get_status RUNNING（首条日志驱动）→ search_logs(level=ERROR) 有结果
 *    → read_logs 路由正确 → restart_project → stop_project → tasklist 核对无残留（A17/A18 台词）；
 * 3. 幂等：RUNNING 下二次 start 返回同一 pid；已停项目 stop 幂等 ok（A17）。
 * 前置：本机 D:\java17\jdk-17.0.12（javac/jar/java）；夹具 beforeAll 现场编译。
 */

const run = promisify(execFile)

const JDK_HOME = 'D:\\java17\\jdk-17.0.12'
const FIXTURES_DIR = path.resolve(__dirname, '../../scripts/fixtures')
// 独立构建目录：vitest 并行跑多个集成文件，共用 build/ 会在"一边 java 进程持有 jar、
// 另一边 rm+重编"时撞 Windows 文件锁（"另一个程序正在使用此文件"）
const BUILD_DIR = path.join(FIXTURES_DIR, 'build-mcp')
const JAR_PATH = path.join(BUILD_DIR, 'loggy-mcp.jar')

const taskOps = createTaskOps()

/** 全部经 MCP start_project 拉起过的 java pid（afterAll 兜底 Stop-Process） */
const launchedPids = new Set<number>()

let baseDir: string
let store: ConfigStore
let processManager: ProcessManager
let logManager: LogManager
let mcpHost: McpHost
let mcpPort: number
let client: Client
let projectId: string

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  what: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
    await sleep(200)
  }
}

/** 取空闲高位端口（临听 :0 再释放） */
function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { address: string; port: number }
      probe.close(() => resolve(port))
    })
  })
}

/** MCP tools/call + content[0].text JSON 解析（工具层结构化 JSON 返回契约） */
interface ToolPayload {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

async function callTool(name: string, args: ToolPayload = {}): Promise<{ payload: ToolPayload; isError: boolean }> {
  const raw = (await client.callTool({
    name,
    arguments: args
  })) as CallToolResult & { isError?: boolean }
  const text = raw.content[0]?.type === 'text' ? raw.content[0].text : ''
  return { payload: JSON.parse(text) as ToolPayload, isError: raw.isError === true }
}

beforeAll(async () => {
  // 1) 现场编译夹具（与 process-manager.integration 同流程）
  await rm(BUILD_DIR, { recursive: true, force: true })
  await run(path.join(JDK_HOME, 'bin', 'javac.exe'), [
    '-encoding',
    'UTF-8',
    '-d',
    BUILD_DIR,
    path.join(FIXTURES_DIR, 'Loggy.java')
  ])
  await run(path.join(JDK_HOME, 'bin', 'jar.exe'), [
    '--create',
    '--file',
    JAR_PATH,
    '--main-class',
    'Loggy',
    '-C',
    BUILD_DIR,
    '.'
  ])

  // 2) 真实服务层装配（与 src/main/index.ts 同源接线：S-1 握手 + 终态喂给 log-manager）
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-mcp-it-'))
  const paths = resolveAppPaths(baseDir)
  store = new ConfigStore(paths)
  await store.init()
  await store.addJdk({
    id: 'jdk-it',
    name: 'Temurin 17.0.12',
    homePath: JDK_HOME,
    version: '17.0.12',
    vendor: 'Eclipse Temurin',
    source: 'manual'
  })
  const created = await store.createProject({
    name: 'LoggyDemo',
    jarPath: JAR_PATH,
    jdkId: 'jdk-it',
    jvmArgs: [],
    programArgs: ['--interval=100'], // 快速产日志：ERROR 每 10 行一条（seq%10==7）
    envVars: {}
  })
  projectId = created.id

  logManager = new LogManager({
    store,
    logsDir: paths.logsDir,
    markRunning: (id) => processManager.markRunning(id)
  })
  processManager = new ProcessManager({
    store,
    runsFile: paths.runsFile,
    taskOps,
    broadcaster: (payload) => logManager.handleStatusChanged(payload)
  })
  processManager.setLogHooks({
    onRunStarted: (event) => {
      launchedPids.add(event.pid)
      logManager.handleRunStarted(event)
    }
  })

  // 3) MCP 宿主（真实 7 工具 + 契约端口策略；注入随机高位端口避免与开发实例 7777 冲突）
  mcpPort = await getFreePort()
  mcpHost = new McpHost({
    services: { store, processControl: processManager, logService: logManager },
    portFile: paths.mcpPortFile,
    getPort: () => mcpPort
  })
  const status = await mcpHost.start()
  expect(status.enabled).toBe(true)

  // 4) SDK Client 经 Streamable HTTP 接入（initialize 握手由 connect 完成）
  client = new Client({ name: 'it-agent', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)))
}, 120_000)

afterAll(async () => {
  await client?.close().catch(() => undefined)
  await mcpHost?.stop({ removePortFile: true }).catch(() => undefined)
  await processManager?.prepareForExit().catch(() => undefined)
  // 兜底清理：Stop-Process（TerminateProcess 直达；WMI 病态期 taskkill 单次 61s+ 不可用）
  for (const pid of launchedPids) {
    try {
      await run(
        'powershell',
        ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
        { timeout: 10_000 }
      )
    } catch {
      // 已死则忽略
    }
  }
  if (baseDir) await rmWithRetry(baseDir)
}, 60_000)

/** Windows 下句柄释放有延迟（java 进程刚被杀、日志文件仍被短暂持有）：rm 带重试 */
async function rmWithRetry(target: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch {
      if (i === attempts - 1) return // 清理失败不阻塞收尾
      await sleep(300)
    }
  }
}

describe('integration/mcp：HTTP 通道 7 工具端到端（真实服务层 + 夹具 jar）', () => {
  it('initialize + tools/list：返回 7 工具，serverInfo.name=javamgr（A15）', async () => {
    expect(client.getServerVersion()?.name).toBe('javamgr')
    const result = await client.listTools()
    expect(result.tools.map((t) => t.name).sort()).toEqual(
      [
        'list_projects',
        'get_status',
        'start_project',
        'stop_project',
        'restart_project',
        'read_logs',
        'search_logs'
      ].sort()
    )
  })

  it('A17/A18 台词链：start（前缀解析）→ RUNNING → read_logs(stdout 路由) → search ERROR → restart → stop → 无残留', async () => {
    // start：前缀解析（loggy → LoggyDemo）
    const start = await callTool('start_project', { project: 'loggy' })
    expect(start.isError).toBe(false)
    expect(start.payload).toMatchObject({ ok: true, status: 'STARTING' })
    const pid = start.payload['pid'] as number
    expect(pid).toBeGreaterThan(0)

    // 首条日志驱动 STARTING→RUNNING（Loggy 立即输出 banner）
    const running = await waitFor(async () => {
      const { payload, isError } = await callTool('get_status', { project: 'LoggyDemo' })
      return !isError && payload['status'] === 'RUNNING' ? (payload['pid'] as number) : undefined
    }, 15_000, 'MCP get_status → RUNNING')
    expect(running).toBe(pid)

    // 幂等：RUNNING 下二次 start 返回同一 pid（绝不二次 spawn）
    const again = await callTool('start_project', { project: 'LoggyDemo' })
    expect(again.payload).toMatchObject({ ok: true, pid, status: 'RUNNING' })

    // read_logs：stdout 项目 auto 路由 → source=stdout，Loggy banner 可见
    const logs = await waitFor(async () => {
      const { payload, isError } = await callTool('read_logs', { project: 'loggy', lines: 50 })
      return !isError && (payload['lines'] as string[]).length > 0 ? payload : undefined
    }, 10_000, 'read_logs 返回内容')
    expect(logs['source']).toBe('stdout')
    expect((logs['lines'] as string[]).some((l) => l.includes('Loggy v1.0 starting'))).toBe(true)

    // search_logs level=ERROR：interval=100ms 下 1s 内必有 ERROR 行（seq%10==7）。
    // contextLines=2 语义（§2.3-C）：邻行不受过滤条件约束——结果 = ERROR 命中行 ± 上下文行
    const search = await waitFor(async () => {
      const { payload, isError } = await callTool('search_logs', {
        project: 'loggy',
        level: 'ERROR',
        maxResults: 20,
        contextLines: 2
      })
      return !isError && (payload['matches'] as unknown[]).length > 0 ? payload : undefined
    }, 15_000, 'search_logs ERROR 命中')
    const texts = (search['matches'] as Array<{ text: string }>).map((m) => m.text)
    expect(texts.some((t) => t.includes('[ERROR]'))).toBe(true)
    // 上下文行（非 ERROR）确实并入结果——contextLines 生效的直接证据
    expect(texts.some((t) => !t.includes('[ERROR]'))).toBe(true)

    // read_logs source 显式 file：stdout-only 项目 → isError + 明确原因（路由正确性）
    const fileRoute = await callTool('read_logs', { project: 'loggy', source: 'file', lines: 10 })
    expect(fileRoute.isError).toBe(true)
    expect(fileRoute.payload['error']).toContain('未配置日志文件路径')

    // restart（原子组合）：新 pid ≠ 旧 pid，且重新 RUNNING
    const restart = await callTool('restart_project', { project: 'loggy' })
    expect(restart.isError).toBe(false)
    const newPid = restart.payload['pid'] as number
    expect(newPid).toBeGreaterThan(0)
    expect(newPid).not.toBe(pid)
    await waitFor(async () => {
      const { payload } = await callTool('get_status', { project: 'loggy' })
      return payload['status'] === 'RUNNING' ? true : undefined
    }, 15_000, 'restart 后 RUNNING')

    // stop：树终止 + 幂等
    const stop = await callTool('stop_project', { project: 'loggy' })
    expect(stop.isError).toBe(false)
    expect(stop.payload['ok']).toBe(true)
    const stopAgain = await callTool('stop_project', { project: 'loggy' })
    expect(stopAgain.payload).toMatchObject({ ok: true })

    // tasklist 核对无残留（A3 语义：MCP 侧停止同样杀树）
    for (const p of [pid, newPid]) {
      const dead = await waitFor(
        async () => ((await taskOps.isAlive(p)).alive ? undefined : true),
        5_000,
        `pid ${p} 死亡`
      )
      expect(dead).toBe(true)
    }

    // 终态经 get_status 同源呈现
    const finalStatus = await callTool('get_status', { project: 'loggy' })
    expect(finalStatus.payload['status']).toBe('STOPPED')
  }, 120_000)

  it('list_projects：MCP 与 GUI 同源（真实运行状态拼装）', async () => {
    const { payload } = await callTool('list_projects')
    const entries = payload['projects'] as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: projectId, name: 'LoggyDemo', status: 'STOPPED', jdkName: 'Temurin 17.0.12' })
  })
})
