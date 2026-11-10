<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { EventLoopMetrics, McpInfo } from '@shared/types'
import { ipc, ipcEvents } from '@renderer/api/ipc'
import { useSettingsStore } from '@renderer/stores/settings'

/**
 * 设置页（计划 §2.4 / §3 S5.4 + S6.1 完整接通）：
 * - MCP 接入（S5.4）：启用开关 + 契约端口（改端口 = 主动重签契约）、URL/桥接命令复制、
 *   端口被占错误与占用进程名展示、Agent 配置样例；
 * - 运行状况（N-6）：主进程事件循环延迟打点（P95/最近/样本数 + 演进条件提示）；
 * - 退出策略（keep 默认 | stopAll，切换二次确认）；
 * - 启动与轮询：startupGraceSeconds / pollIntervalSeconds（5–10）；
 * - 日志保留：tailInitialLines / 单文件 MB / 轮转保留数 / run 保留数；
 * - JDK 扫描根目录管理（增删，叠加默认根 + JAVA_HOME）；
 * - 关闭行为：关闭到托盘。
 * 保存全部即时生效（settings:set 局部合并 + 变更即写盘）；各项热生效性在提示文案注明
 * （轮询间隔/grace/退出策略/关闭到托盘/保留参数热生效；tail 行数对下次跟随生效；
 * 扫描根目录下次扫描生效——服务层均为读取时取值，无缓存）。
 */

const settingsStore = useSettingsStore()

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ==================== MCP（S5.4，保持既有行为） ====================

const mcpInfo = ref<McpInfo | null>(null)
const mcpEnabledLocal = ref(true)
const mcpPortLocal = ref(7777)
const savingMcp = ref(false)

/** mcp:portChanged → 重拉接入信息与设置镜像（端口/开关可能已被其他入口修改） */
async function refreshMcpInfo(): Promise<void> {
  try {
    mcpInfo.value = await ipc.app.getMcpInfo()
    if (settingsStore.settings) {
      mcpEnabledLocal.value = settingsStore.settings.mcpEnabled
      mcpPortLocal.value = settingsStore.settings.mcpPort
    }
  } catch (err) {
    console.error('读取 MCP 接入信息失败：', err)
  }
}

async function saveMcpEnabled(enabled: boolean): Promise<void> {
  savingMcp.value = true
  try {
    await settingsStore.save({ mcpEnabled: enabled })
    await refreshMcpInfo()
    ElMessage.success(enabled ? 'MCP 服务已启用' : 'MCP 服务已停用')
  } catch (err) {
    ElMessage.error(`保存失败：${errText(err)}`)
    mcpEnabledLocal.value = !enabled
  } finally {
    savingMcp.value = false
  }
}

/** 端口变更即保存（= 主动重签契约：主进程重启监听并广播 user-changed） */
async function saveMcpPort(port: number | undefined): Promise<void> {
  if (port === undefined || port === settingsStore.settings?.mcpPort) return
  savingMcp.value = true
  try {
    await settingsStore.save({ mcpPort: port })
    await refreshMcpInfo()
    ElMessage.success(`MCP 端口已改为 ${port}（Agent 侧 HTTP 配置需同步更新）`)
  } catch (err) {
    ElMessage.error(`保存失败：${errText(err)}`)
    mcpPortLocal.value = settingsStore.settings?.mcpPort ?? 7777
  } finally {
    savingMcp.value = false
  }
}

// ==================== 运行状况（N-6） ====================

const eventLoop = ref<EventLoopMetrics | null>(null)
let eventLoopTimer: ReturnType<typeof setInterval> | null = null

async function refreshEventLoop(): Promise<void> {
  try {
    eventLoop.value = await ipc.app.getEventLoopMetrics()
  } catch {
    // 静默：指标查看属增强信息，失败不打扰
  }
}

// ==================== 通用保存（局部合并 + 失败回滚本地镜像） ====================

const saving = ref(false)

