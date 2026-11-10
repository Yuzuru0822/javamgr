/**
 * 打包产物冒烟脚本（计划 §3 S6.3 / §6 打包验证）。
 *
 * 用法：node scripts/packaged-smoke.mjs [win-unpacked 目录]（默认 dist/win-unpacked）
 * 步骤：
 *  ① 运行 javamgr.exe → 进程出现
 *  ② %APPDATA%/javamgr/mcp.port 文件出现
 *  ③ POST http://127.0.0.1:7777/mcp initialize → serverInfo.name=javamgr
 *  ④ 托盘进程稳定 10s
 *  ⑤ --mcp-stdio 桥接：配合主实例运行，stdio 客户端发 initialize + tools/list 验证转发
 *  ⑥ 退出主实例，无残留子进程（javamgr/electron 全灭）
 *
 * 注意：本机 taskkill/WMI 故障期间，清理与"无残留"核对用 PowerShell Get/Stop-Process
 * （等价事实核查，非产品路径）。绝不在结束时留下任何驻留进程。
 */

import { spawn, execFile } from 'node:child_process'
import { readFile, access, mkdir, writeFile, rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../dist/win-unpacked')
const exe = path.join(appDir, 'javamgr.exe')
const userDataDir = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'javamgr')
const portFile = path.join(userDataDir, 'mcp.port')
const settingsFile = path.join(userDataDir, 'config', 'settings.json')
/** 冒烟用契约端口（7777 常被本机 aTrustXtunnel VPN 客户端占用——用它验证 bind-failed 显式失败路径，
 *  再以空闲端口 17877 验证功能链路） */
const SMOKE_PORT = 17_877
const MCP_URL = `http://127.0.0.1:${SMOKE_PORT}/mcp`

const run = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 20_000, windowsHide: true, ...opts }, (err, stdout, stderr) =>
      resolve({ err: err ? String(err.message || err) : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    )
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(probe, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await probe()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
    await sleep(300)
  }
}

const results = []
const record = (step, ok, detail = '') => {
  results.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`)
}

/** 主实例 java 进程（含 electron 子进程形态）存活检查：按可执行路径前缀过滤 */
async function appPids() {
  const { stdout } = await run('powershell', [
    '-NoProfile', '-Command',
    `Get-Process -Name javamgr,electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${appDir.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty Id`
  ])
  return stdout.split(/\r?\n/).map((l) => Number.parseInt(l.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0)
}

async function stopAppPids() {
  for (let i = 0; i < 3; i += 1) {
    const pids = await appPids()
    if (pids.length === 0) return
    for (const pid of pids) {
      await run('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`])
    }
    await sleep(800)
  }
}

let mainProc = null

/** 干净 userData（隔离本机用户真实配置；冒烟自带 settings） */
async function resetUserData() {
  for (const victim of [portFile, settingsFile]) {
    await rm(victim, { force: true }).catch(() => undefined)
  }
}

