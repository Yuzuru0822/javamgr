/**
 * Windows 进程终止与存活探测原语（计划 §2.3-A / §3 S3.1，风险 R1/R6 缓解）。
 *
 * == WMI 病态宿主适配（2026-11-09 缺陷修复） ==
 * 现场结论：WMI 病态期 `Get-CimInstance` 挂死 >90s、`taskkill /T /F` 对无子进程目标
 * 需 61.6s 才返回；而 PSAPI 路径（`Get-Process` 全量 112ms）与 `Stop-Process -Force`
 * （TerminateProcess 直达）全程健康。因此：
 * - 主终止引擎退役 taskkill：单次 PowerShell 调用完成「CIM 枚举后代（带
 *   -OperationTimeoutSec 内层超时 + 枚举墙钟预算）+ 批量 Stop-Process」；
 *   整个调用外层硬超时 3s，超时必杀助手本身并降级为只杀主进程（degraded 标志）；
 * - 存活探测退役 tasklist：`process.kill(pid, 0)`（零 spawn、零 WMI）承担存在性
 *   判定；需要镜像名/启动时间时一次 `Get-Process -Id a,b,c`（PSAPI，病态期可用）；
 * - 杀后确认用 `process.kill(pid, 0)` 以 500ms 间隔轮询至 stopTimeoutMs 预算耗尽，
 *   仍存活补一次 Stop-Process，再不行报错（含最后错误）。
 *
 * 可测试性：本模块零 electron 依赖；CommandRunner 与探活/休眠可注入（vitest mock
 * 掉 powershell 与 kill0，进程语义在集成测试用真实命令验证）。
 */

import { spawn } from 'node:child_process'

// ---------- 命令执行基建（全部 spawn 带超时保护，超时必杀助手） ----------

export interface RunResult {
  /** 进程退出码（被超时强杀时为 null） */
  code: number | null
  stdout: string
  stderr: string
  /** 命令超时被终止 */
  timedOut: boolean
}

export interface CommandRunner {
  /** 执行一条命令；timeoutMs 到期强杀并返回 timedOut（绝不无限挂起） */
  run(file: string, args: string[], timeoutMs: number): Promise<RunResult>
}

/** 默认 runner：真实 spawn。windowsHide 避免闪烁控制台窗口；输出按 UTF-8 解码。 */
export const realCommandRunner: CommandRunner = {
  run(file, args, timeoutMs) {
    return new Promise<RunResult>((resolve) => {
      let child
      try {
        child = spawn(file, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (err) {
        resolve({ code: null, stdout: '', stderr: String(err), timedOut: false })
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      let killer: NodeJS.Timeout | undefined

      const finish = (result: RunResult): void => {
        if (settled) return
        settled = true
        if (killer) clearTimeout(killer)
        resolve(result)
      }

      killer = setTimeout(() => {
        // 超时必杀助手本身（防僵尸 powershell/conhost 堆积——病态期挂死助手的根源）
        child.kill()
        finish({ code: null, stdout, stderr, timedOut: true })
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (err) => {
        // spawn 失败（命令不存在等）：并入 stderr 文本，code=null（与超时区分：timedOut=false）
        finish({ code: null, stdout, stderr: `${stderr}\n${String(err)}`.trim(), timedOut: false })
      })
      child.on('close', (code) => {
        finish({ code, stdout, stderr, timedOut: false })
      })
    })
  }
}

// ---------- 零 spawn 存在性探测（process.kill(pid, 0)，无 WMI/无子进程） ----------

/**
 * kill0 探活：Windows 下 OpenProcess 存在性检查的 Node 映射。
 * 三态语义：存在 → true；ESRCH（进程不存在）→ false；EPERM/EACCES（存在但无权限，
 * 如受保护进程）→ true（存活）。绝不抛错。
 */
export function probeAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

// ---------- PowerShell 助手（统一 spawn 契约：-NoProfile + windowsHide + 超时必杀） ----------

/** 单次树终止调用（枚举+批量杀）的外层硬超时 */
export const PS_KILL_HARD_CAP_MS = 3_000
/** 后代枚举墙钟预算（脚本内 between-query 检查；健康宿主够走多层，病态宿主 1 次失败查询即止） */
export const PS_WALK_BUDGET_MS = 1_000
/** 降级/补杀单点 Stop-Process 调用超时 */
export const PS_DEGRADED_CAP_MS = 2_000
/** 单点/批量 Get-Process 查询超时（病态宿主 Get-Process 健康，2.5s 足够） */
export const PS_QUERY_TIMEOUT_MS = 2_500

/** Get-CimInstance 单查询内层超时（秒）：病态期单次失败成本 ≈ 1.5s，保证首调用 3s 内收敛 */
const CIM_OP_TIMEOUT_SEC = 1
/** 后代枚举最大深度（防父链 pid 复用成环） */
const WALK_MAX_DEPTH = 8

/** 统一 PowerShell 执行入口（超时由 runner 强杀助手，绝不挂死堆积） */
function runPowerShell(cmd: string, timeoutMs: number, runner: CommandRunner): Promise<RunResult> {
  return runner.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], timeoutMs)
}

// ---------- Get-Process 行协议（`pid|ProcessName|ISO-StartTime`，PSAPI 非 WMI） ----------

/**
 * 镜像/进程名匹配 java*：Get-Process 的 ProcessName 无 .exe 后缀（"java"/"javaw"），
 * tasklist 镜像名带 .exe（历史兼容）；两者统一按去掉 .exe 后前缀匹配。
 */
export function matchesJavaName(name: string): boolean {
  return name.toLowerCase().replace(/\.exe$/, '').startsWith('java')
}

/** 历史别名（旧 tasklist 语义名） */
export const isJavaImage = matchesJavaName

export interface ProcessSnapshot {
  /** ProcessName（无 .exe 后缀，如 "java"） */
  name: string
  /** 创建时间 epoch ms；受保护进程不可访问时缺省 */
  startTime?: number
}

/** 解析 `pid|name|iso` 行（坏行跳过） */
function parseProcessLines(stdout: string): Array<{ pid: number; name: string; startTime?: number }> {
  const out: Array<{ pid: number; name: string; startTime?: number }> = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^(\d+)\|([^|]*)\|(.*)$/)
    if (!m) continue
    const pid = Number.parseInt(m[1] ?? '', 10)
    const name = (m[2] ?? '').trim()
    if (!Number.isInteger(pid) || !name) continue
    const raw = (m[3] ?? '').trim()
    if (raw === '') {
      out.push({ pid, name })
    } else {
      const ts = Date.parse(raw)
      out.push({ pid, name, ...(Number.isFinite(ts) ? { startTime: ts } : {}) })
    }
  }
  return out
}

