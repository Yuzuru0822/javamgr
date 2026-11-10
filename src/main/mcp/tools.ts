/**
 * MCP 工具层（计划 §2.6 七工具精确签名 / §3 S5.1）。
 *
 * 核心纪律：**全部 handler 直调 process-manager / log-manager 服务层，与 IPC 完全同源，
 * 零第二实现**——GUI 与 MCP 是同一权威状态源的两个等价客户端（RALPLAN 原则 1）。
 * 因此幂等语义（RUNNING 下 start 返回现 pid）、操作队列串行化（restart 原子组合、
 * 并发 stop 与 restart 交错被队列化为确定顺序）不需要在工具层复述：透传服务层即可。
 *
 * project 参数解析器（§2.6 末尾）：精确 id → 精确 name → 大小写不敏感 name → 唯一前缀
 * （name 前缀，大小写不敏感）；歧义/未命中返回含候选列表的错误（Agent 可自行纠正）。
 *
 * serverInfo.name 恒为 "javamgr"（JAVAMGR_SERVER_NAME）——stdio 桥接自动发现与
 * 残留实例自愈的命中判定都依赖该名称（§2.3-E），不得改名。
 *
 * 本模块零 electron 依赖（服务面为结构化最小接口，主进程装配层注入真实实例）。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type {
  Jdk,
  OpResult,
  Project,
  ProjectRuntimeState,
  ReadHistoryResult,
  SearchResult
} from '../../shared/types'
import { JAVAMGR_SERVER_NAME } from './port-probe'

// ---------- 服务面（结构化最小接口；与 ipc-registry 的注入面同构，避免反向依赖 electron） ----------

/** 进程控制服务面（ProcessManager 的结构子集；主进程装配层注入真实实例） */
export interface McpProcessControl {
  getRuntimeState(projectId: string): ProjectRuntimeState | undefined
  startProject(projectId: string): Promise<OpResult>
  stopProject(projectId: string, timeoutMs?: number): Promise<OpResult>
  restartProject(projectId: string, stopTimeoutMs?: number): Promise<OpResult>
}

/** 日志服务面（LogManager 的结构子集） */
export interface McpLogService {
  readHistory(params: {
    projectId: string
    lines?: number
    source?: 'auto' | 'file' | 'stdout'
  }): Promise<ReadHistoryResult>
  search(params: {
    projectId: string
    keyword?: string
    level?: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'
    startTime?: string
    endTime?: string
    maxResults?: number
    contextLines?: number
  }): Promise<SearchResult>
}

export interface McpToolServices {
  /** 配置读取面（ConfigStore 的结构子集） */
  store: {
    listProjects(): Project[]
    listJdks(): Jdk[]
  }
  processControl: McpProcessControl
  logService: McpLogService
}

// ---------- project 参数解析器（§2.6：精确 id → 精确 name → 大小写不敏感 name → 唯一前缀） ----------

export type ProjectResolution = { ok: true; project: Project } | { ok: false; error: string }

function candidateList(projects: Project[]): string {
  return projects.map((p) => `${p.name}（id=${p.id}）`).join('、')
}

export function resolveProject(projects: Project[], input: string): ProjectResolution {
  const query = input.trim()
  if (!query) {
    return {
      ok: false,
      error: `项目参数为空。${projects.length > 0 ? `可用项目：${candidateList(projects)}` : '当前没有纳管任何项目，请先在面板中添加。'}`
    }
  }

  // ① 精确 id
  const byId = projects.find((p) => p.id === query)
  if (byId) return { ok: true, project: byId }

  // ② 精确 name
  const byName = projects.filter((p) => p.name === query)
  if (byName.length === 1) return { ok: true, project: byName[0] as Project }
  if (byName.length > 1) {
    return {
      ok: false,
      error: `「${query}」匹配多个同名项目：${candidateList(byName)}。请改用项目 id。`
    }
  }

  // ③ 大小写不敏感 name
  const lower = query.toLowerCase()
  const byCase = projects.filter((p) => p.name.toLowerCase() === lower)
  if (byCase.length === 1) return { ok: true, project: byCase[0] as Project }
  if (byCase.length > 1) {
    return {
      ok: false,
      error: `「${query}」匹配多个项目（大小写不敏感）：${candidateList(byCase)}。请使用完整名称或项目 id。`
    }
  }

  // ④ 唯一前缀（name，大小写不敏感）
  const byPrefix = projects.filter((p) => p.name.toLowerCase().startsWith(lower))
  if (byPrefix.length === 1) return { ok: true, project: byPrefix[0] as Project }
  if (byPrefix.length > 1) {
    return {
      ok: false,
      error: `「${query}」是 ${byPrefix.length} 个项目的公共前缀：${candidateList(byPrefix)}。请提供更长的前缀、完整名称或项目 id。`
    }
  }

  // 未命中：附候选列表，Agent 可据此纠正
  return {
    ok: false,
    error: `未找到匹配的项目「${query}」。${
      projects.length > 0
        ? `可用项目：${candidateList(projects)}`
        : '当前没有纳管任何项目，请先在面板中添加。'
    }`
  }
}