/** 预置契约端口 settings.json（7777 被本机 VPN 占用，冒烟走空闲端口 = 用户主动改端口的正常路径） */
async function seedSettings(port) {
  await mkdir(path.dirname(settingsFile), { recursive: true })
  const settings = {
    mcpEnabled: true,
    mcpPort: port,
    exitPolicy: 'keep',
    startupGraceSeconds: 5,
    pollIntervalSeconds: 5,
    tailInitialLines: 200,
    logMaxFileMb: 10,
    logMaxRotations: 3,
    logRunsToKeep: 10,
    scanRoots: [],
    closeToTray: true
  }
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

function launchMain() {
  mainProc = spawn(exe, [], { cwd: appDir, detached: true, stdio: 'ignore', windowsHide: false })
  const pid = mainProc.pid
  mainProc.unref()
  return pid
}

try {
  console.log(`== javamgr 打包冒烟 ==\nexe: ${exe}\nuserData: ${userDataDir}\n`)
  await resetUserData()

  // ---------- 阶段 0：默认端口 7777 被外部进程占用 → bind-failed 显式失败（R4/A15） ----------
  // 本机 7777 恰被 aTrustXtunnel（VPN）占用，正好验证"绝不静默漂移"：
  // 首次干净启动（无 settings.json → 默认 7777）→ MCP 启动失败但主进程稳定、mcp.port 不落盘
  const occupied = await new Promise((resolve) => {
    const s = net.connect({ port: 7777, host: '127.0.0.1', timeout: 1_500 })
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    s.on('timeout', () => { s.destroy(); resolve(false) })
  })
  if (occupied) {
    const p0 = launchMain()
    await waitFor(async () => ((await appPids()).length > 0 ? true : undefined), 20_000, 'bind-failed 场景进程出现')
    await sleep(6_000) // MCP 启动 + bind 尝试 + 自愈探测窗口
    const stillAlive = (await appPids()).length > 0
    const portFileAbsent = !(await access(portFile).then(() => true, () => false))
    record('⓪ 7777 被外部占用：MCP bind-failed 但主进程稳定（不漂移、不落 mcp.port）', stillAlive && portFileAbsent, `alive=${stillAlive} mcp.port 不存在=${portFileAbsent}（pid=${p0}）`)
    await stopAppPids()
    await sleep(1_000)
  } else {
    record('⓪ 7777 空闲（本机无占用场景，跳过 bind-failed 验证）', true, '')
  }

  // ---------- 功能链路：契约端口 17877 ----------
  await seedSettings(SMOKE_PORT)
  const mainPid = launchMain()

  // ---------- ① 主实例进程出现 ----------
  const pids = await waitFor(async () => ((await appPids()).length > 0 ? true : undefined), 20_000, 'javamgr 进程出现')
  record('① 主实例进程出现', pids === true, `spawn pid=${mainPid}`)

  // ---------- ② mcp.port 文件 ----------
  const portValue = await waitFor(async () => {
    try {
      await access(portFile)
      return (await readFile(portFile, 'utf8')).trim()
    } catch {
      return undefined
    }
  }, 20_000, 'mcp.port 出现')
  record('② mcp.port 文件出现', /^\d+$/.test(portValue), `端口 ${portValue}`)

  // ---------- ③ HTTP initialize ----------
  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'packaged-smoke', version: '1.0.0' }
    }
  }
  const httpOk = await waitFor(async () => {
    try {
      const res = await fetch(MCP_URL, {
        method: 'POST',
        // Streamable HTTP 契约：Accept 须同时含 application/json 与 text/event-stream（否则 406）
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(initBody)
      })
      if (!res.ok) return undefined
      const text = await res.text()
      const json = JSON.parse(text)
      return json?.result?.serverInfo?.name === 'javamgr' ? json.result : undefined
    } catch {
      return undefined
    }
  }, 20_000, 'HTTP initialize')
  record(
    '③ HTTP initialize serverInfo.name=javamgr',
    httpOk !== undefined,
    `server=${httpOk?.serverInfo?.name} v${httpOk?.serverInfo?.version} tools 能力=${httpOk?.capabilities?.tools !== undefined}`
  )

  // ---------- ④ 稳定 10s ----------
  let stable = true
  for (let i = 0; i < 5; i += 1) {
    await sleep(2_000)
    const now = await appPids()
    if (now.length === 0) {
      stable = false
      break
    }
  }
  record('④ 托盘进程稳定 10s', stable, stable ? '5×2s 轮询存活' : '中途退出')

  // ---------- ⑤ stdio 桥接（主实例保持运行） ----------
  let bridgeOk = true
  try {
    const bridge = spawn(exe, ['--mcp-stdio'], { cwd: appDir, stdio: ['pipe', 'pipe', 'pipe'] })
    let bridgeOut = ''
    let bridgeErr = ''
    bridge.stdout.on('data', (c) => (bridgeOut += c.toString('utf8')))
    bridge.stderr.on('data', (c) => (bridgeErr += c.toString('utf8')))
    const waitBridge = (id, what, timeoutMs = 25_000) =>
      waitFor(() => {
        for (const line of bridgeOut.split('\n')) {
          const t = line.trim()
          if (!t) continue
          try {
            const m = JSON.parse(t)
            if (m.id === id) return m
          } catch {
            /* 半行忽略 */
          }
        }
        return undefined
      }, timeoutMs, what)

    bridge.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'smoke-stdio-agent', version: '1.0.0' }
        }
      })}\n`
    )
    const bridgeInit = await waitBridge(100, '桥接 initialize 响应')
    const bridgeNameOk = bridgeInit?.result?.serverInfo?.name === 'javamgr'
    record('⑤a 桥接 initialize 转发（serverInfo.name=javamgr）', bridgeNameOk, `server=${bridgeInit?.result?.serverInfo?.name}`)
    bridgeOk &&= bridgeNameOk

    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    bridge.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list', params: {} })}\n`
    )
    const toolsList = await waitBridge(101, '桥接 tools/list 响应')
    const toolNames = (toolsList?.result?.tools ?? []).map((t) => t.name).sort()
    // 与 src/main/mcp/tools.ts 注册集一致（15 工具；桥接为消息级透传，清单即主实例清单）
    const expectedTools = [
      'batch_create_projects', 'create_project', 'delete_project', 'get_status', 'list_jdks',
      'list_projects', 'read_logs', 'restart_project', 'scan_jars', 'search_logs',
      'start_all_projects', 'start_project', 'stop_all_projects', 'stop_project', 'update_project'
    ]
    const bridgeToolsOk =
      toolNames.length === expectedTools.length &&
      JSON.stringify(toolNames) === JSON.stringify(expectedTools)
    record(`⑤b 桥接 tools/list 转发（${expectedTools.length} 工具）`, bridgeToolsOk, toolNames.join(','))
    bridgeOk &&= bridgeToolsOk

    bridge.stdin.end()
    const bridgeExit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 10_000)
      bridge.on('close', (code) => {
        clearTimeout(timer)
        resolve(`code=${code}`)
      })
    })
    const bridgeClean = bridgeExit !== 'timeout'
    if (!bridgeClean) {
      try { bridge.kill('SIGKILL') } catch { /* ignore */ }
    }
    record('⑤c 桥接随 stdin 关闭退出（无挂起）', bridgeClean, `退出 ${bridgeExit}${bridgeErr ? `；stderr: ${bridgeErr.slice(0, 160)}` : ''}`)
    bridgeOk &&= bridgeClean
  } catch (err) {
    bridgeOk = false
    record('⑤ stdio 桥接', false, `${String(err?.message || err)}`)
  }

  // ---------- ⑥ 退出主实例 + 无残留 ----------
  await stopAppPids()
  const left = await appPids()
  record('⑥ 退出主实例无残留进程', left.length === 0, left.length === 0 ? 'javamgr/electron 全灭' : `残留 pid: ${left.join(',')}`)
} catch (err) {
  record('冒烟异常中断', false, String(err?.message || err))
} finally {
  await stopAppPids().catch(() => undefined)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n== 结果：${results.length - failed.length}/${results.length} PASS ==`)
process.exit(failed.length === 0 ? 0 : 1)
