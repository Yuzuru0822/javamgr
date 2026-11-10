<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { LogLevel, LogMatch, SearchResult } from '@shared/types'
import { parseLogLevel } from '@shared/log-format'
import { ipc } from '@renderer/api/ipc'
import { useProjectsStore } from '@renderer/stores/projects'
import { useLogsStore, LOG_BUFFER_LIMIT } from '@renderer/stores/logs'
import LogFilterBar from '@renderer/components/LogFilterBar.vue'

/**
 * 日志查看器（计划 §2.4 / §3 S4.7，A6/A7）：
 * - 实时追加 + 自动贴底（用户上滚即脱离贴底，暂停/恢复或滚动到底重新贴底）；
 * - 暂停：视口冻结（数据仍持续入 store 缓冲，A6）；恢复/跳最新 = 快照缓冲尾部；
 * - 来源徽标（file/stdout，按项目配置路由）；项目切换下拉；
 * - 虚拟滚动：固定行高窗口化渲染（>2000 行仅渲染可视切片，缓冲环形上限 5000 行，
 *   更早走"加载更早"readHistory）；
 * - 过滤（关键字大小写不敏感 + 级别）与跳转匹配（上/下一个）；查看命中上下文
 *   调 logs:search（±contextLines，覆盖主进程全量历史）。
 */

const props = defineProps<{
  /** 初始打开的项目（可在下拉中切换） */
  projectId: string
}>()

const projectsStore = useProjectsStore()
const logsStore = useLogsStore()

const LINE_HEIGHT = 20
const OVERSCAN = 10

// ---------- 项目与视图状态 ----------
const currentProjectId = ref(props.projectId)
const displayLines = ref<string[]>([])
const historyLoading = ref(false)
const loadMoreLoading = ref(false)

const currentProject = computed(() =>
  projectsStore.projects.find((p) => p.id === currentProjectId.value)
)
/** 来源徽标：按项目配置路由（logFilePath 存在 = file） */
const sourceBadge = computed<'file' | 'stdout'>(() =>
  currentProject.value?.logFilePath ? 'file' : 'stdout'
)

// ---------- 过滤与跳转 ----------

const filtering = computed(() => logsStore.keyword.trim() !== '' || logsStore.levelFilter !== '')

const filteredLines = computed(() => {
  if (!filtering.value) return displayLines.value
  const kw = logsStore.keyword.trim().toLowerCase()
  const level = logsStore.levelFilter
  return displayLines.value.filter((line) => {
    if (kw !== '' && !line.toLowerCase().includes(kw)) return false
    if (level !== '' && parseLogLevel(line) !== level) return false
    return true
  })
})

/** 虚拟滚动渲染的列表：过滤生效时即过滤视图（A7：过滤 ERROR 只见错误行） */
const displayList = computed(() => (filtering.value ? filteredLines.value : displayLines.value))

const matchIndex = ref(1) // 1 基，指向 displayList（= 过滤视图）
const matchCount = computed(() => (filtering.value ? displayList.value.length : 0))

function clampMatchIndex(): void {
  if (matchIndex.value > matchCount.value) matchIndex.value = Math.max(1, matchCount.value)
}

function jumpToMatch(index: number): void {
  const count = matchCount.value
  if (count === 0) return
  matchIndex.value = ((index - 1 + count) % count) + 1
  scrollToIndex(matchIndex.value - 1)
}

function goPrevMatch(): void {
  jumpToMatch(matchIndex.value - 1)
}

function goNextMatch(): void {
  jumpToMatch(matchIndex.value + 1)
}

/**
 * 重置过滤（2026-11-10 修复"重置按钮失效"）：仅清 keyword/level 时，视图停留在过滤
 * 期间被 scrollToIndex(0) 拉到的顶部且 pinned 已脱离——日志继续追加却不自动滚动，
 * 看起来按钮没生效。完整语义 = 清条件 + 未暂停时恢复贴底跟随（displayLines 全量
 * 保留，仅重新定位到底部；暂停中冻结视口，由「恢复滚动」负责追平）。
 */
