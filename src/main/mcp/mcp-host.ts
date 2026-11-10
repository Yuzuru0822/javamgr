/**
 * MCP 宿主（计划 §2.3-E / §3 S5.2，契约端口策略 Z-1 逐字落实，风险 R4 缓解）。
 *
 * 形态：http server 的 /mcp 路径 + StreamableHTTPServerTransport（**stateless**，
 * sessionIdGenerator: undefined；enableJsonResponse: true——无会话亲和，Agent/桥接重连即用），
 * **仅绑定 127.0.0.1**（缩小暴露面）。
 *
 * 实例策略（SDK 1.32 现实约束）：stateless transport **禁止跨请求复用**——SDK 在第二个
 * 请求上直接抛 "Stateless transport cannot be reused across requests"，官方 stateless
 * 示例即按"每请求新 server + 新 transport"编写。因此每个 POST 构造一对
 * McpServer+transport（makeServer 工厂），响应完成即回收；"单 server 双通道"的
 * 语义落在**服务层**：全部实例由同一 tools.ts 注册同一组 handler，直调同一
 * process-manager/log-manager（与 IPC 完全同源、零第二实现）。
 *
 * 端口策略（Z-1，契约端口，绝不静默漂移）：
 * - 端口 = settings.mcpPort（默认 7777），是 Agent 侧的 URL 契约；
 * - 绑定被占时 ① 先向占用者发 MCP initialize 探测——健康响应且 serverInfo.name==="javamgr"
 *   （上次崩溃残留的本工具实例）→ 自愈：netstat 定位 pid → taskkill /T /F → 重试绑定一次；
 *   自愈失败仍显式报错；
 * - ② 确认外部进程占用 → **MCP 启动失败 + 显式报错（含占用进程名）**，经
 *   mcp:portChanged {reason:"bind-failed"} 广播 + 状态记录；**绝不递增漂移**——
 *   宁可显式不可用，不让 Agent 的固定 URL 契约在无人知晓时断裂；
 * - 绑定成功 → 实际端口写 <userData>/mcp.port（stdio 桥接发现用）；
 * - MCP 启动失败不影响进程管理/日志/GUI 其余功能（本类只报告状态，不抛出、不退出）。
 *
 * 本模块零 electron 依赖（纯 node:http；占用者识别经 port-probe，CommandRunner 可注入）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { PortChangedEvent } from '../../shared/types'
import type { CommandRunner } from '../process/task-killer'
import type { McpToolServices } from './tools'
import { createJavamgrMcpServer } from './tools'
import {
  findListeningPid,
  killPid,
  probeJavamgrServer,
  queryImageName,
  type PortProbe
} from './port-probe'

// ---------- 状态 ----------

/** getMcpStatus()/IPC app:getMcpInfo 的运行时镜像（enabled = 实际监听中） */
export interface McpHostStatus {
  enabled: boolean
  port?: number
  url?: string
  /** 启动失败原因（显式呈现，含占用进程名） */
  error?: string
  /** bind-failed 时的占用进程名 */
  occupantName?: string
}

export interface McpHostOptions {
  services: McpToolServices
  /** <userData>/mcp.port 文件路径 */
  portFile: string
  /** 契约端口来源（settings.mcpPort；默认值 7777 已在 config-store DEFAULT_SETTINGS 拥有） */
  getPort: () => number
  /** serverInfo.version（装配层注入 app.getVersion()；缺省 0.1.0） */
  version?: string
  /** mcp:portChanged 广播通道（装配层接 webContents.send） */
  onPortChanged?: (payload: PortChangedEvent) => void
  /** MCP initialize 探测（默认真实 HTTP 探测；单测注入 fake） */
  probe?: PortProbe
  /** netstat/tasklist/taskkill 命令通道（默认真实 spawn；单测注入 fake） */
  runner?: CommandRunner
  /** 残留实例终止（默认 taskkill /T /F；单测注入可真实释放端口的 fake） */
  killOccupant?: (pid: number) => Promise<boolean>
  /** server 工厂（默认 createJavamgrMcpServer(services, version)；单测可换假 server） */
  makeServer?: () => McpServer
}

const HOST = '127.0.0.1'
/** 残留实例 taskkill 后端口释放的等待窗口 */
const PORT_RELEASE_WAIT_MS = 500