/** 保存一组设置；revert 失败时把本地控件回滚到 store 权威值 */
async function savePatch(
  patch: Parameters<typeof settingsStore.save>[0],
  successText: string,
  revert?: () => void
): Promise<boolean> {
  saving.value = true
  try {
    await settingsStore.save(patch)
    ElMessage.success(successText)
    return true
  } catch (err) {
    ElMessage.error(`保存失败：${errText(err)}`)
    revert?.()
    return false
  } finally {
    saving.value = false
  }
}

function syncFromStore(): void {
  const s = settingsStore.settings
  if (!s) return
  mcpEnabledLocal.value = s.mcpEnabled
  mcpPortLocal.value = s.mcpPort
  exitPolicyLocal.value = s.exitPolicy
  graceLocal.value = s.startupGraceSeconds
  pollLocal.value = s.pollIntervalSeconds
  tailLinesLocal.value = s.tailInitialLines
  logMbLocal.value = s.logMaxFileMb
  rotationsLocal.value = s.logMaxRotations
  runsKeepLocal.value = s.logRunsToKeep
  scanRootsLocal.value = [...s.scanRoots]
  closeToTrayLocal.value = s.closeToTray
}

// ==================== 退出策略（S6.1：切换二次确认） ====================

const exitPolicyLocal = ref<'keep' | 'stopAll'>('keep')

const EXIT_POLICY_TEXT: Record<'keep' | 'stopAll', { title: string; desc: string }> = {
  keep: {
    title: '保持运行（默认）',
    desc: '工具退出时子进程保持运行（分离进程）；重启工具后按 PID 自动重识别状态。'
  },
  stopAll: {
    title: '退出时全部停止',
    desc: '退出工具前逐项目终止进程树（单项 8s 超时，失败不阻塞其余）。'
  }
}

async function onExitPolicyChange(next: 'keep' | 'stopAll'): Promise<void> {
  const prev = settingsStore.settings?.exitPolicy ?? 'keep'
  if (next === prev) return
  const text = EXIT_POLICY_TEXT[next]
  const confirmed = await ElMessageBox.confirm(
    `${text.desc}\n\n确定切换为「${text.title}」吗？该策略在下次退出工具时生效。`,
    '切换退出策略',
    { confirmButtonText: '确认切换', cancelButtonText: '取消', type: next === 'stopAll' ? 'warning' : 'info' }
  )
    .then(() => true)
    .catch(() => false)
  if (!confirmed) {
    exitPolicyLocal.value = prev
    return
  }
  await savePatch({ exitPolicy: next }, `退出策略已切换为「${text.title}」`, () => {
    exitPolicyLocal.value = prev
  })
}

// ==================== 启动与轮询（热生效：服务层读取时取值） ====================

const graceLocal = ref(5)
const pollLocal = ref(5)

async function saveGrace(value: number | undefined): Promise<void> {
  if (value === undefined || value === settingsStore.settings?.startupGraceSeconds) return
  const prev = settingsStore.settings?.startupGraceSeconds ?? 5
  const ok = await savePatch({ startupGraceSeconds: value }, `无输出兜底时长已改为 ${value}s（对后续启动生效）`, () => {
    graceLocal.value = prev
  })
  if (!ok && graceLocal.value !== settingsStore.settings?.startupGraceSeconds) {
    graceLocal.value = settingsStore.settings?.startupGraceSeconds ?? 5
  }
}

async function savePoll(value: number | undefined): Promise<void> {
  if (value === undefined || value === settingsStore.settings?.pollIntervalSeconds) return
  const prev = settingsStore.settings?.pollIntervalSeconds ?? 5
  await savePatch({ pollIntervalSeconds: value }, `存活轮询间隔已改为 ${value}s（即时生效）`, () => {
    pollLocal.value = prev
  })
}

// ==================== 日志保留（热生效：写入/清理按新值） ====================

const tailLinesLocal = ref(200)
const logMbLocal = ref(10)
const rotationsLocal = ref(3)
const runsKeepLocal = ref(10)

async function saveTailLines(value: number | undefined): Promise<void> {
  if (value === undefined || value === settingsStore.settings?.tailInitialLines) return
  await savePatch({ tailInitialLines: value }, `初始回读行数已改为 ${value}（对下次日志跟随生效）`, () => {
    tailLinesLocal.value = settingsStore.settings?.tailInitialLines ?? 200
  })
}

