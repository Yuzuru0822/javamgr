/**
 * 本地浏览器面板宿主（v0.5.0）。
 *
 * 形态：node:http 单服务承载同一渲染端构建产物（out/renderer 静态文件）+
 * POST /web/api/<channel>（IPC 透传）+ GET /web/events（SSE 事件流）。
 * **仅绑定 127.0.0.1**（与 MCP 宿主同暴露面纪律）。
 *
 * 同源纪律：浏览器面板 = IPC 的第三个等价客户端（GUI 窗口 / MCP / 浏览器）。
 * /web/api 经 ipc-registry 注入的 call 函数路由到与 ipcMain.handle **同一组 handler**
 * （零第二实现）；事件经 broadcastEvent 挂钩推送 SSE（proc:statusChanged /
 * log:appended / updater:status 等，与窗口推送同源同载荷）。
 *
 * 安全（本地单用户边界内的纵深防御）：
 * - Host 头必须是本机字面量（127.0.0.1/localhost）—— 防浏览器 DNS 重绑定；
 * - Origin 头存在时必须同源，否则 403 —— 防任意网站跨站发起的 CSRF
 *   （自定义/JSON 请求会被同源策略拦截响应，但请求本身可能已执行，须前置拒绝）；
 * - 静态路径规范化后必须仍在 rootDir 内 —— 防目录穿越；
 * - POST 仅接受 application/json。
 *
 * 端口策略：契约端口（settings.webPort，默认 7790，避开 MCP 桥接递增探测段
 * 7777–7786）；被占显式报错不漂移（与 Z-1 同纪律，简化版：状态记录 + 查询呈现）。
 *
 * 本模块零 electron 依赖（rootDir/call 经注入；vitest 纯 Node 可完整测试）。
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

/** IPC 透传函数（ipc-registry 提供；与 ipcMain.handle 同一组 handler） */
export type IpcCallFn = (
  channel: string,
  raw: unknown
) => Promise<{ ok: true; data: unknown } | { ok: false; code: string; message: string; details?: unknown }>

export interface WebHostStatus {
  enabled: boolean
  port?: number
  url?: string
  error?: string
}

export interface WebHostOptions {
  /** 渲染端静态根（out/renderer；Electron asar 路径经 fs 补丁可读） */
  rootDir: string
  /** 契约端口来源（settings.webPort） */
  getPort: () => number
  /** 开关来源（settings.webEnabled） */
  isEnabled: () => boolean
  /** IPC 透传（ipc-registry 的 callIpcHandler） */
  call: IpcCallFn
  /** 状态变化通知（装配层接托盘/设置页刷新） */
  onStatus?: (status: WebHostStatus) => void
}

const HOST = '127.0.0.1'
/** SSE 心跳间隔（防代理/浏览器静默断连） */
const SSE_HEARTBEAT_MS = 15_000

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}

export class WebHost {
  private readonly rootDir: string
  private readonly getPort: () => number
  private readonly isEnabled: () => boolean
  private readonly call: IpcCallFn
  private readonly onStatus?: (status: WebHostStatus) => void

  private httpServer?: Server
  private sseClients = new Set<ServerResponse>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private status: WebHostStatus = { enabled: false }

  constructor(opts: WebHostOptions) {
    this.rootDir = path.resolve(opts.rootDir)
    this.getPort = opts.getPort
    this.isEnabled = opts.isEnabled
    this.call = opts.call
    this.onStatus = opts.onStatus
  }

  getWebStatus(): WebHostStatus {
    return { ...this.status }
  }