/** 批量 Get-Process 查询脚本（-Id 平铺逗号列表由 PowerShell 解析为数组字面量） */
function buildBatchQueryScript(pids: number[]): string {
  return (
    `Get-Process -Id ${[...new Set(pids)].join(',')} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { $s=''; try { $s=$_.StartTime.ToString('o') } catch {}; ` +
    `"$($_.Id)|$($_.ProcessName)|$s" }`
  )
}

// ---------- 任务操作集（注入 runner 可替换，默认真实命令） ----------

export interface AliveInfo {
  alive: boolean
  /** Get-Process 报告的进程名（无 .exe 后缀；alive 时存在） */
  image?: string
}

export interface KillResult {
  ok: boolean
  /** 从发起终止到确认死亡（或超时/失败）的耗时 ms */
  durationMs: number
  error?: string
  /** true = WMI 后代枚举不可用（病态宿主降级），仅终止了主进程，子进程可能残留 */
  degraded?: boolean
  /** 降级说明（degraded=true 时存在） */
  degradedReason?: string
}

export interface TaskOps {
  /** 零 spawn kill0 存在性初筛（process.kill(pid,0) 三态映射，同步） */
  probeAlive(pid: number): boolean
  /**
   * 单点存活探测：先 kill0（零 spawn）；requireJavaImage=true 时再一次 Get-Process
   * 校验进程名 java*（R6：仅 PID 存在不构成存活）。查询超时按「存在但未验证」保守存活。
   */
  isAlive(pid: number, opts?: { requireJavaImage?: boolean }): Promise<AliveInfo>
  /**
   * 批量进程查询：一次 Get-Process 取 pid → {name, startTime}（N-2/N-3：批量单次
   * spawn；StartTime 供 PID 重用比对）。
   * 返回 null = 查询超时/失败（未验证）——调用方不得据此判死。
   */
  batchQueryProcesses(pids: number[]): Promise<Map<number, ProcessSnapshot> | null>
  /**
   * 杀进程树（主终止引擎）：
   * ① 单次 PowerShell：CIM 枚举后代（-OperationTimeoutSec 内层超时 + 枚举预算）+
   *    批量 Stop-Process（先子后主），外层硬超时 3s，超时杀助手；
   * ② ①超时 → 降级：第二次调用只 Stop-Process 主 pid（2s 超时，同样超时杀助手），
   *    结果带 degraded:true 与说明；
   * ③ 杀后确认：kill0 探活，500ms 间隔重试至 stopTimeoutMs 预算耗尽；仍活 → 补一次
   *    Stop-Process → 再不行报错（含最后错误）。
   */
  killTree(pid: number, timeoutMs?: number): Promise<KillResult>
}