// ---------- 工具返回封装 ----------

/** 结构化 JSON 文本返回（Agent 侧解析友好）；domain 失败置 isError=true（不抛异常，错误信息即载荷） */
function toolResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {})
  }
}

// ---------- zod 入参 schema（§2.6 逐工具签名；raw shape 传给 registerTool） ----------

const projectArg = z
  .string()
  .min(1)
  .describe('项目 id、精确名称、大小写不敏感名称或唯一名称前缀')

/** §2.6 stop_project timeoutMs 默认 8000（与 restart stopTimeoutMs 同值；透传服务层单次停止超时） */
const STOP_TIMEOUT_DEFAULT_MS = 8_000

const stopTimeoutArg = z
  .number()
  .int()
  .min(100)
  .max(120_000)
  .default(STOP_TIMEOUT_DEFAULT_MS)
  .describe('停止超时毫秒数（进程树终止 + 存活确认的总预算，默认 8000）')

const toolSchemas = {
  get_status: { project: projectArg },
  start_project: { project: projectArg },
  stop_project: { project: projectArg, timeoutMs: stopTimeoutArg },
  restart_project: { project: projectArg, stopTimeoutMs: stopTimeoutArg },
  read_logs: {
    project: projectArg,
    lines: z.number().int().min(1).max(10_000).default(200).describe('读取尾部行数（默认 200）'),
    source: z
      .enum(['auto', 'file', 'stdout'])
      .default('auto')
      .describe('日志来源：auto=按项目配置路由；file=配置的日志文件；stdout=捕获的标准输出')
  },
  search_logs: {
    project: projectArg,
    keyword: z.string().min(1).describe('不区分大小写的子串关键字').optional(),
    level: z
      .enum(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'])
      .describe('日志级别过滤')
      .optional(),
    startTime: z.string().describe('时间范围起点（ISO 8601）').optional(),
    endTime: z.string().describe('时间范围终点（ISO 8601）').optional(),
    maxResults: z.number().int().min(1).max(10_000).default(200).describe('命中上限（默认 200）'),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(0)
      .describe('每条命中的上下邻行数（默认 0）')
  }
} as const

// ---------- 工具注册 ----------

/**
 * 在 McpServer 实例上注册 7 工具（§2.6）。server 实例由调用方构造（mcp-host）或用
 * {@link createJavamgrMcpServer} 一并构造。
 */
export function registerMcpTools(server: McpServer, services: McpToolServices): void {
  const { store, processControl, logService } = services

  /** 解析 project 参数；失败时返回 isError 工具结果（含候选列表） */
  function resolveOr(
    project: string
  ): { ok: true; id: string } | { ok: false; result: CallToolResult } {
    const resolution = resolveProject(store.listProjects(), project)
    if (!resolution.ok) return { ok: false, result: toolResult({ error: resolution.error }, true) }
    return { ok: true, id: resolution.project.id }
  }

  /** 启停操作透传：OpResult 即工具返回（ok=false 时 isError，服务层错误语义完整保留） */
  const passThroughOp = (result: OpResult): CallToolResult => toolResult(result, !result.ok)

  // ===== list_projects =====
  server.registerTool(
    'list_projects',
    {
      title: '列出纳管项目',
      description: '列出全部纳管项目及实时运行状态（状态/pid/uptime/退出码）。无需参数。'
    },
    async () => {
      const jdks = new Map(store.listJdks().map((j) => [j.id, j.name]))
      const projects = store.listProjects().map((p) => {
        const rt = processControl.getRuntimeState(p.id)
        return {
          id: p.id,
          name: p.name,
          status: rt?.status ?? 'STOPPED',
          ...(rt?.pid !== undefined ? { pid: rt.pid } : {}),
          jarPath: p.jarPath,
          jdkName: jdks.get(p.jdkId) ?? '（JDK 已缺失）',
          ...(rt?.uptimeMs !== undefined ? { uptimeMs: rt.uptimeMs } : {}),
          ...(rt?.exitCode !== undefined ? { exitCode: rt.exitCode } : {})
        }
      })
      return toolResult({ projects })
    }
  )

  // ===== get_status =====
  server.registerTool(
    'get_status',
    {
      title: '查询项目状态',
      description:
        '查询单个项目的实时运行状态（STARTING/RUNNING/STOPPED/ABNORMAL_EXIT，含 pid/启动时间/uptime/退出码）。',
      inputSchema: toolSchemas.get_status
    },
    async ({ project }) => {
      const r = resolveOr(project)
      if (!r.ok) return r.result
      const found = store.listProjects().find((p) => p.id === r.id)
      const rt = processControl.getRuntimeState(r.id)
      return toolResult({
        id: r.id,
        name: found?.name ?? r.id,
        status: rt?.status ?? 'STOPPED',
        ...(rt?.pid !== undefined ? { pid: rt.pid } : {}),
        ...(rt?.startTime !== undefined ? { startTime: rt.startTime } : {}),
        ...(rt?.uptimeMs !== undefined ? { uptimeMs: rt.uptimeMs } : {}),
        ...(rt?.exitCode !== undefined ? { exitCode: rt.exitCode } : {})
      })
    }
  )

  // ===== start_project（幂等：RUNNING→现 pid；STARTING→现 pid+STARTING，绝不二次 spawn） =====
  server.registerTool(
    'start_project',
    {
      title: '启动项目',
      description:
        '启动项目。幂等：已在运行/启动中时返回现有 pid，不会重复启动。并发请求经项目操作队列串行化。',
      inputSchema: toolSchemas.start_project
    },
    async ({ project }) => {
      const r = resolveOr(project)
      if (!r.ok) return r.result
      return passThroughOp(await processControl.startProject(r.id))
    }
  )

  // ===== stop_project（PowerShell Stop-Process 杀树；WMI 病态宿主自动降级为主进程单杀；已停止幂等 ok） =====
  server.registerTool(
    'stop_project',
    {
      title: '停止项目',
      description:
        '停止项目并终止整棵进程树（含派生子进程）。已停止时幂等返回成功。timeoutMs 为停止超时（默认 8000ms）。WMI 病态宿主下自动降级为仅终止主进程（返回 note 说明，子进程可能残留）。',
      inputSchema: toolSchemas.stop_project
    },
    async ({ project, timeoutMs }) => {
      const r = resolveOr(project)
      if (!r.ok) return r.result
      return passThroughOp(await processControl.stopProject(r.id, timeoutMs))
    }
  )

  // ===== restart_project（原子组合：stop 等树死 → start，整段占用操作队列） =====
  server.registerTool(
    'restart_project',
    {
      title: '重启项目',
      description:
        '原子重启：先停止并等待进程树死亡，再启动；整段操作串行执行，期间不插入同项目其他操作。适用于"重启后看错误日志"场景。',
      inputSchema: toolSchemas.restart_project
    },
    async ({ project, stopTimeoutMs }) => {
      const r = resolveOr(project)
      if (!r.ok) return r.result
      return passThroughOp(await processControl.restartProject(r.id, stopTimeoutMs))
    }
  )

  // ===== read_logs（实时尾部；auto 按项目配置路由） =====
  server.registerTool(
    'read_logs',
    {
      title: '读取日志尾部',
      description:
        '读取项目最近日志行（默认 200 行）。source=auto 按项目配置路由（配置了日志文件→tail 文件，否则→捕获的 stdout 落盘）。',
      inputSchema: toolSchemas.read_logs
    },
    async ({ project, lines, source }) => {
      const r = resolveOr(project)
      if (!r.ok) return r.result
      try {
        const result = await logService.readHistory({ projectId: r.id, lines, source })
        return toolResult(result)
      } catch (err) {
        return toolResult(
          { error: err instanceof Error ? err.message : String(err), source, lines },
          true
        )
      }
    }
  )

  // ===== search_logs（关键字/级别/时间窗/上下文） =====
  server.registerTool(
    'search_logs',
    {
      title: '检索日志',
      description:
        '按关键字（不区分大小写子串）/级别/时间范围（ISO 8601）检索项目日志，可带上下文行；返回 {matches:[{lineNo,text,timestamp?}],truncated}。',
      inputSchema: toolSchemas.search_logs
    },
    async ({ project, keyword, level, startTime, endTime, maxResults, contextLines }) => {
      const r = resolveOr(project)
      if (!r.ok) return r.result
      try {
        const result = await logService.search({
          projectId: r.id,
          ...(keyword !== undefined ? { keyword } : {}),
          ...(level !== undefined ? { level } : {}),
          ...(startTime !== undefined ? { startTime } : {}),
          ...(endTime !== undefined ? { endTime } : {}),
          maxResults,
          contextLines
        })
        return toolResult(result)
      } catch (err) {
        return toolResult({ error: err instanceof Error ? err.message : String(err) }, true)
      }
    }
  )
}

/**
 * 构造 javamgr MCP server（serverInfo.name = "javamgr"，桥接发现/自愈命中判定的锚点）。
 * 版本号取 package.json 版本（主进程注入；缺省 0.1.0）。
 */
export function createJavamgrMcpServer(services: McpToolServices, version = '0.1.0'): McpServer {
  const server = new McpServer(
    { name: JAVAMGR_SERVER_NAME, version },
    {
      instructions:
        'Windows Java 进程管理器：纳管预构建 jar 项目的启停/状态/日志。project 参数支持 id、精确名称、大小写不敏感名称或唯一前缀。'
    }
  )
  registerMcpTools(server, services)
  return server
}
