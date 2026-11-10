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
 * 7 项目并发冒烟（计划 §3 S6.4 / §4 A19「综合替代 CMD」验收）：
 * 用夹具 jar 起 7 个纳管项目 → 全部启动 → 全部 RUNNING → 期间 MCP list_projects /
 * get_status 全程可用（主进程不因日志/进程负载阻塞，§7 分叉 1 主进程集中处理的
 * 量级验证）→ 全部停止 → tasklist 核对 java.exe 全灭。
 *
 * 7 个项目混布两种日志路由（stdout 捕获 ×4 + 文件 tail ×3）以同时加载两条日志链路。
 * 前置：本机 D:\java17\jdk-17.0.12（javac/jar）；夹具现场编译到独立目录（并行集成
 * 文件共用 scripts/fixtures/build* 会在 Windows 上撞文件锁）。
 */

const run = promisify(execFile)

const JDK_HOME = 'D:\\java17\\jdk-17.0.12'
const FIXTURES_DIR = path.resolve(__dirname, '../../scripts/fixtures')
const BUILD_DIR = path.join(FIXTURES_DIR, 'build-smoke7')
const JAR_PATH = path.join(BUILD_DIR, 'loggy-smoke7.jar')

const PROJECT_COUNT = 7
/** stdout 捕获路由的项目数；其余走文件 tail（log=… 触发 FileTailer 路由） */
const STDOUT_PROJECTS = 4

const taskOps = createTaskOps()

/** 全部经 startAll 拉起过的 java pid（afterAll 兜底 Stop-Process） */
const launchedPids = new Set<number>()

let baseDir: string
let store: ConfigStore
let processManager: ProcessManager
let logManager: LogManager
let mcpHost: McpHost
let mcpPort: number
let client: Client
let projectIds: string[] = []

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

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { address: string; port: number }
      probe.close(() => resolve(port))
    })
  })
}

async function callTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ payload: Record<string, any>; isError: boolean }> {
  const raw = (await client.callTool({ name, arguments: args })) as CallToolResult & {
    isError?: boolean
  }
  const text = raw.content[0]?.type === 'text' ? raw.content[0].text : ''
  return { payload: JSON.parse(text), isError: raw.isError === true }
}

