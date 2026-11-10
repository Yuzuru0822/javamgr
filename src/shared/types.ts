/**
 * 共享类型（§2.2 src/shared，零依赖，主进程 / preload / 渲染进程三方共用）。
 * 字段契约来源：计划 §2.5（IPC 通道参数/返回）与 §2.6（MCP 工具签名）。
 */

// ---------- 基础枚举 ----------

/** 进程运行状态（§2.3-A 状态机）：STOPPED → STARTING → RUNNING → (退出: STOPPED[code 0] | ABNORMAL_EXIT[code≠0]) */
export type RunStatus = 'STARTING' | 'RUNNING' | 'STOPPED' | 'ABNORMAL_EXIT'

/** 工具退出策略：keep = 子进程保持运行（默认，分离进程）；stopAll = 退出前逐项目 taskkill */
export type ExitPolicy = 'keep' | 'stopAll'

/** 日志来源：项目配置 logFilePath → file（tail 跟随轮转）；否则 stdout（捕获转码落盘） */
export type LogSource = 'file' | 'stdout'

/** 读取日志时的来源选择：auto = 按项目配置路由（与 MCP read_logs 对齐） */
export type LogSourceChoice = 'auto' | LogSource

/** 日志级别（level-parser 正则识别，失败降级 UNKNOWN） */
export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'UNKNOWN'

/** stdout 编码覆盖（逃生口）：auto = 自动检测；覆盖即跳过自动判定 */
export type EncodingOverride = 'auto' | 'utf8' | 'gbk'

// ---------- 项目 ----------

/** 纳管项目配置（projects.json 持久化条目） */
export interface Project {
  id: string
  name: string
  jarPath: string
  /** 绑定的 Jdk.id */
  jdkId: string
  /** JVM 参数（-Xmx 等） */
  jvmArgs: string[]
  /** 程序参数（跟在 -jar xxx.jar 之后） */
  programArgs: string[]
  /** 环境变量（追加到进程 env，JAVA_HOME 由 jdkId 注入） */
  envVars: Record<string, string>
  /** 可选：配置了则 tail 该文件（含 logback 轮转跟随），否则回退捕获 stdout */
  logFilePath?: string
  /** 可选：stdout 编码覆盖 */
  encodingOverride?: EncodingOverride
}

/** projects:create / projects:update 请求体（update 必带 id） */
export type ProjectInput = Omit<Project, 'id'> & { id?: string }

/** 项目实时运行状态（单一权威状态源在主进程 process-manager，此处为镜像快照） */
export interface ProjectRuntimeState {
  status: RunStatus
  pid?: number
  /** 本次 run 启动时间，epoch ms */
  startTime?: number
  uptimeMs?: number
  /** 退出码；RUNNING/STARTING 时无；重识别的历史退出无码（见 note） */
  exitCode?: number
  /** 状态备注，如 "重识别" / "工具离线期间退出，退出码未知" / "外部退出，退出码未知" */
  note?: string
}

/** projects:list 返回：Project 平铺运行时状态（含实时状态） */
export type ProjectWithRuntime = Project & ProjectRuntimeState

// ---------- JDK ----------

/** 已识别的 JDK（jdks.json 持久化条目） */
export interface Jdk {
  id: string
  /** 展示名，如 "Temurin 17.0.9" */
  name: string
  /** JDK home 绝对路径（含 bin\java.exe） */
  homePath: string
  /** release 文件 JAVA_VERSION；无 release 时由 `java -version` 兜底解析 */
  version: string
  /** 发行方（IMPLEMENTOR） */
  vendor: string
  /** 来源：目录扫描 / 手动添加 */
  source: 'scan' | 'manual'
}

/** jdk:validate / jdk-scanner.validateJdkPath 返回：手动添加/编辑路径的即时校验结果（S2） */
export interface JdkValidation {
  ok: boolean
  /** 校验通过时的完整 JDK 草稿（source: 'manual'，id 已生成，可直接入库） */
  jdk?: Jdk
  /** 校验失败原因（中文，UI 直接展示） */
  error?: string
}

// ---------- 设置 ----------