  /** 启动（或重启：已运行先停再按当前设置重绑）。失败不抛出——状态显式呈现。 */
  async start(): Promise<WebHostStatus> {
    if (this.httpServer) await this.stop()
    if (!this.isEnabled()) {
      this.setStatus({ enabled: false })
      return this.getWebStatus()
    }
    const port = this.getPort()
    const server = createServer((req, res) => {
      void this.route(req, res)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, HOST, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setStatus({
        enabled: false,
        port,
        error: `端口 ${port} 绑定失败：${message}。可在设置中更改浏览器访问端口；其余功能不受影响。`
      })
      console.error(`[web-host] ${this.status.error}`)
      return this.getWebStatus()
    }

    this.httpServer = server
    this.startHeartbeat()
    // 端口 0 = 内核分配（单测用）：状态/URL 取实际端口
    const actualPort =
      server.address() !== null && typeof server.address() === 'object'
        ? (server.address() as { port: number }).port
        : port
    this.setStatus({ enabled: true, port: actualPort, url: `http://${HOST}:${actualPort}` })
    console.log(`[web-host] 浏览器面板已启动：${this.status.url}（仅绑定 127.0.0.1）`)
    return this.getWebStatus()
  }

  async stop(): Promise<void> {
    const server = this.httpServer
    this.httpServer = undefined
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    for (const res of this.sseClients) {
      res.end()
    }
    this.sseClients.clear()
    if (server) {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        setTimeout(() => resolve(), 2_000).unref()
      })
    }
    this.setStatus({ enabled: false })
  }

  /** 事件广播（broadcastEvent 挂钩 → SSE 全客户端推送） */
  broadcast(channel: string, payload: unknown): void {
    if (this.sseClients.size === 0) return
    const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`
    for (const res of this.sseClients) res.write(frame)
  }

  // ==================== 路由 ====================

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.securityCheck(req, res)) return
      const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]!)

      if (req.method === 'GET' && pathname === '/web/events') {
        this.attachSse(res)
        return
      }
      if (req.method === 'POST' && pathname.startsWith('/web/api/')) {
        await this.handleApi(req, res, pathname.slice('/web/api/'.length))
        return
      }
      if (req.method === 'GET') {
        await this.serveStatic(res, pathname)
        return
      }
      res.writeHead(405, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'Method not allowed' })
      )
    } catch (err) {
      // 单请求异常不拖垮宿主（与 mcp-host route 同纪律）
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: 'Internal server error' })
        )
      } else {
        res.end()
      }
      console.error('[web-host] 请求处理异常：', err)
    }
  }

  /** Host 字面量 + 同源 Origin 校验；未通过即写 403 并返回 false */
  private securityCheck(req: IncomingMessage, res: ServerResponse): boolean {
    const host = (req.headers['host'] ?? '').toLowerCase()
    if (!(host.startsWith('127.0.0.1:') || host.startsWith('localhost:'))) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'Forbidden: Host must be loopback literal' })
      )
      return false
    }
    const origin = req.headers['origin']
    if (origin !== undefined) {
      const allowed = new Set([`http://${host}`, `http://127.0.0.1:${host.split(':')[1]}`, `http://localhost:${host.split(':')[1]}`])
      if (!allowed.has(String(origin).toLowerCase())) {
        res.writeHead(403, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: 'Forbidden: cross-origin request rejected' })
        )
        return false
      }
    }
    return true
  }

  private attachSse(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    res.write('retry: 3000\n\n')
    this.sseClients.add(res)
    res.on('close', () => {
      this.sseClients.delete(res)
    })
  }

  private async handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    channel: string
  ): Promise<void> {
    if (channel === '' || channel.includes('/')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'Unknown channel' })
      )
      return
    }
    const contentType = String(req.headers['content-type'] ?? '')
    if (!contentType.toLowerCase().includes('application/json')) {
      res.writeHead(415, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'Content-Type must be application/json' })
      )
      return
    }
    const body = await readJsonBody(req)
    const result = await this.call(channel, body)
    if (result.ok) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ ok: true, data: result.data })
      )
      return
    }
    // 域错误（校验/不存在/冲突等）→ 400 级；结构化载荷与 IPC 错误协议同形
    const status = result.code === 'INTERNAL' ? 500 : 400
    res.writeHead(status, { 'content-type': 'application/json' }).end(
      JSON.stringify({ ok: false, code: result.code, message: result.message })
    )
  }

  private async serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    const full = path.resolve(this.rootDir, relative)
    if (!(full === this.rootDir || full.startsWith(this.rootDir + path.sep))) {
      res.writeHead(403).end('Forbidden')
      return // 目录穿越
    }
    let info
    try {
      info = await stat(full)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found')
      return
    }
    if (!info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found')
      return
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache' // 本地单用户，无 CDN 语义，避免旧面板滞留
    })
    createReadStream(full).pipe(res)
  }

  // ==================== 内部 ====================

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      for (const res of this.sseClients) res.write(':hb\n\n')
    }, SSE_HEARTBEAT_MS)
  }

  private setStatus(status: WebHostStatus): void {
    this.status = status
    this.onStatus?.(this.getWebStatus())
  }
}

/** 读 JSON 请求体（上限 1MB 防滥用；空体视为 {}） */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('Request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}