async function saveLogMb(value: number | undefined): Promise<void> {
  if (value === undefined || value === settingsStore.settings?.logMaxFileMb) return
  await savePatch({ logMaxFileMb: value }, `单文件上限已改为 ${value}MB（即时生效，超出轮转）`, () => {
    logMbLocal.value = settingsStore.settings?.logMaxFileMb ?? 10
  })
}

async function saveRotations(value: number | undefined): Promise<void> {
  if (value === undefined || value === settingsStore.settings?.logMaxRotations) return
  await savePatch({ logMaxRotations: value }, `每 run 轮转保留数已改为 ${value}（即时生效）`, () => {
    rotationsLocal.value = settingsStore.settings?.logMaxRotations ?? 3
  })
}

async function saveRunsKeep(value: number | undefined): Promise<void> {
  if (value === undefined || value === settingsStore.settings?.logRunsToKeep) return
  await savePatch({ logRunsToKeep: value }, `每项目保留 run 数已改为 ${value}（即时生效）`, () => {
    runsKeepLocal.value = settingsStore.settings?.logRunsToKeep ?? 10
  })
}

// ==================== 扫描根目录管理（下次扫描生效） ====================

const scanRootsLocal = ref<string[]>([])
const newScanRoot = ref('')

async function persistScanRoots(next: string[], successText: string): Promise<void> {
  const prev = settingsStore.settings?.scanRoots ?? []
  await savePatch({ scanRoots: next }, successText, () => {
    scanRootsLocal.value = [...prev]
  })
}

async function addScanRoot(): Promise<void> {
  const root = newScanRoot.value.trim()
  if (root === '') {
    ElMessage.warning('请输入目录路径')
    return
  }
  const normalized = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
  if (scanRootsLocal.value.some((r) => normalized(r) === normalized(root))) {
    ElMessage.warning('该目录已在列表中')
    return
  }
  const next = [...scanRootsLocal.value, root]
  newScanRoot.value = ''
  await persistScanRoots(next, `扫描根目录已添加：${root}（下次扫描生效）`)
}

async function removeScanRoot(root: string): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `确定移除扫描根目录「${root}」吗？已识别的 JDK 条目不受影响，仅后续扫描不再覆盖该目录。`,
    '移除确认',
    { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning' }
  )
    .then(() => true)
    .catch(() => false)
  if (!confirmed) return
  await persistScanRoots(
    scanRootsLocal.value.filter((r) => r !== root),
    `已移除扫描根目录：${root}`
  )
}

// ==================== 关闭行为（热生效：close 事件时读取） ====================

const closeToTrayLocal = ref(true)

async function saveCloseToTray(value: boolean): Promise<void> {
  const prev = settingsStore.settings?.closeToTray ?? true
  await savePatch({ closeToTray: value }, value ? '已开启：关闭窗口最小化到托盘' : '已关闭：关闭窗口即退出（执行退出策略）', () => {
    closeToTrayLocal.value = prev
  })
}

// ==================== 复制 ====================

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`${label} 已复制`)
  } catch {
    // 剪贴板 API 不可用时的兜底（隐藏 textarea + execCommand）
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    if (ok) ElMessage.success(`${label} 已复制`)
    else ElMessage.error('复制失败，请手动选择复制')
  }
}

// ==================== Agent 配置样例（§2.6 末尾接入样例） ====================

/** 把 `"exe 路径" --mcp-stdio` 形式的桥接命令拆为 command + args（供 stdio JSON 样例） */
function splitBridgeCommand(command: string): { command: string; args: string[] } {
  const trimmed = command.trim()
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1)
    if (end > 0) {
      return {
        command: trimmed.slice(1, end),
        args: trimmed.slice(end + 1).trim().split(/\s+/).filter(Boolean)
      }
    }
  }
  const parts = trimmed.split(/\s+/)
  return { command: parts[0] ?? trimmed, args: parts.slice(1) }
}

const httpSample = computed(() => {
  const port = mcpInfo.value?.port ?? mcpPortLocal.value
  return JSON.stringify(
    { mcpServers: { javamgr: { url: `http://127.0.0.1:${port}/mcp` } } },
    null,
    2
  )
})