function clearFilter(): void {
  logsStore.keyword = ''
  logsStore.levelFilter = ''
  matchIndex.value = 1
  if (!logsStore.paused) {
    pinned.value = true
    void nextTick(() => scrollToBottom())
  }
}

watch([() => logsStore.keyword, () => logsStore.levelFilter], () => {
  matchIndex.value = 1
  if (filtering.value) void nextTick(() => scrollToIndex(0))
})

// ---------- 上下文检索（logs:search，覆盖主进程全量历史） ----------

const CONTEXT_LINES = 5
const contextVisible = ref(false)
const contextLoading = ref(false)
const contextResult = ref<SearchResult | null>(null)
const contextTruncated = ref(false)

async function showContext(): Promise<void> {
  if (!filtering.value) {
    ElMessage.info('请先输入关键字或选择级别，再查看上下文')
    return
  }
  contextVisible.value = true
  contextLoading.value = true
  contextResult.value = null
  try {
    contextResult.value = await ipc.logs.search({
      projectId: currentProjectId.value,
      ...(logsStore.keyword.trim() !== '' ? { keyword: logsStore.keyword.trim() } : {}),
      ...(logsStore.levelFilter !== '' ? { level: logsStore.levelFilter } : {}),
      contextLines: CONTEXT_LINES,
      maxResults: 100
    })
    contextTruncated.value = contextResult.value.truncated
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
    contextVisible.value = false
  } finally {
    contextLoading.value = false
  }
}

const contextEntries = computed<LogMatch[]>(() => contextResult.value?.matches ?? [])

// ---------- 历史加载 ----------

async function reload(): Promise<void> {
  const projectId = currentProjectId.value
  logsStore.setActiveProject(projectId)
  displayLines.value = []
  matchIndex.value = 1
  lastBufferLen.value = logsStore.bufferedCount
  historyLoading.value = true
  try {
    const history = await ipc.logs.readHistory({ projectId, lines: 500, source: 'auto' })
    // 订阅先于 readHistory 绑定：await 期间新到的行在缓冲 marker 之后，无缝拼接不重复
    const fresh = logsStore.snapshot(projectId).slice(lastBufferLen.value)
    displayLines.value = [...history.lines, ...fresh]
  } catch (err) {
    ElMessage.error(`日志历史读取失败：${err instanceof Error ? err.message : String(err)}`)
    displayLines.value = logsStore.snapshot(projectId)
  } finally {
    historyLoading.value = false
    pinned.value = true
    void nextTick(() => scrollToBottom())
  }
}

/** 加载更早：readHistory(2000) 与当前视图按首行锚点去重前拼 */
async function loadEarlier(): Promise<void> {
  if (loadMoreLoading.value) return
  loadMoreLoading.value = true
  try {
    const anchor = displayLines.value[0]
    const history = await ipc.logs.readHistory({
      projectId: currentProjectId.value,
      lines: 2000,
      source: 'auto'
    })
    if (history.lines.length === 0) {
      ElMessage.info('没有更早的日志了')
      return
    }
    if (anchor === undefined) {
      displayLines.value = history.lines
      return
    }
    const anchorIdx = history.lines.indexOf(anchor)
    displayLines.value =
      anchorIdx >= 0
        ? [...history.lines.slice(0, anchorIdx), ...displayLines.value]
        : [...history.lines, ...displayLines.value]
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    loadMoreLoading.value = false
  }
}

// ---------- 实时追加（暂停冻结视口，缓冲继续，A6） ----------

const lastBufferLen = ref(0)

