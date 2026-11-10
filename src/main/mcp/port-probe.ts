/**
 * MCP 端口探测与占用者识别原语（计划 §2.3-E 端口策略 Z-1 / stdio 桥接发现链 N-1，§3 S5.2/S5.3）。
 *
 * 三个职责（全部纯 Node、可注入、带超时，绝不无限挂起）：
 * - probeJavamgrServer : 向 127.0.0.1:<port>/mcp 发 MCP initialize，校验响应健康且
 *   serverInfo.name === "javamgr"（命中判定 = 桥接自动发现与残留实例自愈共用的唯一标准；
 *   探到非 javamgr 响应视为"别的进程占用"，跳过/报错，防误连同端口的其他 MCP server）；
 * - findListeningPid   : `netstat -ano -p tcp` 解析 LISTENING 行定位占用端口的 pid；
 * - queryImageName     : `tasklist /FI "PID eq x" /FO CSV /NH` 取占用进程镜像名
 *   （显式报错文案含进程名，A15/R4 演练"端口 7777 被 <进程名> 占用"）；
 * - killPid            : `taskkill /PID x /T /F`（残留实例自愈：杀掉上次崩溃残留的本工具实例）。
 *
 * 命令执行复用 task-killer 的 CommandRunner 风格（spawn + 超时强杀，不拼 shell）。
 */

import { request as httpRequest } from 'node:http'
import type { CommandRunner, RunResult } from '../process/task-killer'
import { realCommandRunner } from '../process/task-killer'

/** 主实例 MCP serverInfo.name（§2.3-E：桥接发现命中判定依赖；tools.ts 构造 server 时同名） */
export const JAVAMGR_SERVER_NAME = 'javamgr'

/** MCP 协议版本（探测 initialize 请求携带；与服务端协商失败时服务端会回落默认版本，不影响健康判定） */
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'

// ---------- MCP initialize 探测（Z-1 ① / N-1 命中判定） ----------

export interface PortProbeResult {
  /** true = 127.0.0.1:port/mcp 健康响应 initialize 且 serverInfo.name === "javamgr" */
  ok: boolean
  /** 对端响应的 serverInfo.name（探到其他 MCP server 时供诊断） */
  serverName?: string
  /** 未命中原因（连接拒绝/超时/非 MCP 响应/名称不符） */
  reason?: string
}

export type PortProbe = (port: number, timeoutMs?: number) => Promise<PortProbeResult>

/** 读取响应体（上限 1MB 防异常对端拖垮探测） */
function readBody(res: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      size += chunk.length
      if (size > 1_048_576) {
        res.destroy()
        reject(new Error('响应体超过 1MB，视为非 MCP 端点'))
        return
      }
      data += chunk
    })
    res.on('end', () => resolve(data))
    res.on('error', reject)
  })
}

/** 从 JSON 体或 SSE 流文本中提取第一条含 serverInfo 的 JSONRPC 响应（兼容两种响应模式的服务端） */
function extractServerName(body: string): string | undefined {
  // ① application/json：直接解析
  try {
    const parsed = JSON.parse(body) as { result?: { serverInfo?: { name?: string } } }
    return parsed.result?.serverInfo?.name
  } catch {
    // ② text/event-stream：取首个 data: 行
    for (const line of body.split(/\r?\n/)) {
      const match = line.match(/^data:\s*(.+)$/)
      if (!match) continue
      try {
        const event = JSON.parse(match[1] as string) as {
          result?: { serverInfo?: { name?: string } }
        }
        if (event.result?.serverInfo?.name !== undefined) return event.result.serverInfo.name
      } catch {
        // 非 JSON data 行（注释/keep-alive）：继续
      }
    }
    return undefined
  }
}

/**
 * 向 127.0.0.1:<port>/mcp 发送 MCP initialize 探测。
 * - 连接拒绝/超时/HTTP 非 200/响应无 serverInfo → {ok:false}（端口空闲或占用者非 MCP）
 * - serverInfo.name === "javamgr" → {ok:true}（本工具主实例/残留实例）
 */
export const probeJavamgrServer: PortProbe = (port, timeoutMs = 3_000) =>
  new Promise<PortProbeResult>((resolve) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'javamgr-port-probe', version: '0.1.0' }
      }
    })
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: timeoutMs
      },
      async (res) => {
        try {
          const text = await readBody(res)
          if (res.statusCode !== 200) {
            resolve({ ok: false, reason: `HTTP ${res.statusCode}` })
            return
          }
          const serverName = extractServerName(text)
          if (serverName === undefined) {
            resolve({ ok: false, reason: '响应不含 MCP serverInfo（非 MCP 端点）' })
            return
          }
          if (serverName === JAVAMGR_SERVER_NAME) {
            resolve({ ok: true, serverName })
          } else {
            resolve({ ok: false, serverName, reason: `其他 MCP server（${serverName}）` })
          }
        } catch (err) {
          resolve({ ok: false, reason: err instanceof Error ? err.message : String(err) })
        }
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
      resolve({ ok: false, reason: '探测超时' })
    })
    req.on('error', (err) => resolve({ ok: false, reason: err.message }))
    req.end(body)
  })

// ---------- netstat / tasklist / taskkill（占用者识别与残留自愈） ----------

/**
 * 定位监听 127.0.0.1:<port>（或任一本地地址 <port>）的 pid。
 * netstat -ano -p tcp 输出行：`TCP    127.0.0.1:7777    0.0.0.0:0    LISTENING    1234`
 * 仅 LISTENING 行计数（TIME_WAIT 等不算占用）；Windows 状态字不本地化。
 * 解析失败/超时返回 undefined（调用方按"占用进程名未知"降级呈现，不阻塞主流程）。
 */
export async function findListeningPid(
  port: number,
  runner: CommandRunner = realCommandRunner
): Promise<number | undefined> {
  const res = await runner.run('netstat', ['-ano', '-p', 'tcp'], 10_000)
  if (res.timedOut) return undefined
  for (const line of res.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)$/i)
    if (!match) continue
    const local = match[1] as string
    if (!local.endsWith(`:${port}`)) continue
    const colon = local.lastIndexOf(':')
    // IPv6 [::1]:7777 场景下 lastIndexOf 仍定位端口段；确保是完整端口而非后缀巧合（:7777 vs :17777）
    if (Number.parseInt(local.slice(colon + 1), 10) !== port) continue
    const pid = Number.parseInt(match[2] as string, 10)
    if (Number.isInteger(pid) && pid > 0) return pid
  }
  return undefined
}

/** tasklist 查 pid 镜像名（CSV 首字段）；进程已消失/查询失败返回 undefined */
export async function queryImageName(
  pid: number,
  runner: CommandRunner = realCommandRunner
): Promise<string | undefined> {
  const res = await runner.run(
    'tasklist',
    ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
    10_000
  )
  if (res.timedOut) return undefined
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.startsWith('"')) continue // locale 提示行（"INFO: ..."）不以此开头
    const fields = line.slice(1, line.endsWith('"') ? -1 : undefined).split('","')
    const image = fields[0] ?? ''
    const listedPid = Number.parseInt(fields[1] ?? '', 10)
    if (image && listedPid === pid) return image
  }
  return undefined
}

/** taskkill /PID x /T /F（杀树）；退出码 0 / 128（不存在）都视为已终止 */
export async function killPid(
  pid: number,
  runner: CommandRunner = realCommandRunner
): Promise<boolean> {
  const res: RunResult = await runner.run(
    'taskkill',
    ['/PID', String(pid), '/T', '/F'],
    15_000
  )
  return res.code === 0 || res.code === 128
}
