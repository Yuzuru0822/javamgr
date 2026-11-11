<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ProjectWithRuntime } from '@shared/types'
import { useProjectsStore } from '@renderer/stores/projects'
import { useJdksStore } from '@renderer/stores/jdks'
import { ipc } from '@renderer/api/ipc'
import { isSortKey, sortProjects } from '@renderer/utils/project-sort'
import type { ProjectSortKey, ProjectSortOrder } from '@renderer/utils/project-sort'
import ProjectCard from '@renderer/components/ProjectCard.vue'
import ProjectTable from '@renderer/components/ProjectTable.vue'
import ProjectForm from '@renderer/components/ProjectForm.vue'
import JarImportDialog from '@renderer/components/JarImportDialog.vue'
import LogViewer from '@renderer/components/LogViewer.vue'

/**
 * 项目面板（计划 §2.4 / §3 S3.6 + S4.7）：卡片/列表双视图 + 批量工具条（全部启动/停止）。
 * 实时状态：store 已在 App 层订阅 proc:statusChanged；本视图仅秒级 tick 派生 uptime。
 * S4："查看日志"打开 LogViewer 抽屉（实时滚动/暂停/过滤/上下文检索，支持项目切换）。
 * v0.6.0：卡片/分页列表可切换；名称/状态/运行时间/PID 排序对两种视图同时生效；
 * 视图/排序/分页大小为纯 UI 偏好，持久化在 localStorage（Electron 窗口与浏览器面板同源生效）。
 */
const store = useProjectsStore()
const jdksStore = useJdksStore()

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ---------- uptime 秒级 tick（RUNNING 卡片共用一个时钟） ----------
const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null

// ---------- 系统版本号（页头右上角；失败静默留空，不阻塞面板） ----------
const appVersion = ref('')

// ---------- 视图 / 排序 / 分页（v0.6.0：纯 UI 偏好持久化 localStorage） ----------

const LS = {
  view: 'javamgr.dashboard.view',
  sortKey: 'javamgr.dashboard.sortKey',
  sortOrder: 'javamgr.dashboard.sortOrder',
  pageSize: 'javamgr.dashboard.pageSize'
} as const

function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null // 隐私模式等存储不可用时按默认处理
  }
}

function writeLS(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 持久化失败不影响本次会话内生效 */
  }
}

const PAGE_SIZES = [10, 20, 50, 100]

const viewMode = ref<'card' | 'list'>(readLS(LS.view) === 'list' ? 'list' : 'card')
const savedKey = readLS(LS.sortKey)
const sortKey = ref<ProjectSortKey>(isSortKey(savedKey) ? savedKey : 'default')
const sortOrder = ref<ProjectSortOrder>(readLS(LS.sortOrder) === 'desc' ? 'desc' : 'asc')
const pageSize = ref(
  PAGE_SIZES.find((s) => s === Number(readLS(LS.pageSize))) ?? PAGE_SIZES[1]!
)
const currentPage = ref(1)

watch(viewMode, (v) => writeLS(LS.view, v))
watch(pageSize, (v) => writeLS(LS.pageSize, String(v)))
// 字段与方向成对写盘：sortOrder 值可能不变（如从 desc 名称切到 desc 状态），
// 单独 watch 会漏写，恢复时方向会串档
watch([sortKey, sortOrder], ([key, order]) => {
  writeLS(LS.sortKey, key)
  writeLS(LS.sortOrder, order)
})

/** 排序条件变化后回到第 1 页（内容重排后停留原页码意义不大） */
watch([sortKey, sortOrder], () => {
  currentPage.value = 1
})

/** 删除项目/改页大小导致总页数缩水时收拢页码，避免停留在空页 */
watch(
  [() => store.projects.length, pageSize],
  ([total, size]) => {
    const maxPage = Math.max(1, Math.ceil(total / size))
    if (currentPage.value > maxPage) currentPage.value = maxPage
  }
)

const sortedProjects = computed(() =>
  sortProjects(store.projects, sortKey.value, sortOrder.value, now.value)
)

/** 列表视图当前页行（卡片视图不分页，直接渲染排序全集） */
const pagedProjects = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return sortedProjects.value.slice(start, start + pageSize.value)
})

