<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ProjectWithRuntime } from '@shared/types'
import { useProjectsStore } from '@renderer/stores/projects'
import { useJdksStore } from '@renderer/stores/jdks'
import ProjectCard from '@renderer/components/ProjectCard.vue'
import ProjectForm from '@renderer/components/ProjectForm.vue'
import LogViewer from '@renderer/components/LogViewer.vue'

/**
 * 项目面板（计划 §2.4 / §3 S3.6 + S4.7）：卡片网格 + 批量工具条（全部启动/停止）。
 * 实时状态：store 已在 App 层订阅 proc:statusChanged；本视图仅秒级 tick 派生 uptime。
 * S4："查看日志"打开 LogViewer 抽屉（实时滚动/暂停/过滤/上下文检索，支持项目切换）。
 */
const store = useProjectsStore()
const jdksStore = useJdksStore()

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ---------- uptime 秒级 tick（RUNNING 卡片共用一个时钟） ----------
const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null

// ---------- 表单 ----------
const formVisible = ref(false)
const editingProject = ref<ProjectWithRuntime | null>(null)

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
    </div>

    <div class="toolbar">
      <el-button type="primary" @click="openCreate">新建项目</el-button>
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
    </div>

    <div v-if="store.projects.length > 0" class="grid">
      <ProjectCard
        v-for="project in store.projects"
        :key="project.id"
        :project="project"
        :jdk-name="jdkNameOf(project)"
        :now="now"
        @start="handleStart"
        @stop="handleStop"
        @restart="handleRestart"
        @logs="openLogs"
        @edit="openEdit"
        @remove="handleRemove"
      />
    </div>
    <el-empty v-else description="暂无纳管项目：点击「新建项目」注册预构建 jar（配置持久化在 userData/config/projects.json）" />

    <ProjectForm v-model:visible="formVisible" :project="editingProject" />

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
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
}
</style>