watch(
  () => logsStore.bufferedCount,
  (newLen) => {
    if (logsStore.activeProjectId !== currentProjectId.value) return
    if (logsStore.paused) return // 暂停：视口不动，数据已在 store 缓冲
    const snapshot = logsStore.snapshot(currentProjectId.value)
    const fresh = newLen >= lastBufferLen.value ? snapshot.slice(lastBufferLen.value) : snapshot
    lastBufferLen.value = newLen
    if (fresh.length === 0) return
    const merged = [...displayLines.value, ...fresh]
    displayLines.value = merged.length > LOG_BUFFER_LIMIT
      ? merged.slice(merged.length - LOG_BUFFER_LIMIT)
      : merged
    clampMatchIndex()
    if (pinned.value) void nextTick(() => scrollToBottom())
  }
)

function togglePause(): void {
  logsStore.paused = !logsStore.paused
  if (!logsStore.paused) jumpToLatest()
}

/**
 * 恢复贴底并跳到最新（暂停恢复 / 手动跳最新共用）。
 * 2026-11-10 修复：原实现用缓冲快照**替换** displayLines——缓冲只含打开查看器后
 * 实时到达的行（readHistory 的历史不在其中），历史被清空、视图"跳空"。改为**合并**
 * 追加 marker 之后到达的新行（与实时追加 watcher 同款去重逻辑），全量保留 + 滚底。
 */
function jumpToLatest(): void {
  const snapshot = logsStore.snapshot(currentProjectId.value)
  const fresh = snapshot.length >= lastBufferLen.value ? snapshot.slice(lastBufferLen.value) : []
  lastBufferLen.value = snapshot.length
  if (fresh.length > 0) {
    const merged = [...displayLines.value, ...fresh]
    displayLines.value =
      merged.length > LOG_BUFFER_LIMIT ? merged.slice(merged.length - LOG_BUFFER_LIMIT) : merged
  }
  clampMatchIndex()
  pinned.value = true
  void nextTick(() => scrollToBottom())
}

// ---------- 虚拟滚动 ----------

const scrollRef = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(400)
const pinned = ref(true)

const totalLines = computed(() => displayList.value.length)
const startIdx = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / LINE_HEIGHT) - OVERSCAN)
)
const renderSlice = computed(() => {
  const visible = Math.ceil(viewportHeight.value / LINE_HEIGHT) + OVERSCAN * 2
  return displayList.value.slice(startIdx.value, startIdx.value + visible)
})

