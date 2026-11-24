/**
 * IPC 通道名单一来源（§2.5 全量，防手写漂移）。
 * - IPC_REQUESTS：Request/Response，渲染进程 ipcRenderer.invoke ↔ 主进程 ipcMain.handle
 * - IPC_EVENTS：主进程 → 渲染进程推送（webContents.send）
 * 主进程 ipc-registry（S1）与渲染进程 api/ipc.ts 均从此导入常量，禁止手写字符串。
 */

export const IPC_REQUESTS = {
  /** — | ProjectWithRuntime[]（含实时状态） */
  PROJECTS_LIST: 'projects:list',
  /** ProjectInput | Project；运行中 update 允许保存但提示"重启后生效"（logFilePath 变更例外：即时切换） */
  PROJECTS_CREATE: 'projects:create',
  /** {rootDir} | JarScanResult（递归扫描 *.jar，alreadyManaged 按当前纳管标注；2026-11-10 扫描导入） */
  PROJECTS_SCAN_JARS: 'projects:scanJars',
  PROJECTS_UPDATE: 'projects:update',
  /** {id, confirm} | void；confirm=true → 先 stop（走操作队列）再删配置 */
  PROJECTS_DELETE: 'projects:delete',
  /** {id} | OpResult */
  PROJECTS_START: 'projects:start',
  /** {id} | OpResult */
  PROJECTS_STOP: 'projects:stop',
  /** {id} | OpResult */
  PROJECTS_RESTART: 'projects:restart',
  /** — | BatchResult */
  PROJECTS_START_ALL: 'projects:startAll',
  /** — | BatchResult */
  PROJECTS_STOP_ALL: 'projects:stopAll',
  /** — | Jdk[]（进度走 jdk:scanProgress 事件） */
  JDK_SCAN: 'jdk:scan',
  /** — | Jdk[] */
  JDK_LIST: 'jdk:list',
  /** {homePath} | JdkValidation（S2：即时校验不入库，添加/编辑对话框反馈；add/update 落库时服务端复检） */
  JDK_VALIDATE: 'jdk:validate',
  /** {homePath, name?} | Jdk[]（版本/发行方由主进程校验路径后派生） */
  JDK_ADD: 'jdk:add',
  /** {id, homePath, name?} | Jdk[]（路径变更时重新校验派生） */
  JDK_UPDATE: 'jdk:update',
  /** {id} | Jdk[] */
  JDK_REMOVE: 'jdk:remove',
  /** — | Maven[]（探测 M2_HOME/MAVEN_HOME/PATH，合并保留手动条目；瞬间完成无进度事件） */
  MAVEN_SCAN: 'maven:scan',
  /** — | Maven[] */
  MAVEN_LIST: 'maven:list',
  /** {homePath} | MavenValidation（即时校验不入库；派生版本 + settings.xml 解析建议） */
  MAVEN_VALIDATE: 'maven:validate',
  /** {homePath, name?, settingsPath?, localRepoPath?} | Maven[]（版本由主进程校验路径后派生） */
  MAVEN_ADD: 'maven:add',
  /** {id, homePath, name?, settingsPath?: string|null, localRepoPath?: string|null} | Maven[]（null=清除可选字段；路径变更时重新校验派生） */
  MAVEN_UPDATE: 'maven:update',
  /** {id} | Maven[]（被项目 mavenId 引用时拒绝） */
  MAVEN_REMOVE: 'maven:remove',
  /** {projectId} | BuildState（启动构建：项目构建配置 + Maven 条目 + 绑定 JDK 派生命令；输出经 build:output 流式推送，终态 build:statusChanged；v0.7.0 构建按钮） */
  BUILD_RUN: 'build:run',
  /** {projectId} | void（取消进行中的构建：杀 mvn 进程树） */
  BUILD_STOP: 'build:stop',
  /** {projectId} | BuildState | null（重开对话框恢复输出缓冲与终态） */
  BUILD_GET_STATE: 'build:getState',
  /** {projectId, lines?, source?: "auto"|"file"|"stdout"} | ReadHistoryResult */
  LOGS_READ_HISTORY: 'logs:readHistory',
  /** {projectId, keyword?, level?, startTime?, endTime?, maxResults?, contextLines?} | SearchResult */
  LOGS_SEARCH: 'logs:search',
  /** — | LogStorageInfo（当前 stdout 实际目录、默认目录与用量） */
  LOGS_GET_STORAGE_INFO: 'logs:getStorageInfo',
  /** {scope?: "current"|"legacyDefault"} | LogCleanupResult（缺省 current 按保留策略清理） */
  LOGS_CLEANUP: 'logs:cleanup',
  /** — | Settings */
  SETTINGS_GET: 'settings:get',
  /** Settings | Settings */
  SETTINGS_SET: 'settings:set',
  /** — | McpInfo：{enabled, port, url, bridgeCommand} */
  APP_GET_MCP_INFO: 'app:getMcpInfo',
  /** — | string（app.getVersion()：开发期取 package.json，打包后取安装包版本） */
  APP_GET_VERSION: 'app:getVersion',
  /** — | EventLoopMetrics（N-6：主进程 event loop 简易打点，设置页查看） */
  APP_GET_EVENT_LOOP_METRICS: 'app:getEventLoopMetrics',
  /**
   * {title?, directory?, filters?: Array<{name, extensions: string[]}>} | string | null
   * S3 新增（计划 §2.4 ProjectForm"jar 路径(文件选择器)"所需的最小通道）：
   * 主进程 dialog.showOpenDialog 包装，渲染进程无 Node 能力故经 IPC。
   */
  APP_PICK_FILE: 'app:pickFile',
  /** — | UpdaterStatus（v0.4.0：触发检查更新；后续状态经 updater:status 事件推送） */
  UPDATER_CHECK: 'updater:check',
  /** — | void（下载完成后立即重启静默安装；主进程随即退出，返回值仅为通道契约占位） */
  UPDATER_INSTALL_NOW: 'updater:installNow',
  /** — | UpdaterStatus（当前更新状态快照：重开设置页时恢复下载进度等） */
  UPDATER_GET_STATE: 'updater:getState',
  /** — | WebInfo：{enabled, port, url, error?}（v0.5.0 浏览器面板访问信息） */
  WEB_GET_INFO: 'web:getInfo'
} as const

export const IPC_EVENTS = {
  /** {projectId, status, pid?, exitCode?, startTime?} */
  PROC_STATUS_CHANGED: 'proc:statusChanged',
  /** {projectId, source, lines: string[]}（200ms 或 100 行批量合并，防 IPC 洪泛） */
  LOG_APPENDED: 'log:appended',
  /** {scanned, found} */
  JDK_SCAN_PROGRESS: 'jdk:scanProgress',
  /** {port, reason: "user-changed"|"bind-failed"}（bind-failed 携带占用进程名） */
  MCP_PORT_CHANGED: 'mcp:portChanged',
  /** UpdaterStatus（v0.4.0：检查中/发现新版/下载进度/已下载/无新版/失败 全状态推送） */
  UPDATER_STATUS: 'updater:status',
  /** BuildOutputEvent（v0.7.0：构建输出批量行，200ms 或 100 行合并） */
  BUILD_OUTPUT: 'build:output',
  /** BuildStatusEvent（v0.7.0：构建终态 success/failure/cancelled） */
  BUILD_STATUS_CHANGED: 'build:statusChanged'
} as const

export type IpcRequestChannel = (typeof IPC_REQUESTS)[keyof typeof IPC_REQUESTS]
export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]
export type IpcChannel = IpcRequestChannel | IpcEventChannel