const stdioSample = computed(() => {
  const parts = splitBridgeCommand(mcpInfo.value?.bridgeCommand ?? 'javamgr.exe --mcp-stdio')
  return JSON.stringify(
    { mcpServers: { javamgr: { command: parts.command, args: parts.args } } },
    null,
    2
  )
})

const mcpStatusLabel = computed(() => {
  if (!settingsStore.settings?.mcpEnabled) return { text: '已禁用', type: 'info' as const }
  if (mcpInfo.value?.enabled) return { text: '运行中', type: 'success' as const }
  return { text: '启动失败', type: 'danger' as const }
})

// ==================== 生命周期 ====================

let unsubscribePortChanged: (() => void) | null = null

onMounted(async () => {
  if (!settingsStore.loaded) await settingsStore.load()
  syncFromStore()
  await refreshMcpInfo()
  unsubscribePortChanged = ipcEvents.portChanged(() => {
    void refreshMcpInfo()
    syncFromStore() // 端口/开关可能经其他入口变更，同步全量镜像
  })
  await refreshEventLoop()
  eventLoopTimer = setInterval(() => void refreshEventLoop(), 3_000)
})

onBeforeUnmount(() => {
  unsubscribePortChanged?.()
  unsubscribePortChanged = null
  if (eventLoopTimer !== null) {
    clearInterval(eventLoopTimer)
    eventLoopTimer = null
  }
})
</script>