function toggleSortOrder(): void {
  sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
}

/** 列表表头排序点击（sortable="custom"）：null = 第三次点击取消排序，恢复默认顺序 */
function onTableSortChange(
  prop: string,
  order: 'ascending' | 'descending' | null
): void {
  if (order === null || !isSortKey(prop) || prop === 'default') {
    sortKey.value = 'default'
    return
  }
  sortKey.value = prop
  sortOrder.value = order === 'descending' ? 'desc' : 'asc'
}

// ---------- 表单 ----------
const formVisible = ref(false)
const editingProject = ref<ProjectWithRuntime | null>(null)

/** jar 扫描导入对话框（2026-11-10）：有项目成功创建时刷新列表 */
const importVisible = ref(false)

function handleImported(): void {
  store.refresh().catch((err: unknown) => ElMessage.error(`项目列表刷新失败：${errText(err)}`))
}

function openCreate(): void {
  editingProject.value = null
  formVisible.value = true
}

function openEdit(project: ProjectWithRuntime): void {
  editingProject.value = project
  formVisible.value = true
}

// ---------- 日志查看器（S4：抽屉承载，LogViewer 内含项目切换） ----------
const logDrawerVisible = ref(false)
const logProjectId = ref('')

function openLogs(project: ProjectWithRuntime): void {
  logProjectId.value = project.id
  logDrawerVisible.value = true
}

// ---------- 单项操作 ----------

async function handleStart(id: string): Promise<void> {
  const result = await store.start(id)
  if (result.ok) {
    // 幂等语义：RUNNING/STARTING 下重复启动返回当前态，同样视为成功
    ElMessage.success(`启动指令已受理（pid=${result.pid ?? '-'}，状态 ${result.status ?? '-'})`)
  } else {
    ElMessage.error(`启动失败：${result.error ?? '未知错误'}`)
  }
}

async function handleStop(id: string): Promise<void> {
  const result = await store.stop(id)
  if (result.ok) {
    ElMessage.success(`已停止（耗时 ${result.durationMs ?? 0}ms）`)
  } else {
    ElMessage.error(`停止失败：${result.error ?? '未知错误'}`)
  }
}

async function handleRestart(id: string): Promise<void> {
  const result = await store.restart(id)
  if (result.ok) {
    ElMessage.success(`重启完成（新 pid=${result.pid ?? '-'}）`)
  } else {
    ElMessage.error(`重启失败：${result.error ?? '未知错误'}`)
  }
}

// ---------- 删除（confirm 编排：运行中先停再删，主进程走操作队列等进程树死亡） ----------

