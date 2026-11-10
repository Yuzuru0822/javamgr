/**
 * stdio 桥接（计划 §2.3-E stdio 桥接 / §3 S5.3，N-1 发现链 + S-5 通用转发）。
 *
 * `javamgr.exe --mcp-stdio`（开发期 `electron . --mcp-stdio`）进程内运行：
 * Agent 侧经 StdioServerTransport 说 MCP stdio；桥接以 MCP client
 * （StreamableHTTPClientTransport）连主实例 HTTP 通道。
 *
 * **转发 = 完整 JSON-RPC 双向消息流的通用 pipe（含 notification 与 server→client 请求），
 * 不按方法名做白名单**（S-5：消息级转发，零方法路由）。
 *
 * 主实例自动发现链（按序，命中判定 = initialize 成功且 serverInfo.name === "javamgr"）：
 * ① 读 <userData>/mcp.port 端口文件 → 探测校验；
 * ② 失败/缺失/失联 → 7777–7786 递增探测（同校验；探到非 javamgr 响应跳过继续——
 *    递增探测只在桥接内部发现用，不受 HTTP 契约端口"绝不漂移"约束）；
 * ③ 全部失败 → 向 Agent 的 stderr 输出明确错误（主程序未运行/不可达）并以非零码退出，
 *    不挂起等待。
 *
 * Agent 的 stdio 配置不含端口号，永远有效——与 HTTP 通道的固定契约互为兜底（R4）。
 *
 * 本模块零 electron 依赖（userData 经 paths.ts 注入机制或固定推导 %APPDATA%/javamgr）。
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getPaths } from '../config/paths'
import type { PortProbe } from './port-probe'
import { probeJavamgrServer } from './port-probe'

// ---------- 发现失败（index.ts 捕获后 stderr + 非零码退出） ----------

export class BridgeDiscoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeDiscoveryError'
  }
}

// ---------- 桥接默认端口文件 ----------

/**
 * mcp.port 路径：优先现有 paths.ts 注入机制（主进程/测试已 configureUserData）；
 * 未注入（独立桥接进程、无 electron app 对象）时固定推导 `%APPDATA%/javamgr/mcp.port`
 * ——与主进程 app.setName('javamgr') 后的 electron userData 目录名一致，两侧命中同一文件。
 */
export function defaultBridgePortFile(): string {
  try {
    return getPaths().mcpPortFile
  } catch {
    const appData =
      process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'javamgr', 'mcp.port')
  }
}

// ---------- 主实例发现（N-1 自愈链） ----------

export interface DiscoveryOptions {
  /** mcp.port 文件路径（默认 {@link defaultBridgePortFile}） */
  portFile?: string
  /** 递增探测范围（默认 7777–7786） */
  probeFrom?: number
  probeTo?: number
  /** MCP initialize 探测（默认真实 HTTP；测试注入） */
  probe?: PortProbe
  /** 单次探测超时（默认 2000ms；loopback 连接拒绝即时返回，超时只防挂起） */
  probeTimeoutMs?: number
}

