import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type {
  BatchResult,
  OpResult,
  Project,
  ProjectInput,
  ProjectRuntimeState,
  ReadHistoryParams,
  ReadHistoryResult,
  SearchParams,
  SearchResult
} from '../../src/shared/types'
import { ConfigError } from '../../src/main/config/config-store'
import { createJavamgrMcpServer } from '../../src/main/mcp/tools'
import { resolveProject } from '../../src/main/mcp/tools'
import type { McpToolServices } from '../../src/main/mcp/tools'

/**
 * MCP 工具层单测（计划 §2.6 / §3 S5.1，A17 的映射部分）：
 * - project 参数解析器：id / 精确 name / 大小写不敏感 / 唯一前缀 / 歧义候选 / 未命中候选列表；
 * - 工具经 SDK Client + InMemoryTransport 全链路（zod 校验 + 默认值 + 出入参映射），
 *   服务层全部 mock——验证"透传同源"：handler 只做解析与转发，幂等语义由服务层拥有（透传即正确）。
 * - 2026-11-10 面板同款补齐工具：create/update/delete_project、start/stop_all、list_jdks。
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
const batchCalls: string[] = []
const switchRouteCalls: string[] = []
const createInputs: ProjectInput[] = []
const updateInputs: Array<ProjectInput & { id: string }> = []
/** store mock 的内存库（独立于夹具常量，create/delete 用例可安全变更） */
const db: Project[] = structuredClone(projects)
let idSeq = 0

const services: McpToolServices = {
  store: {
    listProjects: () => db,
    listJdks: () => [
      { id: 'jdk-17', name: 'Temurin 17', homePath: 'D:\\java17', version: '17', vendor: 'Temurin', source: 'manual' },
      { id: 'jdk-8', name: 'Temurin 8', homePath: 'D:\\java8', version: '8', vendor: 'Temurin', source: 'manual' }
    ],
    createProject: async (input) => {
      createInputs.push(input)
      const project: Project = { ...input, id: `id-gen-${++idSeq}` }
      db.push(project)
      return project
    },
    updateProject: async (input) => {
      updateInputs.push(input)
      const index = db.findIndex((p) => p.id === input.id)
      if (index === -1) throw new ConfigError('NOT_FOUND', `项目不存在：${input.id}`)
      const updated: Project = { ...input }
      db[index] = updated
      return updated
    },
    deleteProject: async (id) => {
      const index = db.findIndex((p) => p.id === id)
      if (index === -1) throw new ConfigError('NOT_FOUND', `项目不存在：${id}`)
      const [removed] = db.splice(index, 1)
      return removed
    }
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
    },
    startAllProjects: async (): Promise<BatchResult> => {
      batchCalls.push('startAll')
      return { results: [{ id: 'id-loggy', ok: true }, { id: 'id-order', ok: false, error: 'JDK 缺失' }] }
    },
    stopAllProjects: async (): Promise<BatchResult> => {
      batchCalls.push('stopAll')
      return { results: [{ id: 'id-loggy', ok: true }] }
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
    },
    switchRoute: (projectId) => {
      switchRouteCalls.push(projectId)
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

// ---------- tools/list：13 工具契约 ----------

describe('mcp/tools：tools/list 返回 13 工具（§2.6 原始 7 + 面板同款补齐 6）', () => {
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
        'search_logs',
        'list_jdks',
        'create_project',
        'update_project',
        'delete_project',
        'start_all_projects',
        'stop_all_projects'
      ].sort()
    )
  })

  it('serverInfo.name === "javamgr"（桥接发现命中判定锚点）', async () => {
    // initialize 握手已由 Client.connect 完成：serverInfo 来自主实例 McpServer 构造参数
    const serverVersion = client.getServerVersion()
    expect(serverVersion?.name).toBe('javamgr')
  })

  it('serverInfo.version 取注入值（装配层传 app.getVersion()）', async () => {
    const server = createJavamgrMcpServer(services, '9.9.9-test')
    const [c, s] = InMemoryTransport.createLinkedPair()
    const local = new Client({ name: 'version-client', version: '1.0' }, { capabilities: {} })
    await Promise.all([local.connect(c), server.connect(s)])
    expect(local.getServerVersion()).toMatchObject({ name: 'javamgr', version: '9.9.9-test' })
    await local.close()
    await server.close()
  })
})

// ---------- 各工具出入参映射 ----------