/** 树终止脚本：枚举后代 + 批量 Stop-Process（先子后主）；输出 WALK/TREE/MAIN 标记行 */
function buildTreeKillScript(mainPid: number, walkBudgetMs: number): string {
  return [
    `$main = ${mainPid}`,
    `$deadline = [DateTime]::UtcNow.AddMilliseconds(${Math.max(0, Math.round(walkBudgetMs))})`,
    `$all = New-Object 'System.Collections.Generic.HashSet[int]'`,
    `[void]$all.Add($main)`,
    `$queue = @($main)`,
    `$depth = 0`,
    `$walkFailed = $false`,
    `while ($queue.Count -gt 0 -and $depth -lt ${WALK_MAX_DEPTH} -and [DateTime]::UtcNow -lt $deadline) {`,
    `  $next = @()`,
    `  foreach ($id in $queue) {`,
    `    try {`,
    `      $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -OperationTimeoutSec ${CIM_OP_TIMEOUT_SEC} -ErrorAction Stop`,
    `      foreach ($k in $kids) { $cpid = [int]$k.ProcessId; if ($cpid -gt 0 -and $all.Add($cpid)) { $next += $cpid } }`,
    `    } catch { $walkFailed = $true }`,
    `  }`,
    `  $queue = $next`,
    `  $depth++`,
    `}`,
    `foreach ($c in @($all | Where-Object { $_ -ne $main })) { try { Stop-Process -Id $c -Force -ErrorAction Stop } catch { } }`,
    `$mainStatus = 'OK'`,
    `try { Stop-Process -Id $main -Force -ErrorAction Stop } catch {`,
    `  try { Get-Process -Id $main -ErrorAction Stop | Out-Null; $mainStatus = 'ERR' } catch { }`,
    `}`,
    `if ($walkFailed) { Write-Output 'WALK=DEGRADED' } else { Write-Output 'WALK=OK' }`,
    `Write-Output ("TREE=" + (@($all) -join ','))`,
    `Write-Output ("MAIN=" + $mainStatus)`
  ].join('\n')
}

/** 单点终止脚本（降级/补杀）：只 Stop-Process 主 pid；输出 MAIN 标记行 */
function buildMainKillScript(mainPid: number): string {
  return [
    `$main = ${mainPid}`,
    `$mainStatus = 'OK'`,
    `try { Stop-Process -Id $main -Force -ErrorAction Stop } catch {`,
    `  try { Get-Process -Id $main -ErrorAction Stop | Out-Null; $mainStatus = 'ERR' } catch { }`,
    `}`,
    `Write-Output ("MAIN=" + $mainStatus)`
  ].join('\n')
}

/** 解析 WALK=/TREE=/MAIN= 标记行 */
function parseKillMarkers(stdout: string): { walk?: 'OK' | 'DEGRADED'; main?: 'OK' | 'ERR' } {
  const markers: { walk?: 'OK' | 'DEGRADED'; main?: 'OK' | 'ERR' } = {}
  for (const line of stdout.split(/\r?\n/)) {
    if (line === 'WALK=OK') markers.walk = 'OK'
    else if (line === 'WALK=DEGRADED') markers.walk = 'DEGRADED'
    else if (line === 'MAIN=OK') markers.main = 'OK'
    else if (line === 'MAIN=ERR') markers.main = 'ERR'
  }
  return markers
}

export interface TaskOpsOptions {
  /** kill0 注入（单测控制确认轮询的三态） */
  probe?: (pid: number) => boolean
  /** 休眠注入（单测免等待） */
  sleep?: (ms: number) => Promise<void>
}

