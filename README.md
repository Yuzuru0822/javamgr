# javamgr — Windows Java 进程管理器（Electron + 内嵌 MCP）

取代「CD 到目录 → 开 CMD → java -jar」的手工流程：注册预构建 jar，红绿灯启停，Agent 可全管控。

**你现在是哪种读者 → 直接跳：**

- 想直接用 → [安装（3 步，约 2 分钟）](#安装3-步约-2-分钟)
- 想让 Agent 管进程 → [Agent 接入](#agent-接入mcp)，复制一段配置即通
- 想改代码 → [开发（2 步起跑）](#开发2-步起跑)

技术栈：Electron 33 + electron-vite + Vue 3 + Element Plus + Pinia + TypeScript（strict）+ @modelcontextprotocol/sdk + zod + iconv-lite。仅 Windows、单用户、本地运行（无远程/多机/认证）。

## 安装（3 步，约 2 分钟）

1. 从 [Releases](https://github.com/Yuzuru0822/javamgr/releases/latest) 下载 `javamgr-<version>-x64-setup.exe`
2. 双击安装（可选安装目录；`win-unpacked/javamgr.exe` 为免安装版）
3. 启动 javamgr → 「新建项目」选 jar 与 JDK → 点「启动」

装好后其余全自动：JDK 自动扫描、日志自动捕获、应用内自动更新。

## 功能

- **项目面板**：卡片 / 分页列表双视图（工具栏右上角切换）；按名称、状态、运行时间、PID 排序（列表表头与工具栏控件互通，卡片视图同样生效）；勾选多个批量启动/重启/停止
- **扫描导入**：选目录递归收集 jar → 勾选 → 批量命名 / 指派 JDK → 一键纳管（已纳管自动标注）
- **日志**：实时滚动 + 级别/关键字过滤 + 上下文检索；logback 文件 tail（跟随轮转）或 stdout 捕获（GBK/UTF-8 自动判定）持久化到 `%APPDATA%/javamgr/logs/`
- **浏览器面板**：本机浏览器开 `http://127.0.0.1:7790`，与桌面窗口同一 UI（默认开，仅绑定 127.0.0.1；跨设备自行做 SSH 端口转发）
- **自动更新**：设置页「检查更新」→ 差量下载（blockmap 只传变化块）→ 重启静默安装，更新期间托管 java 进程零中断

## Agent 接入（MCP）

第一步：把下面任意一段加进你的 MCP 客户端配置（Claude Desktop / Claude Code / 其他），约 20 秒。

HTTP（契约端口，默认 7777）：

```json
{
  "mcpServers": {
    "javamgr": { "url": "http://127.0.0.1:7777/mcp" }
  }
}
```

stdio（不含端口、永远有效——自动发现主实例）：

```json
{
  "mcpServers": {
    "javamgr": { "command": "C:\\path\\to\\javamgr.exe", "args": ["--mcp-stdio"] }
  }
}
```

（设置页有以上样例与一键复制，以设置页展示为准。）

**15 个工具**（与 GUI 同源等价）：

- 查询：`list_projects`（含实时状态）/ `get_status` / `list_jdks`
- 启停：`start_project`（幂等）/ `stop_project`（杀进程树）/ `restart_project`（原子组合）/ `start_all_projects` / `stop_all_projects`
- 项目管理：`create_project` / `update_project`（部分更新，缺省沿用现值）/ `delete_project`（运行中须 `confirm=true`：先停再删）
- 日志：`read_logs` / `search_logs`（keyword / level / 时间窗 / 上下文）
- 导入：`scan_jars`（递归收集，返回建议名与已纳管标注）→ `batch_create_projects`（skipExisting 幂等，单项失败不中断）

`project` 参数：id → 精确名 → 忽略大小写 → 唯一前缀；歧义/未命中返回候选列表。

### 端口契约（重要）

- `settings.mcpPort`（默认 7777）是 Agent 侧 URL 契约，**被占绝不静默漂移**：先探测占用者，是本工具残留实例则自动回收重绑；是外部占用则 MCP 显式报错（含占用进程名），其余功能不受影响
- 实际监听端口写入 `%APPDATA%/javamgr/mcp.port`；stdio 桥接优先读它，失败时递增探测 7777–7786——两通道互为兜底
- 用户改端口 = 主动重签契约，需同步改 Agent 侧 URL（设置页明示）
- HTTP 通道仅绑定 127.0.0.1

## 开发（2 步起跑）

1. `npm install`
2. `npm run dev` — electron-vite 热更新开发模式

命令速查：

```bash
npm run typecheck        # tsc(node) + vue-tsc(web)
npm run test:unit        # 单测，无外部依赖，任意机器可跑
npm run test:integration # 集成，前置见下
npm test                 # 全部
npm run build            # typecheck + electron-vite build → out/
```

集成测试前置：本机 JDK 17 在 `D:\java17\jdk-17.0.12`；路径不同 → 改各集成文件顶部的 `JDK_HOME` 常量。夹具（`scripts/fixtures/Loggy.java`）由测试现场 `javac` 编译，无需手工预编译。7 项目并发冒烟：`tests/integration/smoke-7projects.integration.test.ts`。

## 打包

```bash
npm run dist   # = npm run build + electron-builder --win nsis → dist/
```

二进制下载慢时加镜像（约 10 分钟 → 1 分钟）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run dist
```

打包产物冒烟（进程出现 / mcp.port / HTTP initialize / 稳定性 / stdio 桥接 / 无残留）：

```bash
node scripts/packaged-smoke.mjs            # 默认 dist/win-unpacked
node scripts/packaged-smoke.mjs <目录>      # 指定 win-unpacked 目录
```

注意：冒烟前关闭已安装的 javamgr 实例，否则冒烟实例撞单实例锁退出（非缺陷）。

## 发版（仓库须为 public——更新器匿名拉取）

1. `npm run dist`
2. 建 draft：`gh release create v<version> --draft --title "javamgr v<version>" --notes "..."`
3. 传三件套：`gh release upload v<version> dist/javamgr-<version>-x64-setup.exe{,.blockmap} dist/latest.yml --clobber`
4. 发布：`gh release edit v<version> --draft=false`
5. 验证：`curl https://api.github.com/repos/Yuzuru0822/javamgr/releases/latest` 返回 `tag_name` 为新版本

（分步比一步 `gh release create v<version> <files>` 可靠——网络抖动时一步到位会在上传环节整体失败且不留 draft。）

## 目录速览

```
src/shared/          主/渲染/preload 共享类型与 IPC 通道常量（零依赖）
src/main/            主进程（唯一权威状态源）
  ├ process/         状态机 + projectId 操作队列 + 杀树 + PID 重识别轮询池
  ├ log/             file|stdout 双路由、编码自动判定、10MB 轮转、检索
  ├ mcp/             MCP 宿主（契约端口）+ 15 工具 + stdio 桥接
  ├ jdk/             JDK 扫描（标准根目录 + JAVA_HOME + 自定义根）
  ├ jar/             jar 递归扫描导入
  ├ config/          projects/jdks/settings.json（原子写 + 损坏备份重建）
  └ telemetry/       event loop 延迟打点（设置页可查看）
src/renderer/        Vue 3 控制台（项目面板 / JDK 管理 / 设置）
scripts/fixtures/    Loggy.java 测试夹具
tests/unit/          纯 Node 单测（mock taskkill/spawn）
tests/integration/   真实进程集成测试（真实 javac/taskkill + MCP SDK Client）
```

## 进程与状态语义（摘）

- **操作串行化**：同一项目 start/stop/restart 按 projectId 队列串行（GUI 与 MCP 同一队列）；RUNNING/STARTING 下重复 start 幂等返回当前 pid；restart = stop 等树死 → start
- **工作目录**：子进程 cwd = jar 所在目录（复刻「CD 后 java -jar」）——应用内相对路径读写落在 jar 平级
- **停止**：单次 PowerShell「CIM 枚举后代 + 批量 Stop-Process」（先子后主），超时自动降级为仅杀主进程并在结果 `note` 说明
- **启动判定**：首条日志输出即 RUNNING；无输出满 `startupGraceSeconds`（默认 5s）兜底转 RUNNING
- **退出策略**（默认 keep）：keep = 子进程保持运行，重启工具后按 runs.json（PID + 启动时间）重识别；stopAll = 退出前逐项目杀树
- **日志**：配置 logFilePath 则 tail 文件（跟随 rename 轮转/截断/删除重建），否则捕获 stdout（GBK/UTF-8 首个非 ASCII 序列才锁编码；项目级覆盖逃生口），10MB 轮转、run 数可配

## 已知限制（ADR Consequences，显式接受）

1. 重识别进程的 stdout 管道不可重挂——工具离线期间与其后的 stdout 增量不可捕获（历史已落盘可查；长时间运行的服务建议配置日志文件路径）
2. 工具离线期间进程死亡的退出码不可知（显示「退出码未知」）
3. 重识别 RUNNING 状态存在至多一个轮询周期（5–10s）的过期窗口
4. 7777 被外部占用时 HTTP 通道不可用直至人工介入（stdio 桥接兜底，Agent 侧无感）
5. 日志时间范围检索依赖行首时间戳可解析（无时间戳行归属其前最近有时间戳的行）
6. WMI 病态宿主下停止可能降级为仅杀主进程（见下节）

## WMI 病态宿主的降级行为

部分 Windows 宿主 WMI 间歇性病态（`Get-CimInstance` 挂死 >90s、`taskkill /T /F` 61s+）。javamgr 已全面避开 taskkill/tasklist：

- **停止路径**：单次 PowerShell「CIM 枚举（`-OperationTimeoutSec 1`）+ Stop-Process 批杀」。病态时预算内收敛：枚举失败 → 只杀主进程，结果带 `note` 且 `ok=true`（实测病态宿主 ~1.7s，对照 taskkill 61s）；派生子进程可能残留，需单独清理
- **探活/轮询**：`process.kill(pid, 0)` 零开销判活；镜像名与启动时间走一次批量 `Get-Process`（PSAPI）。批量超时记「未验证」跳过，绝不误判死亡、不堆积挂死助手
- **自测**：`Get-CimInstance Win32_Process -OperationTimeoutSec 2` 超时即病态；`winmgmt /verifyrepository` 或重启 Winmgmt 服务通常自愈，届时树终止自动恢复全量枚举

## 测试夹具（scripts/fixtures）

`Loggy.java`：单文件 JDK 11+，参数控制行为——`mode=plain|gbk|sleep`、`interval`、`children=N`（树终止）、`log=路径 + rotate=N`（轮转跟随）、`exit-after/exit-code`（异常退出）。手工编译见 `scripts/fixtures/README.md`；集成测试自动编译。
