<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { JarScanEntry } from '@shared/types'
import { ipc } from '@renderer/api/ipc'
import { useJdksStore } from '@renderer/stores/jdks'

/**
 * jar 扫描导入对话框（2026-11-10）：
 * 指定目录 → projects:scanJars 递归收集 *.jar（已纳管条目标注且不可勾选）→
 * 勾选子集 + 逐行编辑项目名/绑定 JDK（支持一键应用到所选）→
 * 循环 projects:create 批量纳管（单项失败不中断，失败行保留勾选供修正）。
 * 默认项目名 = 文件名去扩展（服务层 suggestedName）；JDK 默认空需显式指定。
 */

const visible = defineModel<boolean>('visible', { required: true })

const emit = defineEmits<{
  /** 本次有项目成功创建（父组件刷新项目列表） */
  imported: []
}>()

const jdksStore = useJdksStore()

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ---------- 第 1 步：目录与扫描 ----------

const rootDir = ref('')
const scanning = ref(false)
const scanned = ref(false)
const truncated = ref(false)
const skippedDirs = ref<string[]>([])

async function pickDir(): Promise<void> {
  const picked = await ipc.app.pickFile({ title: '选择 jar 扫描根目录', directory: true })
  if (picked !== null) rootDir.value = picked
}

async function scan(): Promise<void> {
  const dir = rootDir.value.trim()
  if (dir === '') {
    ElMessage.warning('请先填写扫描目录')
    return
  }
  scanning.value = true
  try {
    const result = await ipc.projects.scanJars(dir)
    rows.value = result.jars.map((entry) => ({
      entry,
      checked: !entry.alreadyManaged,
      name: entry.suggestedName,
      jdkId: ''
    }))
    truncated.value = result.truncated
    skippedDirs.value = result.skippedDirs
    scanned.value = true
    if (result.jars.length === 0) ElMessage.info('该目录（含子目录）下没有找到 jar 包')
    if (result.truncated) ElMessage.warning(`结果超过上限已截断，仅显示前 ${result.jars.length} 个`)
  } catch (err) {
    ElMessage.error(`扫描失败：${errText(err)}`)
  } finally {
    scanning.value = false
  }
}

// ---------- 第 2 步：勾选与批量指派 ----------

interface ImportRow {
  entry: JarScanEntry
  checked: boolean
  name: string
  jdkId: string
}

const rows = ref<ImportRow[]>([])
const bulkJdkId = ref('')

const checkableRows = computed(() => rows.value.filter((r) => !r.entry.alreadyManaged))
const checkedRows = computed(() => checkableRows.value.filter((r) => r.checked))
const allChecked = computed(
  () => checkableRows.value.length > 0 && checkedRows.value.length === checkableRows.value.length
)
const someChecked = computed(
  () => checkedRows.value.length > 0 && checkedRows.value.length < checkableRows.value.length
)

function toggleAll(checked: boolean): void {
  for (const row of checkableRows.value) row.checked = checked
}