describe('mcp/tools：原始 7 工具 handler 映射与透传', () => {
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

// ---------- 面板同款补齐工具（2026-11-10：create/update/delete、start/stop_all、list_jdks） ----------

describe('mcp/tools：面板同款补齐工具', () => {
  it('list_jdks：返回全部 JDK 字段（create/update 的 jdkId 候选来源）', async () => {
    const { payload, isError } = await callTool('list_jdks')
    expect(isError).toBe(false)
    expect(payload['jdks']).toEqual([
      expect.objectContaining({ id: 'jdk-17', name: 'Temurin 17', version: '17' }),
      expect.objectContaining({ id: 'jdk-8', name: 'Temurin 8' })
    ])
  })

  it('create_project：必填校验 + 数组/记录默认空 + 返回生成的 id', async () => {
    const { payload, isError } = await callTool('create_project', {
      name: 'NewSvc',
      jarPath: 'D:\\jars\\new.jar',
      jdkId: 'jdk-17'
    })
    expect(isError).toBe(false)
    expect(payload['created']).toMatchObject({
      name: 'NewSvc',
      jarPath: 'D:\\jars\\new.jar',
      jdkId: 'jdk-17',
      jvmArgs: [],
      programArgs: [],
      envVars: {}
    })
    expect(typeof payload['created']['id']).toBe('string')
    // 生效：新项目可被 list_projects / 前缀解析命中
    const list = await callTool('list_projects')
    expect(
      (list.payload['projects'] as ToolPayload[]).some((p) => p['name'] === 'NewSvc')
    ).toBe(true)
  })

  it('create_project：可选字段透传（logFilePath/envVars）', async () => {
    await callTool('create_project', {
      name: 'FileLogSvc',
      jarPath: 'D:\\jars\\f.jar',
      jdkId: 'jdk-8',
      envVars: { APP_ENV: 'test' },
      logFilePath: 'D:\\logs\\f.log',
      encodingOverride: 'gbk'
    })
    expect(createInputs.at(-1)).toMatchObject({
      name: 'FileLogSvc',
      jdkId: 'jdk-8',
      envVars: { APP_ENV: 'test' },
      logFilePath: 'D:\\logs\\f.log',
      encodingOverride: 'gbk'
    })
  })

  it('create_project：未注册 jdkId → isError 且错误含 JDK 候选列表', async () => {
    const { payload, isError } = await callTool('create_project', {
      name: 'Bad',
      jarPath: 'D:\\jars\\bad.jar',
      jdkId: 'jdk-missing'
    })
    expect(isError).toBe(true)
    expect(payload['error']).toContain('jdk-missing')
    expect(payload['error']).toContain('jdk-17')
    expect(createInputs.every((i) => i.name !== 'Bad')).toBe(true) // 未落库
  })

  it('update_project：部分更新缺省沿用现值（整体替换语义的参数装配）', async () => {
    const before = structuredClone(db.find((p) => p.id === 'id-loggy'))
    const { payload, isError } = await callTool('update_project', {
      project: 'loggy',
      jvmArgs: ['-Xmx1g']
    })
    expect(isError).toBe(false)
    expect(updateInputs.at(-1)).toMatchObject({
      id: 'id-loggy',
      name: before?.name,
      jarPath: before?.jarPath,
      jdkId: before?.jdkId,
      jvmArgs: ['-Xmx1g'],
      programArgs: [],
      envVars: {}
    })
    expect(payload['updated']).toMatchObject({ id: 'id-loggy', jvmArgs: ['-Xmx1g'] })
  })

  it('update_project：logFilePath 变更触发 switchRoute；同值再改不触发', async () => {
    const routesBefore = switchRouteCalls.length
    await callTool('update_project', { project: 'id-loggy', logFilePath: 'D:\\logs\\app.log' })
    expect(updateInputs.at(-1)).toMatchObject({ logFilePath: 'D:\\logs\\app.log' })
    expect(switchRouteCalls.length).toBe(routesBefore + 1)
    expect(switchRouteCalls.at(-1)).toBe('id-loggy')

    await callTool('update_project', { project: 'id-loggy', logFilePath: 'D:\\logs\\app.log' })
    expect(switchRouteCalls.length).toBe(routesBefore + 1) // 未变更不触发
  })

  it('update_project：logFilePath=null 清除可选字段（改走 stdout 捕获）', async () => {
    const { payload, isError } = await callTool('update_project', {
      project: 'id-loggy',
      logFilePath: null
    })
    expect(isError).toBe(false)
    expect(payload['updated']['logFilePath']).toBeUndefined()
  })

  it('update_project：非法 jdkId → isError 含候选；未知项目 → isError', async () => {
    const badJdk = await callTool('update_project', { project: 'loggy', jdkId: 'jdk-missing' })
    expect(badJdk.isError).toBe(true)
    expect(badJdk.payload['error']).toContain('jdk-missing')

    const miss = await callTool('update_project', { project: 'nope', name: 'X' })
    expect(miss.isError).toBe(true)
    expect(miss.payload['error']).toContain('未找到')
  })

  it('delete_project：已停止项目直接删除并返回被删配置', async () => {
    runtimeStates.delete('id-order')
    const { payload, isError } = await callTool('delete_project', {
      project: 'order-service',
      confirm: false
    })
    expect(isError).toBe(false)
    expect(payload['deleted']).toMatchObject({ id: 'id-order', name: 'order-service' })
    expect(db.some((p) => p.id === 'id-order')).toBe(false)
  })

  it('delete_project：运行中 + confirm=false 拒绝（不 stop 不删）；confirm=true 先 stop 再删', async () => {
    runtimeStates.set('id-legacy', { status: 'RUNNING', pid: 999 })
    const refuse = await callTool('delete_project', { project: 'OrderBackup', confirm: false })
    expect(refuse.isError).toBe(true)
    expect(refuse.payload['error']).toContain('confirm=true')
    expect(db.some((p) => p.id === 'id-legacy')).toBe(true)
    expect(opCalls).not.toContain('stop:id-legacy:undefined')

    const ok = await callTool('delete_project', { project: 'OrderBackup', confirm: true })
    expect(ok.isError).toBe(false)
    expect(ok.payload['deleted']).toMatchObject({ id: 'id-legacy' })
    expect(opCalls).toContain('stop:id-legacy:undefined') // 默认超时透传（服务层默认 8000）
    expect(db.some((p) => p.id === 'id-legacy')).toBe(false)
    runtimeStates.delete('id-legacy')
  })

  it('start_all_projects / stop_all_projects：无参透传 BatchResult 汇总', async () => {
    const start = await callTool('start_all_projects')
    expect(start.isError).toBe(false)
    expect(start.payload).toEqual({
      results: [
        { id: 'id-loggy', ok: true },
        { id: 'id-order', ok: false, error: 'JDK 缺失' }
      ]
    })
    const stop = await callTool('stop_all_projects')
    expect(stop.isError).toBe(false)
    expect(stop.payload).toEqual({ results: [{ id: 'id-loggy', ok: true }] })
    expect(batchCalls).toEqual(['startAll', 'stopAll'])
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
