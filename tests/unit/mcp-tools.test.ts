import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type {
  OpResult,
  Project,
  ProjectRuntimeState,
  ReadHistoryParams,
  ReadHistoryResult,
  SearchParams,
  SearchResult
} from '../../src/shared/types'
import { createJavamgrMcpServer } from '../../src/main/mcp/tools'
import { resolveProject } from '../../src/main/mcp/tools'
import type { McpToolServices } from '../../src/main/mcp/tools'

/**
 * MCP 工具层单测（计划 §2.6 / §3 S5.1，A17 的映射部分）：
 * - project 参数解析器：id / 精确 name / 大小写不敏感 / 唯一前缀 / 歧义候选 / 未命中候选列表；
 * - 7 工具经 SDK Client + InMemoryTransport 全链路（zod 校验 + 默认值 + 出入参映射），
 *   服务层全部 mock——验证"透传同源"：handler 只做解析与转发，幂等语义由服务层拥有（透传即正确）。
 * 真实服务层 + 夹具 jar 的 HTTP 端到端在 tests/integration/mcp.integration.test.ts。
 */

// ---------- 夹具数据 ----------

const projects: Project[] = [
  {
    id: 'id-loggy',
    name: 'LoggyDemo',
    jarPath: 'D:\\jars\\loggy.jar',
    jdkId: 'jdk-17',
    jvmArgs: [],
    programArgs: [],
    envVars: {}
  },
  {
    id: 'id-order',
    name: 'order-service',
    jarPath: 'D:\\jars\\order.jar',
    jdkId: 'jdk-17',
    jvmArgs: [],
    programArgs: [],
    envVars: {}
  },
  {
    id: 'id-legacy',
    name: 'OrderBackup',
    jarPath: 'D:\\jars\\order-backup.jar',
    jdkId: 'jdk-8',
    jvmArgs: [],
    programArgs: [],
    envVars: {}
  }
]

// ---------- mock 服务层（记录调用 = 验证透传映射） ----------

const opCalls: string[] = []
const readCalls: ReadHistoryParams[] = []
const searchCalls: SearchParams[] = []
const runtimeStates = new Map<string, ProjectRuntimeState>()

const services: McpToolServices = {
  store: {
    listProjects: () => projects,
    listJdks: () => [
      { id: 'jdk-17', name: 'Temurin 17', homePath: 'D:\\java17', version: '17', vendor: 'Temurin', source: 'manual' },
      { id: 'jdk-8', name: 'Temurin 8', homePath: 'D:\\java8', version: '8', vendor: 'Temurin', source: 'manual' }
    ]
  },
  processControl: {
    getRuntimeState: (id) => runtimeStates.get(id),
    startProject: async (id) => {
      opCalls.push(`start:${id}`)
      return { ok: true, pid: 4321, status: 'STARTING' }
    },
    stopProject: async (id, timeoutMs) => {
      opCalls.push(`stop:${id}:${timeoutMs}`)
      return { ok: true, durationMs: 12 }
    },
    restartProject: async (id, stopTimeoutMs) => {
      opCalls.push(`restart:${id}:${stopTimeoutMs}`)
      return { ok: true, pid: 8765 }
    }
  },
  logService: {
    readHistory: async (params) => {
      readCalls.push(params)
      return { source: params.source === 'file' ? 'file' : 'stdout', lines: ['line-a', 'line-b'] }
    },
    search: async (params) => {
      searchCalls.push(params)
      return { matches: [{ lineNo: 3, text: 'boom' }], truncated: false }
    }
  }
}

// ---------- Client ↔ Server（InMemoryTransport） ----------

let client: Client

beforeAll(async () => {
  const server = createJavamgrMcpServer(services)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'unit-test-client', version: '1.0.0' }, { capabilities: {} })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
})

afterAll(async () => {
  await client.close().catch(() => undefined)
})