/** settings.json（§2.4 设置页全量字段；默认值由 S1 config-store 拥有） */
export interface Settings {
  /** MCP 服务总开关 */
  mcpEnabled: boolean
  /** HTTP 通道契约端口（默认 7777；被占显式报错，不漂移；改动 = 重签契约，需同步 Agent 配置） */
  mcpPort: number
  /** 退出策略：keep（默认）| stopAll */
  exitPolicy: ExitPolicy
  /** STARTING→RUNNING 无输出兜底秒数（默认 5） */
  startupGraceSeconds: number
  /** 重识别进程存活轮询间隔秒（可配 5–10，默认 5） */
  pollIntervalSeconds: number
  /** tail 初始回读行数（默认 200） */
  tailInitialLines: number
  /** 日志保留：单 run 文件大小上限 MB（默认 10，超出轮转 .1/.2/...） */
  logMaxFileMb: number
  /** 日志保留：每 run 轮转文件保留个数（默认 3） */
  logMaxRotations: number
  /** 日志保留：每项目保留最近 N 个 run（默认 10） */
  logRunsToKeep: number
  /** 用户追加的 JDK 扫描根目录（叠加默认根 + JAVA_HOME） */
  scanRoots: string[]
  /** 关闭窗口 = 最小化到托盘 */
  closeToTray: boolean
}

// ---------- 日志 ----------

/** 解析后的日志行（level-parser 产物） */
export interface LogLine {
  /** 在所属日志流中的行号 */
  lineNo: number
  text: string
  level: LogLevel
  /** 行首时间戳解析结果（epoch ms）；解析失败省略（堆栈续行等） */
  timestamp?: number
}

/** 日志批量推送单元（log:appended 载荷，200ms 或 100 行合并） */
export interface LogChunk {
  projectId: string
  source: LogSource
  lines: string[]
}

// ---------- 检索（logs:search / MCP search_logs 同一契约） ----------

/** 检索请求参数（§2.5 / §2.6 对齐） */
export interface SearchParams {
  projectId: string
  /** 不区分大小写子串 */
  keyword?: string
  level?: Exclude<LogLevel, 'UNKNOWN' | 'FATAL'> | 'FATAL'
  /** ISO 8601；无时间戳行归属其前最近一个有时间戳的行（流式语义，A7） */
  startTime?: string
  endTime?: string
  maxResults?: number
  /** 命中行上下邻行数 */
  contextLines?: number
}

/** 单条命中（§2.6 search_logs 返回） */
export interface LogMatch {
  lineNo: number
  text: string
  /** 行首时间戳（ISO 8601）；无时间戳行省略 */
  timestamp?: string
}

/** 检索结果：matches + 截断标志（命中数达 maxResults 时 truncated=true） */
export interface SearchResult {
  matches: LogMatch[]
  truncated: boolean
}

// ---------- 历史读取（logs:readHistory / MCP read_logs 对齐） ----------

export interface ReadHistoryParams {
  projectId: string
  lines?: number
  source?: LogSourceChoice
}

export interface ReadHistoryResult {
  source: LogSource
  lines: string[]
}

// ---------- 操作结果（IPC 与 MCP 同源语义） ----------

/**
 * start / stop / restart 单项目操作结果。
 * start: {ok, pid?, status?, error?}；stop: {ok, durationMs?, error?}；restart: {ok, pid?, error?}
 * note：stop/restart 的降级说明（WMI 病态宿主下仅终止了主进程——degraded 语义）。
 */
export interface OpResult {
  ok: boolean
  pid?: number
  status?: RunStatus
  durationMs?: number
  error?: string
  /** 降级说明（如 "WMI 子进程枚举不可用，仅终止主进程"）；成功且无降级时省略 */
  note?: string
}

/** startAll / stopAll 汇总：单项失败不中断后续 */
export interface BatchResult {
  results: Array<{ id: string; ok: boolean; error?: string }>
}

// ---------- 主进程 → 渲染进程 事件载荷（§2.5 Events） ----------

/** proc:statusChanged（S3：note 为附加字段，用于 UI 呈现"重识别/外部退出，退出码未知"等备注） */
export interface StatusChangedEvent {
  projectId: string
  status: RunStatus
  pid?: number
  exitCode?: number
  startTime?: number
  note?: string
}