// ---------- McpHost ----------

export class McpHost {
  private readonly services: McpToolServices
  private readonly portFile: string
  private readonly getPort: () => number
  private readonly version: string
  private readonly onPortChanged?: (payload: PortChangedEvent) => void
  private readonly probe: PortProbe
  private readonly runner?: CommandRunner
  private readonly killOccupant: (pid: number) => Promise<boolean>
  private readonly makeServer: () => McpServer

  private httpServer?: Server
  private status: McpHostStatus = { enabled: false }

  constructor(opts: McpHostOptions) {
    this.services = opts.services
    this.portFile = opts.portFile
    this.getPort = opts.getPort
    this.version = opts.version ?? '0.1.0'
    this.onPortChanged = opts.onPortChanged
    this.probe = opts.probe ?? probeJavamgrServer
    this.runner = opts.runner
    this.killOccupant =
      opts.killOccupant ?? ((pid: number) => killPid(pid, this.runner))
    this.makeServer =
      opts.makeServer ?? (() => createJavamgrMcpServer(this.services, this.version))
  }

  /** 当前状态快照（IPC app:getMcpInfo 与设置页展示同源） */
  getMcpStatus(): McpHostStatus {
    return { ...this.status }
  }

  /**
   * 启动（或重启：已运行时先停再按当前 getPort() 重绑）。
   * 绝不因端口冲突抛出——失败以 status 显式呈现并广播 bind-failed（其余功能不受影响）。
   */
  async start(): Promise<McpHostStatus> {
    if (this.status.enabled) await this.stop()
    const port = this.getPort()

    // 第一次绑定尝试
    const first = await this.tryBind(port)
    if (first.ok) {
      await this.onBound(port)
      return this.getMcpStatus()
    }

    // ===== Z-1：被占 → 先探测占用者身份 =====
    const probeResult = await this.probe(port)
    if (probeResult.ok) {
      // ① 上次崩溃残留的本工具实例 → 自愈：定位 pid → 杀掉 → 重试绑定一次
      const pid = await findListeningPid(port, this.runner)
      const killed = pid !== undefined && (await this.killOccupant(pid))
      if (killed) {
        await sleep(PORT_RELEASE_WAIT_MS)
        const retry = await this.tryBind(port)
        if (retry.ok) {
          await this.onBound(port)
          this.status = {
            ...this.status,
            error: undefined,
            occupantName: undefined
          }
          console.log(
            `[mcp-host] 检测到残留实例占用契约端口 ${port}（pid=${pid}），已自动终止并重新绑定`
          )
          return this.getMcpStatus()
        }
        return this.failBind(
          port,
          `端口 ${port} 被本工具残留实例（pid=${pid}）占用：残留实例已终止，但端口重新绑定仍失败（可能被其他进程抢占）。请重启应用或在设置中更改 MCP 端口。`,
          `javamgr 残留实例（pid=${pid}）`
        )
      }
      return this.failBind(
        port,
        `端口 ${port} 被本工具残留实例${
          pid !== undefined ? `（pid=${pid}）` : ''
        }占用，自动终止失败。请手动结束该 javamgr 进程后重启应用，或在设置中更改 MCP 端口（更改后需同步更新 Agent 侧配置）。`,
        'javamgr 残留实例'
      )
    }

    // ② 外部进程占用 → 显式报错（含占用进程名与 pid），绝不递增漂移
    const pid = await findListeningPid(port, this.runner)
    const image = pid !== undefined ? await queryImageName(pid, this.runner) : undefined
    const occupantName =
      image !== undefined
        ? pid !== undefined
          ? `${image}（pid=${pid}）`
          : image
        : pid !== undefined
          ? `pid=${pid}`
          : '未知进程'
    const occupantEvent = image ?? (pid !== undefined ? `pid=${pid}` : '未知进程')
    return this.failBind(
      port,
      `端口 ${port} 被 ${occupantName} 占用，MCP 服务启动失败（其余功能不受影响）。请释放该端口或在设置中更改 MCP 端口（更改后需同步更新 Agent 侧配置）；Agent 也可改用 stdio 桥接接入（不含端口、自动发现主实例）。`,
      occupantEvent
    )
  }

