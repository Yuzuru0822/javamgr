import { app, BrowserWindow, Tray } from 'electron'
import path from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { configureUserData, ensureDirs, getPaths } from './config/paths'
import { ConfigStore, CONFIG_EVENTS } from './config/config-store'
import { broadcastEvent, registerIpcHandlers } from './ipc/ipc-registry'
import { DEFAULT_SCAN_ROOTS, mergeJdks, scanJdks } from './jdk/jdk-scanner'
import { ProcessManager } from './process/process-manager'
import { LogManager } from './log/log-manager'
import { McpHost } from './mcp/mcp-host'
import { runBridge } from './mcp/run-bridge'
import { prepareExit } from './lifecycle'
import { createTray, mcpTrayTooltip } from './tray'
import { EventLoopMonitor } from './telemetry/event-loop-monitor'
import { IPC_EVENTS } from '../shared/ipc-channels'
import type { Settings } from '../shared/types'

/**
 * 主进程入口。
 * S1：userData 三区规划（config/ logs/ + runs.json + mcp.port）、config-store
 * （内存缓存 + 变更即写 + 损坏备份重建）、§2.5 全通道 IPC 注册。
 * S2：jdks.json 为空时（首次使用）启动即后台自动扫描一次（静默入库不弹窗）。
 * S3：进程管理核心装配——构造 process-manager（状态机 + projectId 操作队列 +
 * pid-registry 轮询池）→ 启动重识别 → 托盘 → 退出策略挂接 before-quit。
 * S4：日志系统装配——log-manager（file|stdout 路由 + log:appended 批量推送 +
 * readHistory/search）经 setLogHooks 接 run:started 句柄交付；proc:statusChanged
 * 广播同时喂给 log-manager（终态 flush 残行/关闭 tailer）；重识别 RUNNING 的
 * file 路项目续接 tail（stdout 路无管道，仅历史可查——ADR 已知限制 1）。
 * S5：argv 分流（--mcp-stdio 跳过单实例锁与窗口，走 stdio 桥接）+ mcp-host 装配
 * （契约端口 Z-1）+ settings 变更重启（用户改端口 = 主动重签契约，广播 user-changed）。
 *
 * app.setName('javamgr')：统一主/桥接两模式的 userData 目录名（%APPDATA%/javamgr），
 * 桥接进程无 app.getPath 依赖时按同一名字固定推导（run-bridge.defaultBridgePortFile）。
 */

app.setName('javamgr')

// ==================== S5：stdio 桥接模式（最先分流，跳过单实例锁/窗口/托盘） ====================

/** 桥接模式：发现主实例 → stdio↔HTTP 双向转发；失败 stderr + 非零码退出，不挂起（§2.3-E） */
async function runBridgeMode(): Promise<void> {
  try {
    await runBridge({
      // S6 打包冒烟发现的现实约束：打包后的 javamgr.exe 是 GUI 子系统应用，Electron
      // 初始化后 process.stdin 管道句柄不可读（立即触发 close → 桥接误判 Agent 断开
      // 而退出）。经 fd 0/1 原生流直读直写（开发期 electron . 与打包形态一致可用；
      // 提供 fd 选项时 path 参数被忽略，空串仅为满足签名）
      stdin: createReadStream('', { fd: 0 }),
      stdout: createWriteStream('', { fd: 1 })
    }) // 解析 = Agent 关闭 stdio（正常收尾）
    await new Promise((r) => setTimeout(r, 100)) // stdout 排空窗口
    app.exit(0)
  } catch (err) {
    // 发现链全部失败：stderr 明确错误（主程序未运行/不可达）+ 非零码退出
    console.error(err instanceof Error ? err.message : String(err))
    app.exit(1)
  }
}

if (process.argv.includes('--mcp-stdio')) {
  void runBridgeMode()
} else {
  startMainMode()
}

// ==================== 主模式（GUI + 进程管理 + MCP 宿主） ====================

/**
 * 首次使用自动扫描（计划 §3 S2.3）：结果静默入库，不弹窗、不推进度事件；
 * 打开 JDK 页自然可见（JdkView 挂载时拉取列表）。失败仅记日志，不影响启动。
 */