export function createTaskOps(
  runner: CommandRunner = realCommandRunner,
  opts: TaskOpsOptions = {}
): TaskOps {
  const probe = opts.probe ?? probeAlive
  const sleep =
    opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))

  const isAlive = async (
    pid: number,
    opts2?: { requireJavaImage?: boolean }
  ): Promise<AliveInfo> => {
    if (!probe(pid)) return { alive: false }
    if (!opts2?.requireJavaImage) return { alive: true }
    const res = await runPowerShell(
      buildBatchQueryScript([pid]),
      PS_QUERY_TIMEOUT_MS,
      runner
    )
    if (res.timedOut) return { alive: true } // 存在已确认；名称未验证 → 保守存活
    for (const p of parseProcessLines(res.stdout)) {
      if (p.pid === pid) {
        return matchesJavaName(p.name) ? { alive: true, image: p.name } : { alive: false, image: p.name }
      }
    }
    return { alive: false } // kill0 与查询之间死亡（竞态）
  }

  const batchQueryProcesses = async (
    pids: number[]
  ): Promise<Map<number, ProcessSnapshot> | null> => {
    if (pids.length === 0) return new Map()
    const res = await runPowerShell(buildBatchQueryScript(pids), PS_QUERY_TIMEOUT_MS, runner)
    if (res.timedOut) return null
    const map = new Map<number, ProcessSnapshot>()
    for (const p of parseProcessLines(res.stdout)) {
      map.set(p.pid, { name: p.name, ...(p.startTime !== undefined ? { startTime: p.startTime } : {}) })
    }
    return map
  }

  const killTree = async (pid: number, timeoutMs = 8_000): Promise<KillResult> => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, durationMs: 0, error: `无效 PID：${pid}` }
    }
    const startedAt = Date.now()
    const remaining = (): number => timeoutMs - (Date.now() - startedAt)

    let degraded = false
    let degradedReason: string | undefined
    let lastError: string | undefined

    // ① 主终止引擎：枚举后代 + 批量 Stop-Process（外层硬超时 3s）
    const hardCap = Math.min(PS_KILL_HARD_CAP_MS, Math.max(200, timeoutMs))
    const walkBudget = Math.max(0, Math.min(PS_WALK_BUDGET_MS, hardCap - 2_000))
    const res1 = await runPowerShell(buildTreeKillScript(pid, walkBudget), hardCap, runner)
    if (res1.timedOut) {
      // ② 降级：助手已被 runner 杀掉；第二次调用只杀主进程（2s 超时，同样超时杀助手）
      degraded = true
      degradedReason = 'WMI 子进程枚举不可用（PowerShell 助手超时被终止），仅终止主进程'
      const cap2 = Math.max(200, Math.min(PS_DEGRADED_CAP_MS, remaining()))
      const res2 = await runPowerShell(buildMainKillScript(pid), cap2, runner)
      if (res2.timedOut) {
        degradedReason = `${degradedReason}；主进程终止调用亦超时（${cap2}ms）`
        lastError = degradedReason
      } else if (parseKillMarkers(res2.stdout).main === 'ERR') {
        lastError = 'Stop-Process 无法终止主进程（权限不足或受保护进程）'
      }
    } else {
      const markers = parseKillMarkers(res1.stdout)
      if (markers.walk === 'DEGRADED') {
        degraded = true
        degradedReason = 'WMI 子进程枚举不可用，仅终止主进程'
      }
      if (markers.main === 'ERR') {
        lastError = 'Stop-Process 无法终止主进程（权限不足或受保护进程）'
      }
    }

    // ③ 杀后确认：kill0 探活（零 spawn），500ms 间隔重试；预留降级上限的尾部预算给补杀
    while (probe(pid) && remaining() > PS_DEGRADED_CAP_MS) {
      await sleep(Math.min(500, Math.max(1, remaining() - PS_DEGRADED_CAP_MS)))
    }
    if (!probe(pid)) {
      return {
        ok: true,
        durationMs: Date.now() - startedAt,
        ...(degraded ? { degraded: true, degradedReason } : {})
      }
    }

    // 仍存活：补一次 Stop-Process（单点，尾部预算内 2s 超时）再确认
    if (remaining() > 0) {
      const cap3 = Math.max(200, Math.min(PS_DEGRADED_CAP_MS, remaining()))
      await runPowerShell(buildMainKillScript(pid), cap3, runner)
      const deadline = startedAt + timeoutMs
      while (probe(pid) && Date.now() < deadline) {
        await sleep(Math.min(500, Math.max(1, deadline - Date.now())))
      }
      if (!probe(pid)) {
        return {
          ok: true,
          durationMs: Date.now() - startedAt,
          ...(degraded ? { degraded: true, degradedReason } : {})
        }
      }
    }

    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: `进程 ${pid} 在 ${timeoutMs}ms 内未能终止${lastError !== undefined ? `（${lastError}）` : ''}`,
      ...(degraded ? { degraded: true, degradedReason } : {})
    }
  }

  return { probeAlive: probe, isAlive, batchQueryProcesses, killTree }
}
