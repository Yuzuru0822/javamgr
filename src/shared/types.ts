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
  /** 可选：绑定的 Maven.id（构建配置；未绑定 = 项目无构建信息） */
  mavenId?: string
  /** 可选：maven 构建 goals/命令（如 "clean package -DskipTests"），依赖 mavenId 生效 */
  buildCommand?: string
  /** 可选：构建工作目录（含 pom.xml）；缺省自动推断：jar 在 target\ 下取其上级，否则 jar 所在目录 */
  buildDir?: string
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

// ---------- Maven ----------

/** 已注册的 Maven 发行版（mavens.json 持久化条目） */
export interface Maven {
  id: string
  /** 展示名，如 "Apache Maven 3.9.9" */
  name: string
  /** Maven home 绝对路径（含 bin\mvn.cmd） */
  homePath: string
  /** 版本（lib\maven-core-*.jar 文件名解析；解析不出为 "unknown"） */
  version: string
  /** 可选：自定义 settings.xml 路径（缺省 = maven home conf\settings.xml 或 ~/.m2/settings.xml 由 maven 自行解析） */
  settingsPath?: string
  /** 可选：本地仓库路径（缺省从 settings.xml localRepository 解析或 ~/.m2/repository） */
  localRepoPath?: string
  /** 来源：环境探测（M2_HOME/MAVEN_HOME/PATH）/ 手动添加 */
  source: 'scan' | 'manual'
}

/** maven:validate / maven-scanner.validateMavenPath 返回：即时校验结果（派生版本 + settings.xml 解析出的仓库路径建议） */
export interface MavenValidation {
  ok: boolean
  /** 校验通过时的完整 Maven 草稿（source: 'manual'，id 已生成，可直接入库） */
  maven?: Maven
  /** 校验失败原因（中文，UI 直接展示） */
  error?: string
  /** 校验通过时的附加派生信息（不入库，UI 提示用）：settings.xml 里声明的 localRepository */
  settingsLocalRepo?: string
  /** 校验通过时的附加派生信息：默认 settings.xml 候选路径（maven home conf\settings.xml，存在时） */
  defaultSettingsPath?: string
}

// ---------- Maven 构建（build:run 等 / v0.7.0 构建按钮） ----------

/** 单项目构建终态：running 进行中；success/failure 按退出码；cancelled 用户取消 */
export type BuildStatus = 'running' | 'success' | 'failure' | 'cancelled'

/** build:getState 返回 / build:run 启动确认：构建全量快照（含内存保留的输出行） */
export interface BuildState {
  projectId: string
  status: BuildStatus
  /** 完整命令行（含 mvn 脚本路径，展示用） */
  commandLine: string
  /** 实际构建工作目录（buildDir 显式值或自动推断结果） */
  workDir: string
  /** 本次构建开始时间（epoch ms） */
  startedAt: number
  /** 结束耗时（ms；running 时省略） */
  durationMs?: number
  /** mvn 退出码（cancelled 时省略） */
  exitCode?: number
  /** 输出行（滚动缓冲，超上限丢头部保尾部；含解码与 \r 处理后的纯文本行） */
  lines: string[]
}

/** build:output 事件载荷（批量行，防 IPC 洪泛） */
export interface BuildOutputEvent {
  projectId: string
  lines: string[]
}

/** build:statusChanged 事件载荷（终态；started 由 build:run 返回值携带） */
export interface BuildStatusEvent {
  projectId: string
  status: BuildStatus
  exitCode?: number
  durationMs?: number
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
  /** 日志保留：每项目保留最近 N 个历史 run（默认 10；活动 run 不计入保留数） */
  logRunsToKeep: number
  /** stdout 日志按修改时间保留天数（默认 7；活动文件不删） */
  logRetentionDays: number
  /** stdout 日志全局目标上限 MiB（默认 512；活动文件计入占用但不强删） */
  logMaxTotalMb: number
  /** 用户选择的 stdout 日志父目录；实际目录为 <stdoutLogDir>/javamgr-logs，空 = 默认 userData/logs */
  stdoutLogDir: string
  /** 用户追加的 JDK 扫描根目录（叠加默认根 + JAVA_HOME） */
  scanRoots: string[]
  /** 关闭窗口 = 最小化到托盘 */
  closeToTray: boolean
  /** 本地浏览器访问面板（v0.5.0：WebHost 服务同一渲染端 UI，仅绑定 127.0.0.1） */
  webEnabled: boolean
  /** 浏览器访问契约端口（默认 7790；避开 MCP 桥接递增探测段 7777–7786） */
  webPort: number
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

/** stdout 清理范围：当前目录按保留策略；旧默认根仅由用户显式触发全量清理 */
export type LogCleanupScope = 'current' | 'legacyDefault'

export interface LogCleanupResult {
  scope: LogCleanupScope
  logsDir: string
  freedBytes: number
  deletedFiles: number
  remainingBytes: number
  activeBytes: number
  errors: string[]
  cleanedAt: string
}

export interface LogStorageInfo {
  logsDir: string
  defaultLogsDir: string
  totalBytes: number
  activeBytes: number
  lastCleanupAt?: string
  errors: string[]
  storageError?: string
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

/** web:getInfo 返回（v0.5.0：浏览器面板访问信息；enabled=实际监听中） */
export interface WebInfo {
  enabled: boolean
  port: number
  url: string
  /** 启动失败原因（端口被占等；成功时省略） */
  error?: string
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