async function autoScanJdksOnFirstUse(store: ConfigStore): Promise<void> {
  try {
    const settings = store.getSettings()
    const scanned = await scanJdks({
      roots: [...DEFAULT_SCAN_ROOTS, ...settings.scanRoots]
    })
    if (scanned.length === 0) return
    const merged = mergeJdks(store.listJdks(), scanned)
    await store.replaceJdks(merged)
    console.log(`[jdk-scanner] 首次使用自动扫描完成：发现 ${scanned.length} 个 JDK，已静默入库`)
  } catch (err) {
    console.warn('[jdk-scanner] 首次使用自动扫描失败（不影响启动，可在 JDK 页手动扫描）：', err)
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // 关闭到托盘（settings.closeToTray）：关窗口不退出，程序驻留托盘；退出统一走托盘菜单
  win.on('close', (event) => {
    if (!isQuitting && storeRef?.getSettings().closeToTray) {
      event.preventDefault()
      win.hide()
    }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// close 守卫需要访问 store（whenReady 后赋值；此前不会有窗口 close 事件）
let storeRef: ConfigStore | undefined
/** before-quit 已进入退出流程（此时窗口 close 不再拦截到托盘） */
let isQuitting = false
/** 托盘是否创建成功（决定 window-all-closed 时是否驻留） */
let trayCreated = false

function startMainMode(): void {
  // 单实例锁（§2.2 入口职责；桥接模式不走此处）。二次启动：聚焦已有窗口
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    } else {
      createWindow()
    }
  })

  app.whenReady().then(async () => {
    // S1：路径注入（paths.ts 零 electron 依赖，vitest 注入临时目录即可测）
    configureUserData(app.getPath('userData'))
    await ensureDirs()

    const store = new ConfigStore(getPaths())
    storeRef = store
    await store.init()

    // N-6：主进程事件循环延迟简易打点（设置页可查看；utilityProcess 演进条件度量）
    const eventLoopMonitor = new EventLoopMonitor()
    eventLoopMonitor.start()

    // S4：日志系统（先建，process-manager 广播需同时喂给它做终态 flush）
    const logManager = new LogManager({
      store,
      logsDir: getPaths().logsDir,
      broadcaster: (chunk) => broadcastEvent(IPC_EVENTS.LOG_APPENDED, chunk),
      markRunning: (projectId) => processManager.markRunning(projectId) // S-1：只发信号，状态转移在 process-manager
    })

    // S3：进程管理核心（单一权威状态源；GUI/IPC 与 MCP(S5) 同源调用）
    const processManager = new ProcessManager({
      store,
      runsFile: getPaths().runsFile,
      broadcaster: (payload) => {
        broadcastEvent(IPC_EVENTS.PROC_STATUS_CHANGED, payload)
        logManager.handleStatusChanged(payload) // 终态：flush 残行批量 + 关闭 tailer/管道/writer
      }
    })

    // P3-7（phase4 审查）：tray 声明提前——下方 mcpHost 的 onPortChanged 回调先引用了
    // tray（原声明在其后，属 TDZ 脆弱写法；运行时序虽安全，声明前置消除隐患）
    let tray: Tray | null = null

    // S4：S-1 握手接线——process → log 唯一通道（run:started 管道句柄交付）
    processManager.setLogHooks({
      onRunStarted: (event) => logManager.handleRunStarted(event)
    })

    // S5：MCP 宿主（单 server 双通道的 HTTP 侧；工具 handler 直调上面两个服务层，与 IPC 同源）
    const mcpHost = new McpHost({
      services: {
        store,
        processControl: processManager,
        logService: logManager
      },
      portFile: getPaths().mcpPortFile,
      getPort: () => store.getSettings().mcpPort,
      version: app.getVersion(), // serverInfo.version 与 GUI 页头版本同源
      onPortChanged: (payload) => {
        broadcastEvent(IPC_EVENTS.MCP_PORT_CHANGED, payload)
        // S6.2：bind-failed 在托盘显式呈现（tooltip + 气泡通知，绝不静默漂移 R4/A15）
        tray?.setToolTip(mcpTrayTooltip(mcpHost.getMcpStatus()))
        if (payload.reason === 'bind-failed') {
          tray?.displayBalloon?.({
            title: 'MCP 服务启动失败',
            content: `端口 ${payload.port} 被 ${payload.occupantName ?? '未知进程'} 占用，其余功能不受影响；Agent 可改用 stdio 桥接（不含端口）`
          })
        }
      }
    })

    registerIpcHandlers({
      store,
      processControl: {
        getRuntimeState: (id) => processManager.getRuntimeState(id),
        startProject: (id) => processManager.startProject(id),
        stopProject: (id, timeoutMs) => processManager.stopProject(id, timeoutMs),
        restartProject: (id, stopTimeoutMs) => processManager.restartProject(id, stopTimeoutMs),
        startAllProjects: () => processManager.startAllProjects(),
        stopAllProjects: () => processManager.stopAllProjects()
      },
      logService: logManager,
      mcpStatus: mcpHost,
      eventLoop: eventLoopMonitor
    })

    createWindow()

    // S3：启动重识别（runs.json：存活→RUNNING"重识别"入轮询池；已死→STOPPED 离线退出）
    try {
      await processManager.initialize()
      // S4：重识别 RUNNING 的 file 路项目续接 tail（stdout 路无管道，仅历史可查）
      for (const state of processManager.listRuntimeStates()) {
        if (state.status === 'RUNNING' || state.status === 'STARTING') {
          logManager.ensureTailing(state.projectId)
        }
      }
    } catch (err) {
      console.error('[process-manager] 启动重识别失败（面板仍可用，状态可能缺失）：', err)
    }

    // S3：系统托盘（显示/隐藏、全部启动/停止、退出走 exitPolicy）
    try {
      tray = createTray({
        processManager,
        getMainWindow: () => BrowserWindow.getAllWindows()[0],
        showPanel: createWindow
      })
      trayCreated = true
    } catch (err) {
      console.error('[tray] 托盘创建失败（面板与启停功能不受影响）：', err)
    }

    // ==================== S5：MCP 启动 + settings 变更重启（串行门防并发重启交错） ====================

    /** MCP 启停串行门：启动/用户改端口/禁用 全部经同一链，避免并发 start 交错 */
    let mcpGate: Promise<unknown> = Promise.resolve()
    const runGated = (op: () => Promise<void>): void => {
      mcpGate = mcpGate.then(op, op).catch((err: unknown) => {
        console.error('[mcp-host] 重启流程异常：', err)
      })
    }

    runGated(async () => {
      const settings = store.getSettings()
      if (!settings.mcpEnabled) return // 禁用：不启动（mcp.port 也不写，桥接只走递增探测）
      // Z-1：失败时 mcp-host 内部已显式报错 + 广播 bind-failed（含占用进程名），不影响其余功能
      await mcpHost.start()
      tray?.setToolTip(mcpTrayTooltip(mcpHost.getMcpStatus())) // S6.2：托盘呈现 MCP 实际状态
    })

    // 用户改端口/开关 = 主动重签契约：重启 mcp-host（新端口）+ user-changed 广播 +
    // mcp.port 文件更新（start 内完成）；新端口被占则 host 内部广播 bind-failed
    let lastMcp = { enabled: store.getSettings().mcpEnabled, port: store.getSettings().mcpPort }
    store.on(CONFIG_EVENTS.SETTINGS_CHANGED, (next: Settings) => {
      if (next.mcpEnabled === lastMcp.enabled && next.mcpPort === lastMcp.port) return
      lastMcp = { enabled: next.mcpEnabled, port: next.mcpPort }
      runGated(async () => {
        if (!next.mcpEnabled) {
          await mcpHost.stop({ removePortFile: true })
          broadcastEvent(IPC_EVENTS.MCP_PORT_CHANGED, { port: next.mcpPort, reason: 'user-changed' })
          tray?.setToolTip(mcpTrayTooltip(mcpHost.getMcpStatus()))
          return
        }
        const status = await mcpHost.start() // 内部先停再按新端口重绑 + 写 mcp.port
        if (status.enabled) {
          broadcastEvent(IPC_EVENTS.MCP_PORT_CHANGED, {
            port: status.port ?? next.mcpPort,
            reason: 'user-changed'
          })
        } // 绑定失败：start 已广播 bind-failed 并记录状态，其余功能不受影响
        tray?.setToolTip(mcpTrayTooltip(mcpHost.getMcpStatus()))
      })
    })

    // S3：退出策略（keep 默认 | stopAll）——before-quit 拆两段式（同步事件无法 await）
    let exitPrepared = false
    app.on('before-quit', (event) => {
      isQuitting = true
      if (exitPrepared) return
      event.preventDefault()
      exitPrepared = true
      // S4：先 flush 日志残行批量（落盘 + 推送），再执行退出策略
      void logManager
        .shutdown()
        .catch((err: unknown) => console.error('[log-manager] 退出 flush 失败：', err))
        .then(() => prepareExit(store.getSettings(), processManager))
        .then((outcome) => {
          if (outcome.failed.length > 0) {
            console.warn(`[lifecycle] 退出全停：${outcome.failed.length} 个项目终止失败（已跳过）`)
          }
        })
        .catch((err: unknown) => console.error('[lifecycle] 退出策略执行失败：', err))
        // S5：MCP 宿主收尾（停 HTTP 监听 + 删 mcp.port——主实例已退出，残留端口文件只会误导桥接探测）
        .then(() => mcpHost.stop({ removePortFile: true }))
        .catch((err: unknown) => console.error('[mcp-host] 退出收尾失败：', err))
        .finally(() => {
          // P3-5（phase4 审查）：退出前停止事件循环打点采样（1s interval 不再空转）
          eventLoopMonitor.stop()
          tray?.destroy()
          trayCreated = false
          app.quit()
        })
    })

    // S2：首次使用（jdks.json 为空）后台静默扫描一次，不阻塞窗口显示（void 不 await）
    if (store.listJdks().length === 0) {
      void autoScanJdksOnFirstUse(store)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((err: unknown) => {
    console.error('[main] 启动失败：', err)
  })
}

// 托盘常驻语义：全部窗口关闭不退出（退出走托盘菜单 → exitPolicy）；托盘创建失败时保持常规退出行为
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !trayCreated) app.quit()
})