interface ToolPayload {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/** callTool + 解析 content[0].text 为 JSON（工具层契约：结构化 JSON 文本返回） */
async function callTool(name: string, args: ToolPayload = {}): Promise<{ payload: ToolPayload; isError: boolean; raw: CallToolResult }> {
  const raw = (await client.callTool({ name, arguments: args })) as CallToolResult & { isError?: boolean }
  const text = raw.content[0]?.type === 'text' ? raw.content[0].text : ''
  return { payload: JSON.parse(text) as ToolPayload, isError: raw.isError === true, raw }
}

// ---------- project 参数解析器（纯函数） ----------

describe('mcp/resolveProject：§2.6 解析链', () => {
  it('精确 id 命中', () => {
    expect(resolveProject(projects, 'id-loggy')).toEqual({
      ok: true,
      project: expect.objectContaining({ id: 'id-loggy' })
    })
  })

  it('精确 name 命中', () => {
    expect(resolveProject(projects, 'LoggyDemo')).toMatchObject({ ok: true, project: { id: 'id-loggy' } })
  })

  it('大小写不敏感 name 命中', () => {
    expect(resolveProject(projects, 'loggydemo')).toMatchObject({ ok: true, project: { id: 'id-loggy' } })
    expect(resolveProject(projects, 'ORDER-SERVICE')).toMatchObject({ ok: true, project: { id: 'id-order' } })
  })

  it('唯一前缀命中（大小写不敏感）', () => {
    expect(resolveProject(projects, 'loggy')).toMatchObject({ ok: true, project: { id: 'id-loggy' } })
    expect(resolveProject(projects, 'Loggy')).toMatchObject({ ok: true, project: { id: 'id-loggy' } })
  })

  it('歧义前缀：返回含候选列表的错误（order- 前缀命中 order-service 与 OrderBackup）', () => {
    const result = resolveProject(projects, 'order')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('order-service')
      expect(result.error).toContain('OrderBackup')
    }
  })

  it('未命中：错误含全部候选', () => {
    const result = resolveProject(projects, 'nonexistent')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('未找到')
      expect(result.error).toContain('LoggyDemo')
      expect(result.error).toContain('order-service')
    }
  })

  it('空输入：错误提示', () => {
    const result = resolveProject(projects, '  ')
    expect(result.ok).toBe(false)
  })
})

// ---------- tools/list：7 工具契约 ----------

