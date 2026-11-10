# javamgr — Windows Java 进程管理器（Electron + 内嵌 MCP）

桌面工具 + MCP 服务同体：注册预构建 jar 项目（不做编译构建），红绿灯启停 + 卡片多选批量（启动/重启/停止所选，PowerShell 杀进程树），目录递归扫描 jar 批量导入（勾选 → 批量指派项目名/JDK → 一键纳管），双策略日志（logback 文件 tail / stdout 捕获 GBK·UTF-8 自动转码），内嵌 MCP 双通道（Streamable HTTP 契约端口 + stdio 桥接）供 Agent 全管控——取代「CD → 开 CMD → java -jar」手工工作流。

- 技术栈：Electron 33 + electron-vite + Vue 3 + Element Plus + Pinia + TypeScript（strict）+ @modelcontextprotocol/sdk + zod + iconv-lite
- 平台：仅 Windows、单用户、本地运行（无远程/多机/认证）

## 目录速览

```
src/shared/          主/渲染/preload 共享类型与 IPC 通道常量（零依赖）
src/main/            主进程（唯一权威状态源）
  ├ process/         进程管理核心：状态机 + projectId 操作队列 + taskkill 树终止 + PID 重识别轮询池
  ├ log/             日志：file|stdout 双路由、编码自动判定（非 ASCII 才锁定）、10MB 轮转、检索
  ├ mcp/             MCP 宿主（契约端口）+ 15 工具 + stdio 桥接（--mcp-stdio）
  ├ jdk/             JDK 扫描（标准根目录 + JAVA_HOME + 自定义根）
  ├ jar/             jar 递归扫描导入（已纳管标注/截断上限/权限目录跳过）
  ├ config/          projects/jdks/settings.json（内存缓存 + 变更即写 + 原子写 + 损坏备份重建）
  └ telemetry/       event loop 延迟打点（设置页可查看；utilityProcess 演进条件度量）
src/renderer/        Vue 3 控制台（项目面板 / JDK 管理 / 设置）
scripts/fixtures/    Loggy.java 测试夹具（见下）
tests/unit/          纯 Node 单测（mock taskkill/spawn，无外部依赖）
tests/integration/   真实进程集成测试（真实 javac/taskkill/tasklist + MCP SDK Client）
```

## 开发

```bash
npm install
npm run dev            # electron-vite 开发模式（热更新）
npm run typecheck      # tsc(node) + vue-tsc(web)
npm run build          # typecheck + electron-vite build → out/
npm test               # 全部测试（unit + integration）
npm run test:unit      # 仅单测（无外部依赖，任意机器可跑）
npm run test:integration  # 仅集成（前置见下）
```

### 集成测试前置

- 本机 JDK 17：`D:\java17\jdk-17.0.12`（javac/jar/java；各集成文件顶部 `JDK_HOME` 常量，路径不同请改）
- 夹具在测试 `beforeAll` 现场 `javac` 编译，无需手工预编译（手工编译见 `scripts/fixtures/README.md`）
- 7 项目并发冒烟：`tests/integration/smoke-7projects.integration.test.ts`（全部启动 → 全部 RUNNING → MCP 全程可用 → 全部停止 → java.exe 全灭）

## 打包

```bash
npm run dist           # = npm run build + electron-builder --win nsis
# 二进制下载慢时用镜像：
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run dist
```

产物（`dist/`）：

- `javamgr-<version>-x64-setup.exe` — NSIS 安装包（非 oneClick，可选安装目录）
- `win-unpacked/javamgr.exe` — 免安装目录版

打包产物冒烟（主实例进程 / mcp.port / HTTP initialize / 稳定性 / stdio 桥接 / 无残留进程；7777 被占时另验证 bind-failed 显式失败路径）：

```bash
node scripts/packaged-smoke.mjs            # 默认 dist/win-unpacked
node scripts/packaged-smoke.mjs <目录>      # 指定 win-unpacked 目录
```

## Agent 接入（MCP）

15 个工具，与 GUI 面板同源等价：

- 查询：`list_projects`（含实时状态）/ `get_status` / `list_jdks`（create/update 的 jdkId 候选）
- 单项启停：`start_project`（幂等）/ `stop_project`（杀进程树）/ `restart_project`（原子组合）
- 批量：`start_all_projects` / `stop_all_projects`（全部启动/停止，单项失败不中断）
- 项目管理：`create_project`（新建）/ `update_project`（部分更新，缺省沿用现值）/ `delete_project`（运行中须 confirm=true：先停再删）
- 日志：`read_logs` / `search_logs`（keyword/level/时间窗/上下文）
- 扫描导入（与 GUI「扫描导入」同一流程）：`scan_jars`（递归收集目录下 *.jar，返回建议名与已纳管标注）→ `batch_create_projects`（批量纳管，skipExisting 默认跳过已纳管 jar，逐条校验 jdkId，单项失败不中断）

`project` 参数支持精确 id → 精确名 → 忽略大小写 → 唯一前缀；歧义/未命中返回候选列表。

HTTP（固定契约端口，默认 7777）：

```json
{
  "mcpServers": {
    "javamgr": { "url": "http://127.0.0.1:7777/mcp" }
  }
}
```

stdio（桥接，不含端口、永远有效——自动发现主实例）：

```json
{
  "mcpServers": {
    "javamgr": { "command": "C:\\path\\to\\javamgr.exe", "args": ["--mcp-stdio"] }
  }
}
```

（设置页提供以上样例与一键复制；桥接命令以设置页展示为准。）

### 契约端口语义（重要）

`settings.mcpPort`（默认 7777）是 **Agent 侧的 URL 契约**：