/** 发现主实例端口；全部失败抛 {@link BridgeDiscoveryError}（含逐项失败原因，stderr 直呈 Agent）。 */
export async function discoverMainInstancePort(opts: DiscoveryOptions = {}): Promise<number> {
  const probe = opts.probe ?? probeJavamgrServer
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2_000
  const failures: string[] = []

  // ① mcp.port 文件优先
  const portFile = opts.portFile ?? defaultBridgePortFile()
  try {
    const raw = await readFile(portFile, 'utf8')
    const port = Number.parseInt(raw.trim(), 10)
    if (Number.isInteger(port) && port > 0 && port <= 65_535) {
      const result = await probe(port, probeTimeoutMs)
      if (result.ok) return port
      failures.push(`mcp.port 指向 ${port} 但校验未命中（${result.reason ?? '未知原因'}）`)
    } else {
      failures.push(`mcp.port 内容无效（${raw.trim().slice(0, 40)}）`)
    }
  } catch {
    failures.push(`mcp.port 读取失败（${portFile}，主程序可能未运行过）`)
  }

  // ② 递增探测 7777–7786（同校验；非 javamgr 响应跳过继续）
  const from = opts.probeFrom ?? 7_777
  const to = opts.probeTo ?? 7_786
  for (let port = from; port <= to; port++) {
    const result = await probe(port, probeTimeoutMs)
    if (result.ok) return port
    if (result.serverName !== undefined) {
      failures.push(`${port} 端口上是其他 MCP server（${result.serverName}），已跳过`)
    }
  }

  throw new BridgeDiscoveryError(
    `未能发现 javamgr 主实例：主程序未运行或不可达（已尝试 ${portFile} 与端口 ${from}–${to} 递增探测）。` +
      `请先启动 javamgr 主程序后重试。失败明细：${failures.join('；')}`
  )
}

// ---------- stdio ↔ HTTP 通用转发（S-5：消息级 pipe） ----------

export interface BridgeOptions extends DiscoveryOptions {
  /** Agent 侧 stdio 输入（默认 process.stdin；测试注入 PassThrough） */
  stdin?: Readable
  /** Agent 侧 stdio 输出（默认 process.stdout；测试注入 PassThrough） */
  stdout?: Writable
  /** 诊断输出通道（默认 console.error → stderr；绝不写入 stdout——stdout 专用于 MCP 消息） */
  log?: (message: string) => void
}

/**
 * 运行桥接：发现主实例 → 双 transport 消息级 pipe，直至任一侧关闭。
 * 发现失败抛 {@link BridgeDiscoveryError}（调用方 stderr + 非零码退出，不挂起）。
 */
export async function runBridge(opts: BridgeOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? process.stdin
  const stdout = opts.stdout ?? process.stdout
  const log = opts.log ?? ((message: string) => console.error(message))
  const port = await discoverMainInstancePort(opts)

  const client = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
  const stdio = new StdioServerTransport(stdin, stdout)

  let closed = false
  let resolveClosed: () => void = () => undefined
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  const closeAll = (): void => {
    if (closed) return
    closed = true
    void client
      .close()
      .catch(() => undefined)
      .then(() => stdio.close().catch(() => undefined))
      .then(() => resolveClosed())
  }

  // 完整 JSON-RPC 双向流通用转发：Agent → 主实例（请求/notification/response 均透传）
  stdio.onmessage = (message) => {
    void client.send(message).catch((err: unknown) => {
      log(`[mcp-bridge] 转发至主实例失败：${err instanceof Error ? err.message : String(err)}`)
      closeAll()
    })
  }
  // 主实例 → Agent（响应/notification/server→client 请求均透传）
  client.onmessage = (message) => {
    void stdio.send(message).catch((err: unknown) => {
      log(`[mcp-bridge] 转发至 Agent 失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }
  stdio.onerror = (err: Error) => log(`[mcp-bridge] stdio 错误：${err.message}`)
  client.onerror = (err: Error) => log(`[mcp-bridge] HTTP 通道错误：${err.message}`)
  stdio.onclose = () => closeAll()
  client.onclose = () => closeAll()
  // StdioServerTransport 只监听 data/error，不监听 stdin EOF——Agent 关闭 stdin 时
  // 必须自行感知（否则桥接进程挂着不退出，违反"不挂起"约束）
  stdin.on('end', () => closeAll())
  stdin.on('close', () => closeAll())
  stdin.on('error', (err: Error) => {
    log(`[mcp-bridge] stdin 错误：${err.message}`)
    closeAll()
  })

  await stdio.start()
  await client.start()
  log(`[mcp-bridge] 已连接主实例 http://127.0.0.1:${port}/mcp（stdio 双向转发中）`)

  await closedPromise
}