function applyBulkJdk(): void {
  if (bulkJdkId.value === '') {
    ElMessage.warning('请先选择要批量应用的 JDK')
    return
  }
  if (checkedRows.value.length === 0) {
    ElMessage.info('当前没有勾选任何 jar')
    return
  }
  for (const row of checkedRows.value) row.jdkId = bulkJdkId.value
  ElMessage.success(`已将 JDK 应用到所选 ${checkedRows.value.length} 个 jar`)
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

// ---------- 第 3 步：批量新增 ----------

const creating = ref(false)

async function createSelected(): Promise<void> {
  if (checkedRows.value.length === 0 || creating.value) return
  if (!jdksStore.loaded) await jdksStore.refresh().catch(() => {})

  // 行内校验：名称非空 + JDK 已指定（错误行标红提示，不发 IPC）
  const invalid: string[] = []
  for (const row of checkedRows.value) {
    if (row.name.trim() === '') invalid.push(`${row.entry.suggestedName}：项目名称为空`)
    else if (row.jdkId === '') invalid.push(`${row.name.trim()}：未绑定 JDK`)
  }
  if (invalid.length > 0) {
    ElMessage.warning({ message: `请修正后再提交——${invalid.join('；')}`, duration: 6000 })
    return
  }

  creating.value = true
  const failures: string[] = []
  let created = 0
  try {
    for (const row of checkedRows.value) {
      try {
        await ipc.projects.create({
          name: row.name.trim(),
          jarPath: row.entry.path,
          jdkId: row.jdkId,
          jvmArgs: [],
          programArgs: [],
          envVars: {}
        })
        created++
        row.checked = false // 成功行取消勾选（失败行保留供修正）
      } catch (err) {
        failures.push(`${row.name.trim()}：${errText(err)}`)
      }
    }
    if (created > 0) emit('imported')
    if (failures.length === 0) {
      ElMessage.success(`批量新增完成（${created} 个项目）`)
      visible.value = false
    } else {
      ElMessage.warning({
        message: `新增成功 ${created} 个，失败 ${failures.length} 个——${failures.join('；')}`,
        duration: 8000
      })
    }
  } finally {
    creating.value = false
  }
}

// ---------- 生命周期 ----------

// immediate：父组件初始即置 visible=true 时也拉取 JDK 列表（批量按钮依赖非空才可用）
watch(
  visible,
  (open) => {
    if (!open) return
    if (!jdksStore.loaded) jdksStore.refresh().catch(() => {})
  },
  { immediate: true }
)
</script>

<template>
  <el-dialog
    v-model="visible"
    title="扫描导入 jar（递归收集 → 勾选 → 批量纳管）"
    width="880px"
  >
    <!-- 第 1 步：目录 + 扫描 -->
    <div class="scan-bar">
      <el-input
        v-model="rootDir"
        placeholder="扫描根目录（绝对路径，含子目录递归）"
        clearable
        class="dir-input"
        @keyup.enter="scan"
      />
      <el-button :loading="scanning" @click="pickDir">浏览…</el-button>
      <el-button type="primary" :loading="scanning" @click="scan">开始扫描</el-button>
    </div>

    <!-- 第 2 步：结果与批量指派 -->
    <template v-if="scanned">
      <div class="result-bar">
        <el-checkbox
          :model-value="allChecked"
          :indeterminate="someChecked"
          :disabled="checkableRows.length === 0"
          @update:model-value="(v: boolean) => toggleAll(v)"
        >
          全选未纳管（{{ checkedRows.length }}/{{ checkableRows.length }}）
        </el-checkbox>
        <span class="count">
          共 {{ rows.length }} 个 jar<template v-if="rows.length - checkableRows.length > 0">
            （已纳管 {{ rows.length - checkableRows.length }}，灰色不可选）</template
          >
        </span>
        <span class="spacer" />
        <el-select
          v-model="bulkJdkId"
          placeholder="选择 JDK 批量应用"
          class="bulk-jdk"
          size="small"
        >
          <el-option v-for="j in jdksStore.jdks" :key="j.id" :value="j.id" :label="j.name" />
        </el-select>
        <el-button size="small" @click="applyBulkJdk">应用到所选</el-button>
      </div>

      <div v-if="skippedDirs.length > 0" class="skipped">
        {{ skippedDirs.length }} 个子目录因权限等原因被跳过：{{ skippedDirs.join('；') }}
      </div>

      <div class="rows">
        <div
          v-for="row in rows"
          :key="row.entry.path"
          class="row"
          :class="{ managed: row.entry.alreadyManaged }"
        >
          <el-checkbox
            v-model="row.checked"
            :disabled="row.entry.alreadyManaged"
            :aria-label="`选择 ${row.entry.suggestedName}`"
          />
          <el-input
            v-model="row.name"
            :disabled="row.entry.alreadyManaged"
            size="small"
            class="name-input"
            placeholder="项目名称"
          />
          <el-select
            v-model="row.jdkId"
            :disabled="row.entry.alreadyManaged"
            size="small"
            class="jdk-select"
            placeholder="绑定 JDK"
          >
            <el-option v-for="j in jdksStore.jdks" :key="j.id" :value="j.id" :label="j.name" />
          </el-select>
          <span class="path" :title="`${row.entry.path}（修改于 ${row.entry.mtimeIso}）`">
            {{ row.entry.path }}
          </span>
          <span class="size">{{ formatSize(row.entry.sizeBytes) }}</span>
          <el-tag v-if="row.entry.alreadyManaged" size="small" type="info">已纳管</el-tag>
        </div>
      </div>
    </template>
    <el-empty
      v-else
      description="填写目录后点击「开始扫描」：递归收集 *.jar，勾选后批量指定项目名与 JDK 一键纳管"
      :image-size="60"
    />

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button
        type="primary"
        :disabled="checkedRows.length === 0 || jdksStore.jdks.length === 0"
        :loading="creating"
        @click="createSelected"
      >
        批量新增（{{ checkedRows.length }}）
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.scan-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.dir-input {
  flex: 1;
}
.result-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.count {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.bulk-jdk {
  width: 200px;
}
.skipped {
  color: var(--el-color-warning);
  font-size: 12px;
  margin-bottom: 8px;
  word-break: break-all;
}
.rows {
  max-height: 46vh;
  overflow: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.row:last-child {
  border-bottom: none;
}
.row.managed {
  background: var(--el-fill-color-light);
}
.name-input {
  width: 180px;
  flex: none;
}
.jdk-select {
  width: 160px;
  flex: none;
}
.path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  direction: rtl; /* 长路径截尾：保住文件名一端 */
  text-align: left;
}
.size {
  flex: none;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  width: 64px;
  text-align: right;
}
</style>