- 被占用时 **绝不静默改用其他端口**——先向占用者发 MCP initialize 探测，若为上次崩溃残留的本工具实例则自动终止重绑；确认为外部占用则 **MCP 启动失败并在 UI/托盘显式报错（含占用进程名）**，其余功能不受影响；
- 用户改端口 = 主动重签契约，需同步更新 Agent 侧 HTTP 配置（设置页明示）；
- 实际监听端口写入 `%APPDATA%/javamgr/mcp.port`，stdio 桥接优先读它发现主实例，失败时递增探测 7777–7786（命中判定 = initialize 成功且 `serverInfo.name === "javamgr"`）；Agent 的 stdio 配置因此不含端口、永远有效——两通道互为兜底；
- HTTP 通道仅绑定 127.0.0.1。

## 进程与状态语义（摘）

- **操作串行化**：同一项目的 start/stop/restart 经 projectId 级队列串行（GUI 与 MCP 同一队列）；RUNNING/STARTING 下重复 start 幂等返回当前 pid，绝不二次 spawn；restart 为原子组合（stop 等树死 → start）；
- **工作目录**（2026-11-10 修复）：子进程 cwd = jar 所在目录，复刻「CD 到目录再 java -jar」语义——应用内相对路径读写（Spring `file:config/`、logback 相对 `<file>` 等按 `user.dir` 解析）落在 jar 平级，与手工运行行为一致；
- **停止**：单次 PowerShell 调用完成「CIM 枚举后代 + 批量 `Stop-Process -Force`」（先子后主），外层硬超时 3s、超时必杀助手并自动降级为仅终止主进程；杀后用 `process.kill(pid, 0)` 零开销确认（500ms 间隔重试至 stopTimeoutMs 预算，默认 8s），仍存活补一次 Stop-Process，再不行显式报错；
- **启动判定**：首条日志输出（stdout 或文件 tail 新增行）即 RUNNING；无输出时存活满 `startupGraceSeconds`（默认 5s）兜底转 RUNNING；
- **退出策略**（设置页，默认 keep）：keep = 工具退出子进程保持运行（分离进程），重启工具后按 runs.json 的 PID + 启动时间重识别（存活者入 5s 批量轮询池，死亡检出 ≤2 个周期）；stopAll = 退出前逐项目杀树；
- **日志双策略**：配置了 logFilePath 则 tail 文件（跟随 logback rename 轮转、截断重建、删除后重建），否则捕获 stdout/stderr（GBK/UTF-8 自动判定：纯 ASCII 段不判定，首个非 ASCII 序列才锁定；项目级编码覆盖逃生口）并持久化到 `%APPDATA%/javamgr/logs/`（单文件 10MB 轮转、保留 run 数可配，工具重启后历史可查）。

## 已知限制（ADR Consequences，显式接受）

1. **重识别进程 stdout 管道不可重挂**——工具离线期间与其后的 stdout 增量不可捕获（历史已落盘可查；引导长时间运行的服务配置日志文件路径）；
2. **工具离线期间进程死亡的退出码不可知**（显示「退出码未知」）；
3. **重识别 RUNNING 状态存在至多一个轮询周期（5–10s）的过期窗口**；
4. **7777 被外部进程占用时 HTTP 通道不可用直至人工介入**（stdio 桥接兜底，Agent 侧无感）；
5. **日志时间范围检索依赖行首时间戳可解析**（无时间戳的堆栈续行归属其前最近一个有时间戳的行）；
6. **WMI 病态宿主降级**——见下节。

### 运维：WMI 病态宿主的降级行为（2026-11-09 起）

部分 Windows 宿主会间歇性出现 WMI 服务病态（`Get-CimInstance` 挂死 >90s、`taskkill /T /F` 单次 61s+ 才返回，而 PSAPI 的 `Get-Process` 与 `Stop-Process` 全程健康）。javamgr 的停止/探活/轮询路径已全面避开 taskkill/tasklist：

- **停止（stop/restart/stopAll）**：主引擎为单次 PowerShell「CIM 枚举后代（`-OperationTimeoutSec 1` 内层超时 + 枚举墙钟预算）+ 批量 Stop-Process」。WMI 病态时该调用在预算内自行收敛：枚举失败 → 只杀主进程，stop 结果带 `note`（"WMI 子进程枚举不可用，仅终止主进程"），**ok 仍为 true**——主进程确定被终止（实测病态宿主 ~1.7s 完成，对照 taskkill 61s）；但**派生子进程可能残留**，需要在项目配置或运维侧单独清理。
- **探活/轮询池**：存在性判定用 `process.kill(pid, 0)`（零 spawn、零 WMI）；镜像名（java*）与启动时间（PID 重用防护，±3s）经一次批量 `Get-Process`（PSAPI）。批量查询超时 → 本轮记"未验证"跳过，绝不误判死亡、绝不堆积挂死的 PowerShell 助手（病态源头的 conhost/powershell 僵尸不再产生）。
- **排障提示**：若 stop 返回 note 降级说明，说明本机 WMI 病态中；可用 `Get-CimInstance Win32_Process -OperationTimeoutSec 2` 自测（超时即病态）。病态通常在 WMI 服务恢复（`winmgmt /verifyrepository`、重启 Winmgmt 服务或整机重启）后自愈，届时树终止自动恢复全量枚举。

## 夹具（scripts/fixtures）

`Loggy.java`：单文件 JDK 11+ 夹具，行为由参数控制——`mode=plain|gbk|sleep`（GBK 输出 / 长静默验证 STARTING 兜底）、`interval`、`children=N`（派生子进程验证树终止）、`log=路径 + rotate=N 行`（logback 式 rename 轮转验证 tail 跟随）、`exit-after/exit-code`（非零退出验证 ABNORMAL_EXIT）。手工编译：见 `scripts/fixtures/README.md`；集成测试会自动编译。