function onScroll(): void {
  const el = scrollRef.value
  if (!el) return
  scrollTop.value = el.scrollTop
  pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

function scrollToBottom(): void {
  const el = scrollRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  scrollTop.value = el.scrollTop
  pinned.value = true
}

function scrollToIndex(index: number): void {
  const el = scrollRef.value
  if (!el) return
  el.scrollTop = Math.max(0, index * LINE_HEIGHT - el.clientHeight / 2)
  scrollTop.value = el.scrollTop
}

// ---------- 生命周期 ----------

watch(currentProjectId, () => {
  void reload()
})

onMounted(() => {
  logsStore.bindEvents()
  if (!projectsStore.loaded) {
    projectsStore.refresh().catch(() => {})
  }
  const el = scrollRef.value
  if (el) viewportHeight.value = el.clientHeight || 400
  void reload()
})

onBeforeUnmount(() => {
  logsStore.setActiveProject(null)
})

const formatLevel = (line: string): LogLevel => parseLogLevel(line)
</script>

<template>
  <div class="log-viewer">
    <div class="head">
      <el-select
        v-model="currentProjectId"
        filterable
        placeholder="切换项目"
        class="project-select"
      >
        <el-option
          v-for="p in projectsStore.projects"
          :key="p.id"
          :value="p.id"
          :label="p.name"
        />
      </el-select>
      <el-tag :type="sourceBadge === 'file' ? 'primary' : 'success'" size="small" effect="plain">
        {{ sourceBadge === 'file' ? '日志文件 tail' : 'stdout 捕获' }}
      </el-tag>
      <span class="stats">
        视图 {{ displayList.length }} 行<template v-if="filtering">（命中 {{ matchCount }}）</template>
        · 缓冲 {{ logsStore.bufferedCount }} 行（上限 {{ LOG_BUFFER_LIMIT }}，更早走"加载更早"）
      </span>
      <span class="spacer" />
      <el-tag v-if="logsStore.paused && logsStore.hasNewWhilePaused" type="warning" size="small">
        暂停中有新日志
      </el-tag>
      <el-button size="small" :loading="loadMoreLoading" @click="loadEarlier">加载更早</el-button>
      <el-button size="small" @click="jumpToLatest">跳到最新</el-button>
      <el-button
        size="small"
        :type="logsStore.paused ? 'warning' : 'default'"
        @click="togglePause"
      >
        {{ logsStore.paused ? '恢复滚动' : '暂停滚动' }}
      </el-button>
    </div>

    <LogFilterBar
      v-model:keyword="logsStore.keyword"
      v-model:level="logsStore.levelFilter"
      :match-count="matchCount"
      :match-index="matchCount === 0 ? 0 : matchIndex"
      @prev="goPrevMatch"
      @next="goNextMatch"
      @context="showContext"
      @clear="clearFilter"
    />

    <div
      ref="scrollRef"
      v-loading="historyLoading"
      class="scroll"
      @scroll="onScroll"
    >
      <div class="inner" :style="{ height: `${totalLines * LINE_HEIGHT}px` }">
        <div
          v-for="(line, i) in renderSlice"
          :key="startIdx + i"
          class="line"
          :class="{
            match: filtering && startIdx + i === matchIndex - 1,
            warn: formatLevel(line) === 'WARN',
            error: formatLevel(line) === 'ERROR' || formatLevel(line) === 'FATAL'
          }"
          :style="{ top: `${(startIdx + i) * LINE_HEIGHT}px` }"
          :title="line"
        >{{ line }}</div>
      </div>
      <div v-if="totalLines === 0 && !historyLoading" class="empty">
        暂无日志：启动项目后实时输出将在此滚动（stdout 项目首行到达即转 RUNNING）
      </div>
    </div>

    <el-dialog
      v-model="contextVisible"
      title="命中上下文（logs:search，±5 行，主进程全量历史）"
      width="760px"
    >
      <div v-loading="contextLoading" class="context-body">
        <el-alert
          v-if="contextTruncated"
          type="warning"
          :closable="false"
          show-icon
          title="结果已截断（命中数达上限或扫描行数上限），可收紧条件后重试"
          class="context-alert"
        />
        <div v-if="contextEntries.length === 0 && !contextLoading" class="empty">
          没有命中的日志行
        </div>
        <div
          v-for="entry in contextEntries"
          :key="entry.lineNo"
          class="context-line"
          :title="entry.timestamp ? `行 ${entry.lineNo} · ${entry.timestamp}` : `行 ${entry.lineNo}`"
        >
          <span class="line-no">{{ entry.lineNo }}</span>
          <span class="text">{{ entry.text }}</span>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.log-viewer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.project-select {
  width: 200px;
}
.stats {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.scroll {
  flex: 1;
  min-height: 260px;
  overflow: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  background: var(--el-fill-color-blank);
  font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 20px;
}
.inner {
  position: relative;
  width: max-content;
  min-width: 100%;
}
.line {
  position: absolute;
  left: 0;
  right: auto;
  white-space: pre;
  padding: 0 10px;
  height: 20px;
}
.line.match {
  background: var(--el-color-warning-light-7);
  outline: 1px solid var(--el-color-warning-light-5);
}
.line.warn {
  color: var(--el-color-warning);
}
.line.error {
  color: var(--el-color-danger);
  font-weight: 600;
}
.empty {
  padding: 24px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  text-align: center;
}
.context-body {
  max-height: 60vh;
  overflow: auto;
  font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
  font-size: 12px;
}
.context-alert {
  margin-bottom: 8px;
}
.context-line {
  display: flex;
  gap: 8px;
  padding: 1px 4px;
  white-space: pre-wrap;
  word-break: break-all;
}
.context-line .line-no {
  color: var(--el-text-color-secondary);
  min-width: 56px;
  text-align: right;
  flex: none;
}
.context-line .text {
  flex: 1;
}
</style>