describe('mcp/tools：tools/list 返回 7 工具（§2.6）', () => {
  it('工具名与数量精确匹配', async () => {
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

  it('serverInfo.name === "javamgr"（桥接发现命中判定锚点）', async () => {
    // initialize 握手已由 Client.connect 完成：serverInfo 来自主实例 McpServer 构造参数
    const serverVersion = client.getServerVersion()
    expect(serverVersion?.name).toBe('javamgr')
  })
})

// ---------- 各工具出入参映射 ----------

describe('mcp/tools：7 工具 handler 映射与透传', () => {
  it('list_projects：拼装状态/jdkName/uptime（无状态项目默认 STOPPED）', async () => {
    runtimeStates.set('id-loggy', {
      status: 'RUNNING',
      pid: 111,
      startTime: Date.now() - 60_000,
      uptimeMs: 60_000
    })
    runtimeStates.set('id-order', { status: 'ABNORMAL_EXIT', pid: 222, exitCode: 3 })
    const { payload, isError } = await callTool('list_projects')
    expect(isError).toBe(false)
    const byId = new Map<string, ToolPayload>(
      (payload['projects'] as ToolPayload[]).map((p) => [p['id'] as string, p])
    )
    expect(byId.get('id-loggy')).toMatchObject({
      name: 'LoggyDemo',
      status: 'RUNNING',
      pid: 111,
      jdkName: 'Temurin 17',
      jarPath: 'D:\\jars\\loggy.jar'
    })
    expect(byId.get('id-loggy')?.['uptimeMs']).toBe(60_000)
    expect(byId.get('id-order')).toMatchObject({ status: 'ABNORMAL_EXIT', exitCode: 3 })
    expect(byId.get('id-legacy')).toMatchObject({ status: 'STOPPED', jdkName: 'Temurin 8' })
    expect(byId.get('id-legacy')?.['pid']).toBeUndefined()
  })

  it('get_status：按 id 查询透传状态字段；未知项目 isError+错误信息', async () => {
    const ok = await callTool('get_status', { project: 'id-loggy' })
    expect(ok.isError).toBe(false)
    expect(ok.payload).toMatchObject({ id: 'id-loggy', name: 'LoggyDemo', status: 'RUNNING', pid: 111 })

    const miss = await callTool('get_status', { project: 'nope' })
    expect(miss.isError).toBe(true)
    expect(miss.payload['error']).toContain('未找到')
  })

  it('start_project：前缀解析 → 透传 OpResult（幂等语义由服务层拥有）', async () => {
    const { payload, isError } = await callTool('start_project', { project: 'loggy' })
    expect(isError).toBe(false)
    expect(payload).toEqual({ ok: true, pid: 4321, status: 'STARTING' })
    expect(opCalls).toContain('start:id-loggy')
  })

  it('stop_project：timeoutMs 默认 8000（§2.6 契约默认值）', async () => {
    const { payload } = await callTool('stop_project', { project: 'LoggyDemo' })
    expect(payload).toEqual({ ok: true, durationMs: 12 })
    expect(opCalls).toContain('stop:id-loggy:8000')
  })

  it('stop_project：显式 timeoutMs 透传', async () => {
    await callTool('stop_project', { project: 'id-order', timeoutMs: 2500 })
    expect(opCalls).toContain('stop:id-order:2500')
  })

  it('restart_project：stopTimeoutMs 默认 8000 / 显式透传', async () => {
    await callTool('restart_project', { project: 'order-service' })
    expect(opCalls).toContain('restart:id-order:8000')
    await callTool('restart_project', { project: 'id-order', stopTimeoutMs: 5000 })
    expect(opCalls).toContain('restart:id-order:5000')
  })

  it('start_project：服务层 ok=false 透传为 isError 工具结果', async () => {
    const failing: McpToolServices = {
      ...services,
      processControl: {
        ...services.processControl,
        startProject: async (): Promise<OpResult> => ({
          ok: false,
          error: '项目绑定的 JDK 不存在（jdkId=missing）'
        })
      }
    }
    const server = createJavamgrMcpServer(failing)
    const [c, s] = InMemoryTransport.createLinkedPair()
    const local = new Client({ name: 'failing-client', version: '1.0' }, { capabilities: {} })
    await Promise.all([local.connect(c), server.connect(s)])
    const raw = (await local.callTool({
      name: 'start_project',
      arguments: { project: 'LoggyDemo' }
    })) as CallToolResult & { isError?: boolean }
    expect(raw.isError).toBe(true)
    expect(JSON.parse(raw.content[0]?.type === 'text' ? raw.content[0].text : '')).toMatchObject({
      ok: false,
      error: expect.stringContaining('JDK 不存在')
    })
    await local.close()
    await server.close()
  })

  it('read_logs：lines 默认 200 / source 默认 auto，均透传服务层', async () => {
    const { payload } = await callTool('read_logs', { project: 'loggy' })
    expect(payload).toEqual({ source: 'stdout', lines: ['line-a', 'line-b'] })
    expect(readCalls.at(-1)).toEqual({ projectId: 'id-loggy', lines: 200, source: 'auto' })

    await callTool('read_logs', { project: 'loggy', lines: 50, source: 'file' })
    expect(readCalls.at(-1)).toEqual({ projectId: 'id-loggy', lines: 50, source: 'file' })
  })

  it('search_logs：默认值填充 + 可选字段缺省不传；结果透传', async () => {
    const { payload, isError } = await callTool('search_logs', { project: 'loggy', level: 'ERROR' })
    expect(isError).toBe(false)
    expect(payload).toEqual({ matches: [{ lineNo: 3, text: 'boom' }], truncated: false })
    expect(searchCalls.at(-1)).toEqual({
      projectId: 'id-loggy',
      level: 'ERROR',
      maxResults: 200,
      contextLines: 0
    })

    await callTool('search_logs', {
      project: 'loggy',
      keyword: 'timeout',
      startTime: '2026-11-09T00:00:00Z',
      endTime: '2026-11-09T23:59:59Z',
      maxResults: 10,
      contextLines: 2
    })
    expect(searchCalls.at(-1)).toEqual({
      projectId: 'id-loggy',
      keyword: 'timeout',
      startTime: '2026-11-09T00:00:00Z',
      endTime: '2026-11-09T23:59:59Z',
      maxResults: 10,
      contextLines: 2
    })
  })

  it('search_logs：服务层抛错 → isError 结构化返回', async () => {
    const throwing: McpToolServices = {
      ...services,
      logService: {
        ...services.logService,
        search: async (): Promise<SearchResult> => {
          throw new Error('日志文件不可读')
        },
        readHistory: async (): Promise<ReadHistoryResult> => {
          throw new Error('unreachable')
        }
      }
    }
    const server = createJavamgrMcpServer(throwing)
    const [c, s] = InMemoryTransport.createLinkedPair()
    const local = new Client({ name: 'throwing-client', version: '1.0' }, { capabilities: {} })
    await Promise.all([local.connect(c), server.connect(s)])
    const raw = (await local.callTool({
      name: 'search_logs',
      arguments: { project: 'LoggyDemo' }
    })) as CallToolResult & { isError?: boolean }
    expect(raw.isError).toBe(true)
    expect(JSON.parse(raw.content[0]?.type === 'text' ? raw.content[0].text : '')).toMatchObject({
      error: '日志文件不可读'
    })
    await local.close()
    await server.close()
  })
})

// ---------- 杂项 ----------

describe('mcp/tools：杂项', () => {
  it('resolveProject 空项目列表给出引导文案', () => {
    const result = resolveProject([], 'anything')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('没有纳管任何项目')
  })
})