async function handleRemove(project: ProjectWithRuntime): Promise<void> {
  const running = project.status === 'RUNNING' || project.status === 'STARTING'
  try {
    await ElMessageBox.confirm(
      running
        ? `项目「${project.name}」正在运行：确认删除将先停止进程（含子进程树）并移除纳管。继续？`
        : `确定删除项目「${project.name}」吗？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return // 用户取消
  }
  try {
    await store.remove(project.id, true) // confirm=true：主进程先 stop 再删配置
    ElMessage.success(`已删除「${project.name}」`)
  } catch (err) {
    ElMessage.error(errText(err))
  }
}

// ---------- 批量操作 ----------

const batchBusy = ref(false)

async function handleStartAll(): Promise<void> {
  batchBusy.value = true
  try {
    const batch = await store.startAll()
    const failed = batch.results.filter((r) => !r.ok)
    if (failed.length === 0) ElMessage.success(`全部启动完成（${batch.results.length} 个项目）`)
    else ElMessage.warning(`启动完成：成功 ${batch.results.length - failed.length}，失败 ${failed.length}`)
  } catch (err) {
    ElMessage.error(`全部启动失败：${errText(err)}`)
  } finally {
    batchBusy.value = false
  }
}

async function handleStopAll(): Promise<void> {
  batchBusy.value = true
  try {
    const batch = await store.stopAll()
    const failed = batch.results.filter((r) => !r.ok)
    if (failed.length === 0) ElMessage.success(`全部停止完成（${batch.results.length} 个项目）`)
    else ElMessage.warning(`停止完成：成功 ${batch.results.length - failed.length}，失败 ${failed.length}`)
  } catch (err) {
    ElMessage.error(`全部停止失败：${errText(err)}`)
  } finally {
    batchBusy.value = false
  }
}

// ---------- 多选批量（2026-11-10）：勾选卡片子集批量 启动/重启/停止 ----------

/** 选集整体替换（Set 经 ref 持有，替换触发响应；逐项增删不触发） */
const selectedIds = ref(new Set<string>())
const selectedCount = computed(() => selectedIds.value.size)

function toggleSelect(id: string, checked: boolean): void {
  const next = new Set(selectedIds.value)
  if (checked) next.add(id)
  else next.delete(id)
  selectedIds.value = next
}

function selectAll(): void {
  selectedIds.value = new Set(store.projects.map((p) => p.id))
}

function clearSelection(): void {
  selectedIds.value = new Set()
}

const allSelected = computed(
  () => store.projects.length > 0 && selectedCount.value === store.projects.length
)
const someSelected = computed(
  () => selectedCount.value > 0 && selectedCount.value < store.projects.length
)

// 列表变化（删除项目/刷新）时剔除已消失的 id，避免对幽灵 id 发起批量操作
watch(
  () => store.projects,
  (projects) => {
    const alive = new Set(projects.map((p) => p.id))
    const next = new Set([...selectedIds.value].filter((id) => alive.has(id)))
    if (next.size !== selectedIds.value.size) selectedIds.value = next
  }
)

/**
 * 对所选子集批量执行单项启停通道（与全部启动/停止同语义：主进程按 projectId
 * 操作队列串行化，不同项目并发、单项失败不中断；结果汇总提示）。
 */
async function runBatchOnSelected(op: 'start' | 'restart' | 'stop'): Promise<void> {
  const ids = [...selectedIds.value]
  if (ids.length === 0 || batchBusy.value) return
  const label = op === 'start' ? '启动' : op === 'restart' ? '重启' : '停止'
  batchBusy.value = true
  try {
    const settled = await Promise.allSettled(ids.map((id) => store[op](id)))
    const failures: string[] = []
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value.ok) return
      const name = store.projects.find((p) => p.id === ids[i])?.name ?? ids[i]
      failures.push(
        `${name}：${
          result.status === 'rejected'
            ? errText(result.reason)
            : (result.value.error ?? '未知错误')
        }`
      )
    })
    if (failures.length === 0) {
      ElMessage.success(`所选${label}完成（${ids.length} 个项目）`)
    } else {
      ElMessage.warning({
        message: `所选${label}：成功 ${ids.length - failures.length}，失败 ${failures.length}——${failures.join('；')}`,
        duration: 6000
      })
    }
  } finally {
    batchBusy.value = false
  }
}

// ---------- JDK 名映射 ----------

const jdkNameById = computed(() => {
  const map = new Map<string, string>()
  for (const jdk of jdksStore.jdks) map.set(jdk.id, jdk.name)
  return map
})

const jdkNameOf = (project: ProjectWithRuntime): string =>
  jdkNameById.value.get(project.jdkId) ?? '（JDK 缺失）'

// ---------- 生命周期 ----------

onMounted(() => {
  store.refresh().catch((err: unknown) => ElMessage.error(`项目列表加载失败：${errText(err)}`))
  if (!jdksStore.loaded) {
    jdksStore.refresh().catch(() => {}) // JDK 名映射缺失时静默降级（卡片显示"JDK 缺失"）
  }
  ipc.app
    .getVersion()
    .then((v) => {
      appVersion.value = v
    })
    .catch(() => {}) // 版本获取失败仅不展示，不影响面板功能
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer)
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h2>项目面板</h2>
      <span class="hint">启停经主进程操作队列串行化；状态红绿灯四态（绿运行/灰停止/黄启动中/红异常退出）</span>
      <span v-if="appVersion !== ''" class="version">v{{ appVersion }}</span>
    </div>

    <div class="toolbar">
      <el-button type="primary" @click="openCreate">新建项目</el-button>
      <el-button plain @click="importVisible = true">扫描导入</el-button>
      <el-button
        type="success"
        :disabled="store.projects.length === 0 || batchBusy"
        :loading="batchBusy"
        @click="handleStartAll"
      >
        全部启动
      </el-button>
      <el-button
        type="danger"
        plain
        :disabled="store.projects.length === 0 || batchBusy"
        :loading="batchBusy"
        @click="handleStopAll"
      >
        全部停止
      </el-button>
      <el-divider direction="vertical" />
      <el-checkbox
        :model-value="allSelected"
        :indeterminate="someSelected"
        :disabled="store.projects.length === 0"
        @update:model-value="(v: boolean) => (v ? selectAll() : clearSelection())"
      >
        全选（{{ selectedCount }}/{{ store.projects.length }}）
      </el-checkbox>
      <el-button
        type="success"
        plain
        :disabled="selectedCount === 0 || batchBusy"
        @click="runBatchOnSelected('start')"
      >
        启动所选
      </el-button>
      <el-button
        :disabled="selectedCount === 0 || batchBusy"
        @click="runBatchOnSelected('restart')"
      >
        重启所选
      </el-button>
      <el-button
        type="danger"
        plain
        :disabled="selectedCount === 0 || batchBusy"
        @click="runBatchOnSelected('stop')"
      >
        停止所选
      </el-button>
      <el-button
        v-if="selectedCount > 0"
        link
        :disabled="batchBusy"
        @click="clearSelection"
      >
        取消选择
      </el-button>
      <span class="toolbar-spacer" />
      <el-radio-group v-model="viewMode" size="small">
        <el-radio-button value="card">卡片</el-radio-button>
        <el-radio-button value="list">列表</el-radio-button>
      </el-radio-group>
      <el-select
        v-model="sortKey"
        size="small"
        class="sort-select"
        aria-label="排序字段"
      >
        <el-option label="默认排序" value="default" />
        <el-option label="按名称" value="name" />
        <el-option label="按状态" value="status" />
        <el-option label="按运行时间" value="uptime" />
        <el-option label="按 PID" value="pid" />
      </el-select>
      <el-button
        size="small"
        :disabled="sortKey === 'default'"
        :aria-label="sortOrder === 'asc' ? '切换为降序' : '切换为升序'"
        @click="toggleSortOrder"
      >
        {{ sortOrder === 'asc' ? '升序' : '降序' }}
      </el-button>
    </div>

    <div v-if="store.projects.length > 0 && viewMode === 'card'" class="grid">
      <ProjectCard
        v-for="project in sortedProjects"
        :key="project.id"
        :project="project"
        :jdk-name="jdkNameOf(project)"
        :now="now"
        :selected="selectedIds.has(project.id)"
        @select="toggleSelect"
        @start="handleStart"
        @stop="handleStop"
        @restart="handleRestart"
        @logs="openLogs"
        @edit="openEdit"
        @remove="handleRemove"
      />
    </div>
    <template v-else-if="store.projects.length > 0 && viewMode === 'list'">
      <ProjectTable
        :projects="pagedProjects"
        :jdk-names="jdkNameById"
        :now="now"
        :selected-ids="selectedIds"
        :sort-key="sortKey"
        :sort-order="sortOrder"
        @sort-change="onTableSortChange"
        @select="toggleSelect"
        @start="handleStart"
        @stop="handleStop"
        @restart="handleRestart"
        @logs="openLogs"
        @edit="openEdit"
        @remove="handleRemove"
      />
      <div class="pagination">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :total="store.projects.length"
          :page-sizes="PAGE_SIZES"
          size="small"
          background
          layout="total, sizes, prev, pager, next"
        />
      </div>
    </template>
    <el-empty v-else description="暂无纳管项目：点击「新建项目」注册预构建 jar（配置持久化在 userData/config/projects.json）" />

    <ProjectForm v-model:visible="formVisible" :project="editingProject" />

    <JarImportDialog v-model:visible="importVisible" @imported="handleImported" />

    <el-drawer
      v-model="logDrawerVisible"
      title="日志查看器"
      size="72%"
      destroy-on-close
      append-to-body
    >
      <LogViewer v-if="logDrawerVisible && logProjectId !== ''" :project-id="logProjectId" />
    </el-drawer>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.version {
  margin-left: auto;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  flex-wrap: wrap;
}
.toolbar-spacer {
  flex: 1;
}
.sort-select {
  width: 120px;
}
.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
}
</style>