<template>
  <div class="page">
    <h2>设置</h2>

    <el-card shadow="never" class="block-card">
      <template #header>
        <div class="card-header">
          <span>MCP 服务（Agent 接入）</span>
          <el-tag :type="mcpStatusLabel.type" size="small">{{ mcpStatusLabel.text }}</el-tag>
        </div>
      </template>

      <!-- 端口被占：显式报错 + 占用进程名（R4/A15：绝不静默漂移，其余功能不受影响） -->
      <el-alert
        v-if="mcpInfo?.error"
        type="error"
        :closable="false"
        show-icon
        class="mcp-error"
        :title="`MCP 服务启动失败：端口 ${mcpInfo.port} 被占用`"
      >
        <div>
          {{ mcpInfo.error }}
          <span v-if="mcpInfo.occupantName" class="occupant">
            占用进程：{{ mcpInfo.occupantName }}
          </span>
        </div>
        <div class="field-hint">
          Agent 可改用下方 stdio 桥接接入（不含端口、自动发现主实例，不受本错误影响）。
        </div>
      </el-alert>

      <el-form label-width="120px" label-position="left">
        <el-form-item label="启用 MCP 服务">
          <el-switch
            v-model="mcpEnabledLocal"
            :loading="savingMcp"
            @change="(value: string | number | boolean) => saveMcpEnabled(Boolean(value))"
          />
        </el-form-item>

        <el-form-item label="契约端口">
          <el-input-number
            v-model="mcpPortLocal"
            :min="1"
            :max="65535"
            :disabled="savingMcp"
            @change="(value: number | undefined) => saveMcpPort(value)"
          />
          <div class="field-hint">
            端口是 Agent 侧的 URL 契约：被占用时不会自动改用其他端口。
            <strong>更改后需同步更新 Agent 侧配置</strong>（= 主动重签契约）。
          </div>
        </el-form-item>

        <el-form-item label="HTTP 接入地址">
          <el-input :model-value="mcpInfo?.url ?? `http://127.0.0.1:${mcpPortLocal}/mcp`" readonly>
            <template #append>
              <el-button @click="copyText(mcpInfo?.url ?? `http://127.0.0.1:${mcpPortLocal}/mcp`, '接入地址')">复制</el-button>
            </template>
          </el-input>
          <div class="field-hint">仅绑定 127.0.0.1，本机 Agent 可直连。</div>
        </el-form-item>

        <el-form-item label="stdio 桥接命令">
          <el-input :model-value="mcpInfo?.bridgeCommand ?? 'javamgr.exe --mcp-stdio'" readonly>
            <template #append>
              <el-button @click="copyText(mcpInfo?.bridgeCommand ?? 'javamgr.exe --mcp-stdio', '桥接命令')">复制</el-button>
            </template>
          </el-input>
          <div class="field-hint">不含端口、永远有效：自动发现主实例（优先 mcp.port，递增探测 7777–7786）。</div>
        </el-form-item>
      </el-form>

      <el-divider content-position="left">Agent 配置样例</el-divider>

      <div class="samples">
        <div class="sample">
          <div class="sample-head">
            <span>HTTP（固定契约端口）</span>
            <el-button size="small" @click="copyText(httpSample, 'HTTP 配置样例')">复制</el-button>
          </div>
          <pre class="sample-json">{{ httpSample }}</pre>
        </div>
        <div class="sample">
          <div class="sample-head">
            <span>stdio（桥接，推荐）</span>
            <el-button size="small" @click="copyText(stdioSample, 'stdio 配置样例')">复制</el-button>
          </div>
          <pre class="sample-json">{{ stdioSample }}</pre>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="block-card">
      <template #header>
        <div class="card-header">
          <span>退出策略</span>
          <el-tag size="small" :type="exitPolicyLocal === 'keep' ? 'success' : 'warning'">
            {{ exitPolicyLocal === 'keep' ? '保持运行' : '退出时全部停止' }}
          </el-tag>
        </div>
      </template>
      <el-radio-group
        v-model="exitPolicyLocal"
        :disabled="saving"
        @change="(value: string | number | boolean) => onExitPolicyChange(value as 'keep' | 'stopAll')"
      >
        <el-radio value="keep">
          {{ EXIT_POLICY_TEXT.keep.title }}
          <span class="radio-desc">—— 工具退出不杀子进程，重启后按 PID 重识别状态</span>
        </el-radio>
        <el-radio value="stopAll">
          {{ EXIT_POLICY_TEXT.stopAll.title }}
          <span class="radio-desc">—— 退出前逐项目终止进程树（单项 8s 超时）</span>
        </el-radio>
      </el-radio-group>
      <div class="field-hint">
        切换需二次确认；策略在下次退出工具时生效（托盘菜单「退出」或关闭窗口且未开启关闭到托盘）。
      </div>
    </el-card>

    <el-card shadow="never" class="block-card">
      <template #header><span>启动与轮询</span></template>
      <el-form label-width="200px" label-position="left">
        <el-form-item label="无输出兜底时长（秒）">
          <el-input-number
            v-model="graceLocal"
            :min="1"
            :max="600"
            :disabled="saving"
            @change="(value: number | undefined) => saveGrace(value)"
          />
          <div class="field-hint">
            启动后无任何日志输出时，存活满该秒数即视为 RUNNING（对后续启动即时生效）。
          </div>
        </el-form-item>
        <el-form-item label="重识别存活轮询间隔（秒）">
          <el-input-number
            v-model="pollLocal"
            :min="5"
            :max="10"
            :disabled="saving"
            @change="(value: number | undefined) => savePoll(value)"
          />
          <div class="field-hint">
            重识别（无句柄）进程的批量存活轮询周期，5–10 秒（即时生效：每轮读取最新值）。
            新启动进程为事件驱动，不受此参数影响。
          </div>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" class="block-card">
      <template #header><span>日志保留</span></template>
      <el-form label-width="200px" label-position="left">
        <el-form-item label="初始回读行数">
          <el-input-number
            v-model="tailLinesLocal"
            :min="1"
            :max="10000"
            :disabled="saving"
            @change="(value: number | undefined) => saveTailLines(value)"
          />
          <div class="field-hint">日志文件 tail 启动时回读的尾部行数（对下次日志跟随生效）。</div>
        </el-form-item>
        <el-form-item label="单 run 文件上限（MB）">
          <el-input-number
            v-model="logMbLocal"
            :min="1"
            :max="1024"
            :disabled="saving"
            @change="(value: number | undefined) => saveLogMb(value)"
          />
          <div class="field-hint">stdout 落盘单文件超限后轮转为 .1/.2/…（即时生效）。</div>
        </el-form-item>
        <el-form-item label="每 run 轮转保留数">
          <el-input-number
            v-model="rotationsLocal"
            :min="1"
            :max="10"
            :disabled="saving"
            @change="(value: number | undefined) => saveRotations(value)"
          />
          <div class="field-hint">每 run 保留的轮转文件个数（即时生效）。</div>
        </el-form-item>
        <el-form-item label="每项目保留 run 数">
          <el-input-number
            v-model="runsKeepLocal"
            :min="1"
            :max="100"
            :disabled="saving"
            @change="(value: number | undefined) => saveRunsKeep(value)"
          />
          <div class="field-hint">每项目保留最近 N 个 run 的日志（更早清理，即时生效）。</div>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" class="block-card">
      <template #header><span>JDK 扫描根目录</span></template>
      <div class="field-hint roots-hint">
        扫描时在默认根目录（C:\Program Files 下常见发行版目录等）与 JAVA_HOME 之外追加扫描的目录（下次扫描生效）。
      </div>
      <div v-if="scanRootsLocal.length === 0" class="roots-empty">暂无自定义扫描根目录</div>
      <ul v-else class="roots-list">
        <li v-for="root in scanRootsLocal" :key="root" class="roots-item">
          <span class="roots-path">{{ root }}</span>
          <el-button size="small" type="danger" plain :disabled="saving" @click="removeScanRoot(root)">移除</el-button>
        </li>
      </ul>
      <div class="roots-add">
        <el-input
          v-model="newScanRoot"
          placeholder="输入目录绝对路径，如 D:\java"
          clearable
          @keyup.enter="addScanRoot"
        />
        <el-button type="primary" :disabled="saving" @click="addScanRoot">添加</el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="block-card">
      <template #header><span>关闭行为</span></template>
      <el-form label-width="200px" label-position="left">
        <el-form-item label="关闭窗口最小化到托盘">
          <el-switch
            v-model="closeToTrayLocal"
            :disabled="saving"
            @change="(value: string | number | boolean) => saveCloseToTray(Boolean(value))"
          />
          <div class="field-hint">
            开启：点窗口关闭按钮仅隐藏到托盘（即时生效）；关闭：直接进入退出流程并执行退出策略。
            退出程序请使用托盘菜单「退出」。
          </div>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" class="block-card">
      <template #header>
        <div class="card-header">
          <span>运行状况（主进程）</span>
          <el-tag
            size="small"
            :type="eventLoop?.sustainedHigh ? 'danger' : 'success'"
          >
            {{ eventLoop?.sustainedHigh ? '延迟持续偏高' : '正常' }}
          </el-tag>
        </div>
      </template>
      <el-descriptions :column="3" border size="small" class="perf-desc">
        <el-descriptions-item label="事件循环延迟 P95">
          {{ eventLoop ? `${eventLoop.p95Ms} ms` : '—' }}
        </el-descriptions-item>
        <el-descriptions-item label="最近采样延迟">
          {{ eventLoop ? `${eventLoop.lastMs} ms` : '—' }}
        </el-descriptions-item>
        <el-descriptions-item label="窗口样本数">
          {{ eventLoop ? `${eventLoop.samples}（${Math.round(eventLoop.windowMs / 1000)}s 窗口）` : '—' }}
        </el-descriptions-item>
      </el-descriptions>
      <div class="field-hint">
        每 3 秒刷新。P95 &gt; 100ms 且持续 30s 属于日志子系统 utilityProcess 演进的量化触发条件之一
        （另一条：单项目持续日志吞吐 &gt; 2,000 行/秒）；当前单机 7 项目量级通常远低于该阈值。
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.block-card {
  max-width: 860px;
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mcp-error {
  margin-bottom: 16px;
}

.occupant {
  font-weight: 600;
  margin-left: 8px;
}

.field-hint {
  width: 100%;
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.radio-desc {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.samples {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.sample-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-weight: 600;
}

.sample-json {
  margin: 0;
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  overflow: auto;
}

.roots-hint {
  margin-top: 0;
  margin-bottom: 8px;
}

.roots-empty {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  padding: 8px 0;
}

.roots-list {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
}

.roots-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
}

.roots-path {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}

.roots-add {
  display: flex;
  gap: 8px;
}

.perf-desc {
  margin-bottom: 8px;
}
</style>