beforeAll(async () => {
  // 1) 现场编译夹具（独立构建目录，防并行集成文件互撞）
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

  // 2) 真实服务层装配（与 src/main/index.ts 同源接线）
  baseDir = await mkdtemp(path.join(tmpdir(), 'jpm-smoke7-'))
  const paths = resolveAppPaths(baseDir)
  store = new ConfigStore(paths)
  await store.init()
  await store.addJdk({
    id: 'jdk-smoke',
    name: 'Temurin 17.0.12',
    homePath: JDK_HOME,
    version: '17.0.12',
    vendor: 'Eclipse Temurin',
    source: 'manual'
  })

  // 3) 7 个纳管项目：前 STDOUT_PROJECTS 个走 stdout 捕获，其余配置 logFilePath 走文件 tail。
  //    jvmArgs 限堆 64m：夹具 JVM 默认堆（约 ¼ 物理内存）在 7 个并发启动时可能超出
  //    系统提交内存上限（os::commit_memory errno=1455"页面文件太小"→ JVM 启动即崩）
  for (let i = 1; i <= PROJECT_COUNT; i += 1) {
    const useFile = i > STDOUT_PROJECTS
    const logFilePath = useFile ? path.join(baseDir, 'filelogs', `p${i}.log`) : undefined
    const created = await store.createProject({
      name: `SmokeApp-${i}`,
      jarPath: JAR_PATH,
      jdkId: 'jdk-smoke',
      jvmArgs: ['-Xmx64m'],
      programArgs: useFile
        ? ['--interval=200', `--log=${logFilePath}`]
        : ['--interval=200'],
      envVars: {},
      ...(logFilePath !== undefined ? { logFilePath } : {})
    })
    projectIds.push(created.id)
  }

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

  // 4) MCP 宿主随机高位端口（避免与开发实例 7777 冲突）+ SDK Client 接入
  mcpPort = await getFreePort()
  mcpHost = new McpHost({
    services: { store, processControl: processManager, logService: logManager },
    portFile: paths.mcpPortFile,
    getPort: () => mcpPort
  })
  const status = await mcpHost.start()
  expect(status.enabled).toBe(true)
  client = new Client({ name: 'smoke7-agent', version: '1.0.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)))
}, 120_000)

afterAll(async () => {
  await client?.close().catch(() => undefined)
  await mcpHost?.stop({ removePortFile: true }).catch(() => undefined)
  await processManager?.prepareForExit().catch(() => undefined)
  // 兜底清理：Stop-Process 直达（WMI 病态期 taskkill 单次 61s+ 不可用，不再先试 taskkill；
  // 树终止已由产品停止路径完成，此处只兜底主 pid），绝不在测试机器留孤儿进程
  for (const pid of launchedPids) {
    try {
      await run(
        'powershell',
        ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
        { timeout: 10_000 }
      ).catch(() => undefined)
    } catch {
      // 兜底失败：已死则无妨
    }
  }
  if (baseDir) {
    for (let i = 0; i < 5; i += 1) {
      try {
        await rm(baseDir, { recursive: true, force: true })
        break
      } catch {
        await sleep(300) // Windows 句柄释放延迟
      }
    }
  }
}, 120_000)

describe('integration/smoke-7projects：7 项目并发冒烟（A19）', () => {
  it('全部启动 → 全部 RUNNING → 期间 MCP 全程可用 → 全部停止 → java.exe 全灭', async () => {
    // 1) 批量启动（startAll：每项目入队一次、错峰 500ms、单项失败不中断）
    const startAll = await processManager.startAllProjects()
    expect(startAll.results).toHaveLength(PROJECT_COUNT)
    for (const r of startAll.results) {
      expect(r.ok).toBe(true)
    }

    // 2) 全部 RUNNING（首条日志驱动：stdout 路首行即转，file 路 tail 新增行触发；
    //    Loggy 启动即输出 banner，200ms 间隔持续产日志）
    await waitFor(() => {
      const states = projectIds.map((id) => processManager.getRuntimeState(id)?.status)
      return states.every((s) => s === 'RUNNING') ? states : undefined
    }, 90_000, '7 项目全部 RUNNING')

    // 3) 高负载期间 MCP 全程可用（主进程不因日志/进程负载阻塞——每次调用都在
    //    7 个 java 进程持续产日志 + stdout 捕获/文件 tail 双路由满负荷下完成）
    for (let round = 0; round < 3; round += 1) {
      const { payload, isError } = await callTool('list_projects')
      expect(isError).toBe(false)
      const projects = payload['projects'] as Array<Record<string, unknown>>
      expect(projects).toHaveLength(PROJECT_COUNT)
      const running = projects.filter((p) => p['status'] === 'RUNNING')
      expect(running.length).toBeGreaterThanOrEqual(PROJECT_COUNT - 1) // 轮询间隙允许个别未刷
      expect(running.length).toBe(PROJECT_COUNT) // 稳态：全量 RUNNING

      // get_status 逐项目抽查（奇数项目走 stdout 路、偶数含 file 路）
      const probeId = projectIds[round * 2 % PROJECT_COUNT] as string
      const st = await callTool('get_status', { project: `SmokeApp-${(round * 2 % PROJECT_COUNT) + 1}` })
      expect(st.isError).toBe(false)
      expect(st.payload['status']).toBe('RUNNING')
      expect(typeof st.payload['pid']).toBe('number')

      await sleep(400) // 持续负载窗口
    }

    // read_logs 在 7 项目负载下仍即时响应（日志链路不阻塞读取）
    const logs = await callTool('read_logs', { project: 'SmokeApp-1', lines: 20 })
    expect(logs.isError).toBe(false)
    expect((logs.payload['lines'] as string[]).length).toBeGreaterThan(0)

    // 4) 全部停止（stopAll：PowerShell Stop-Process 杀树，WMI 病态宿主自动降级）
    const stopAll = await processManager.stopAllProjects()
    for (const r of stopAll.results) {
      expect(r.ok).toBe(true)
    }
    await waitFor(() => {
      const states = projectIds.map((id) => processManager.getRuntimeState(id)?.status)
      return states.every((s) => s === 'STOPPED') ? states : undefined
    }, 60_000, '7 项目全部 STOPPED')

    // 5) kill0 核对 java.exe 全灭（A19 收尾：无残留进程）
    for (const pid of launchedPids) {
      const dead = await waitFor(
        async () => ((await taskOps.isAlive(pid)).alive ? undefined : true),
        10_000,
        `pid ${pid} 死亡`
      )
      expect(dead).toBe(true)
    }

    // 6) 终态经 MCP 同源呈现
    const finalList = await callTool('list_projects')
    const finalProjects = finalList.payload['projects'] as Array<Record<string, unknown>>
    expect(finalProjects.filter((p) => p['status'] === 'STOPPED')).toHaveLength(PROJECT_COUNT)
  }, 240_000)
})