/** log:appended */
export interface LogAppendedEvent {
  projectId: string
  source: LogSource
  lines: string[]
}

/** jdk:scanProgress */
export interface ScanProgressEvent {
  scanned: number
  found: number
}

/** mcp:portChanged（固定契约端口下无自动漂移；bind-failed 携带占用进程名） */
export interface PortChangedEvent {
  port: number
  reason: 'user-changed' | 'bind-failed'
  /** bind-failed 时的占用进程名 */
  occupantName?: string
}

// ---------- MCP ----------

/** app:getMcpInfo 返回（§2.5；S5：enabled=实际监听中，失败时携带显式错误与占用进程名） */
export interface McpInfo {
  enabled: boolean
  port: number
  url: string
  bridgeCommand: string
  /** MCP 启动失败原因（端口被占等，显式呈现；成功时省略） */
  error?: string
  /** bind-failed 时的占用进程名 */
  occupantName?: string
}

// ---------- 运行指标（N-6：event loop 简易打点，设置页可查看） ----------

/** app:getEventLoopMetrics 返回：主进程事件循环延迟滚动窗口指标（§7 分叉 1 演进条件度量） */
export interface EventLoopMetrics {
  /** 最近一次采样延迟（ms） */
  lastMs: number
  /** 窗口内 P95 延迟（ms） */
  p95Ms: number
  /** 窗口内样本数 */
  samples: number
  /** 滚动窗口长度（ms，默认 30000） */
  windowMs: number
  /** P95 > 100ms 持续 ≥30s（utilityProcess 日志 worker 演进触发条件） */
  sustainedHigh: boolean
}

/** MCP list_projects 返回条目（§2.6） */
export interface McpProjectSummary {
  id: string
  name: string
  status: RunStatus
  pid?: number
  jarPath: string
  jdkName: string
  uptimeMs?: number
  exitCode?: number
}

// ---------- jar 扫描导入（projects:scanJars / MCP scan_jars，2026-11-10） ----------

/** 单个扫描到的 jar 条目 */
export interface JarScanEntry {
  /** jar 绝对路径（已规范化，可直接作为项目 jarPath） */
  path: string
  /** 建议项目名：文件名去扩展名 */
  suggestedName: string
  sizeBytes: number
  /** 最后修改时间（ISO 8601） */
  mtimeIso: string
  /** 该 jar 已被某纳管项目引用（jarPath 相同，大小写不敏感规范化比对） */
  alreadyManaged: boolean
}

/** jar 扫描结果：entries + 截断标志 + 跳过的目录（权限不足等） */
export interface JarScanResult {
  jars: JarScanEntry[]
  /** 命中数超过上限被截断（默认 1000） */
  truncated: boolean
  /** 递归中被跳过的目录（权限拒绝等，不中断整体扫描） */
  skippedDirs: string[]
}

// ---------- 自动更新（updater:* / v0.4.0） ----------

/** 更新流程状态机：idle → checking → available（自动进入 downloading）→ downloaded；无新版 → not-available；任一步失败 → error */
export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

/** updater:check 请求返回 + updater:status 事件载荷（设置页更新区块全量状态） */
export interface UpdaterStatus {
  state: UpdaterState
  /** 远端版本（available/downloading/downloaded/not-available）；checking/error 可省略 */
  version?: string
  /** downloading：0–100 */
  percent?: number
  /** downloading：已传输字节 */
  transferred?: number
  /** downloading：总字节 */
  total?: number
  /** downloading：字节/秒 */
  bytesPerSecond?: number
  /** error：可展示原因（网络失败/校验失败等） */
  error?: string
}

// ---------- runs.json（S3 pid-registry 落盘契约，S0 先定形） ----------

/** 单次运行记录：工具重启后按 PID + 启动时间重识别 */
export interface RunRecord {
  projectId: string
  pid: number
  /** epoch ms，兼作 PID 重用比对基准 */
  startTime: number
  logSource: LogSource
  /** 本次 run 标识（S4 log-store 落盘 <projectId>/<runId>.log；历史文件可缺省） */
  runId?: string
}