  /** 停止（退出/改端口重启/用户关闭 MCP）。removePortFile=true 时同步删除 mcp.port（禁用时桥接只走递增探测）。 */
  async stop(opts?: { removePortFile?: boolean }): Promise<void> {
    const server = this.httpServer
    this.httpServer = undefined
    if (server) {
      server.closeAllConnections?.()
      await closeServer(server)
    }
    if (opts?.removePortFile) {
      await rm(this.portFile, { force: true }).catch(() => undefined)
    }
    this.status = { enabled: false }
  }

  // ==================== 内部 ====================

  /** 绑定成功收尾：实际端口写 mcp.port（供桥接发现）+ 状态落 enabled */
  private async onBound(port: number): Promise<void> {
    await mkdir(path.dirname(this.portFile), { recursive: true })
    await writeFile(this.portFile, `${port}\n`, 'utf8')
    this.status = {
      enabled: true,
      port,
      url: `http://127.0.0.1:${port}/mcp`
    }
    console.log(`[mcp-host] MCP 服务已启动：${this.status.url}（仅绑定 127.0.0.1）`)
  }

  /** 绑定失败收尾：状态记录 + bind-failed 广播（含占用进程名，§2.5 mcp:portChanged） */
  private failBind(port: number, message: string, occupantName: string): McpHostStatus {
    this.status = { enabled: false, port, error: message, occupantName }
    console.error(`[mcp-host] ${message}`)
    this.onPortChanged?.({ port, reason: 'bind-failed', occupantName })
    return this.getMcpStatus()
  }

  /**
   * 建监听（http server 仅 127.0.0.1）。EADDRINUSE → {ok:false}（调用方进入 Z-1 探测分支）。
   * McpServer+transport 不在此处常驻：stateless 模式下 SDK 禁止跨请求复用 transport，
   * 每个请求在 route() 内经 makeServer() 现场构造一对（官方 stateless 示例模式）。
   */
  private async tryBind(port: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const httpServer = createServer((req, res) => this.route(req, res))
    httpServer.on('clientError', (_err, socket) => socket.destroy()) // 畸形请求直接断开，不拖垮宿主

    try {
      await listen(httpServer, port, HOST)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      httpServer.closeAllConnections?.()
      await closeServer(httpServer).catch(() => undefined)
      const inUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      return { ok: false, error: inUse ? 'EADDRINUSE' : message }
    }

    this.httpServer = httpServer
    return { ok: true }
  }

  /**
   * /mcp 路由：POST → 每请求新 McpServer+stateless transport（SDK 1.32 现实约束：
   * "Stateless transport cannot be reused across requests"，见类头注释）；
   * GET/DELETE → 405（stateless 官方示例语义）；其他路径 404。
   */
  private route(req: IncomingMessage, res: ServerResponse): void {
    const pathname = (req.url ?? '/').split('?')[0]
    if (pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ error: 'Not Found' })
      )
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null
        })
      )
      return
    }

    const mcpServer = this.makeServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless（§2.3-E）：无会话亲和，重连即用
      enableJsonResponse: true // 本工具 7 个工具均为一问一答，JSON 响应模式足够且对探测/桥接最简
    })
    void (async () => {
      try {
        await mcpServer.connect(transport)
        await transport.handleRequest(req, res)
      } catch (err) {
        console.error('[mcp-host] /mcp 请求处理异常：', err)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null
            })
          )
        }
      } finally {
        // 响应已送出：回收本请求的 server/transport（官方 stateless 示例收尾）
        // TODO(P3-3, phase4 审查)：此监听挂在 handleRequest 完成之后，客户端在请求处理
        // 中途 abort 时 'close' 可能先于 finally 触发而漏回收（一次性对象，随 GC 收敛，
        // 量级可忽略）；彻底修复需在 handleRequest 前挂 'close' 监听并处理已回收竞态。
        res.on('close', () => {
          void transport.close().catch(() => undefined)
          void mcpServer.close().catch(() => undefined)
        })
      }
    })()
  }
}

// ---------- 小工具 ----------

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const onListening = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      server.off('error', onError)
      server.off('listening', onListening)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) {
      server.close(() => resolve())
      // 兜底：连接未排空也不永久挂起（closeAllConnections 已在调用方先行）
      setTimeout(() => resolve(), 2_000).unref()
    } else {
      resolve()
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
