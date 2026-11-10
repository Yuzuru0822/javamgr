<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Jdk, JdkValidation } from '@shared/types'
import { ipc } from '@renderer/api/ipc'
import { useJdksStore } from '@renderer/stores/jdks'
import { useProjectsStore } from '@renderer/stores/projects'

/**
 * JDK 管理页（计划 §2.4 / §3 S2.2）：
 * - 扫描按钮：扫描中 loading + jdk:scanProgress 进度提示；
 * - 手动添加 / 编辑路径：对话框输入路径 → 防抖 400ms 调 jdk:validate 即时反馈
 *   （成功显示派生的版本/发行方，失败显示原因）→ 提交时主进程复检入库；
 * - 删除：被项目引用时禁用并 tooltip 提示（主进程 removeJdk 还有 CONFLICT 兜底）。
 */
const jdksStore = useJdksStore()
const projectsStore = useProjectsStore()

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ---------- 被引用项目数（从 projects store 派生） ----------

const refCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const p of projectsStore.projects) {
    counts.set(p.jdkId, (counts.get(p.jdkId) ?? 0) + 1)
  }
  return counts
})

const refCountOf = (jdk: Jdk): number => refCounts.value.get(jdk.id) ?? 0

// ---------- 扫描 ----------

const scanButtonText = computed(() => {
  if (!jdksStore.scanning) return '扫描 JDK'
  const p = jdksStore.progress
  return p ? `扫描中（已查 ${p.scanned} 个目录，发现 ${p.found} 个）…` : '扫描中…'
})

async function handleScan(): Promise<void> {
  try {
    await jdksStore.scan()
    ElMessage.success(`扫描完成：当前共 ${jdksStore.jdks.length} 个 JDK（手动添加的条目已保留）`)
  } catch (err) {
    ElMessage.error(`扫描失败：${errText(err)}`)
  }
}

// ---------- 添加 / 编辑对话框（共用：路径输入 + 即时校验） ----------

const dialog = reactive({
  visible: false,
  mode: 'add' as 'add' | 'edit',
  editingId: '',
  homePath: '',
  name: '',
  validating: false,
  validation: null as JdkValidation | null
})

const VALIDATE_DEBOUNCE_MS = 400
let validateTimer: ReturnType<typeof setTimeout> | null = null

function openAdd(): void {
  dialog.mode = 'add'
  dialog.editingId = ''
  dialog.homePath = ''
  dialog.name = ''
  dialog.validation = null
  dialog.visible = true
}

function openEdit(jdk: Jdk): void {
  dialog.mode = 'edit'
  dialog.editingId = jdk.id
  dialog.homePath = jdk.homePath
  dialog.name = jdk.name
  dialog.validation = null
  dialog.visible = true
}

// 路径变化 → 防抖即时校验（jdk:validate 不入库，纯反馈；提交时主进程复检兜底）
watch(
  () => dialog.homePath,
  (value) => {
    if (validateTimer) clearTimeout(validateTimer)
    dialog.validation = null
    const trimmed = value.trim()
    if (!trimmed) return
    validateTimer = setTimeout(() => {
      void (async () => {
        dialog.validating = true
        try {
          dialog.validation = await ipc.jdk.validate(trimmed)
        } catch {
          dialog.validation = null // IPC 异常不展开：提交时服务端复检会给出明确错误
        } finally {
          dialog.validating = false
        }
      })()
    }, VALIDATE_DEBOUNCE_MS)
  }
)

const canSubmit = computed(
  () => dialog.homePath.trim().length > 0 && !dialog.validating && dialog.validation?.ok === true
)

async function submitDialog(): Promise<void> {
  const homePath = dialog.homePath.trim()
  const name = dialog.name.trim()
  try {
    if (dialog.mode === 'add') {
      await jdksStore.add(homePath, name || undefined)
      ElMessage.success('JDK 已添加')
    } else {
      await jdksStore.update(dialog.editingId, homePath, name || undefined)
      ElMessage.success('JDK 已更新')
    }
    dialog.visible = false
  } catch (err) {
    // VALIDATION_ERROR（路径校验失败）等在此提示，对话框保持打开供修正
    ElMessage.error(errText(err))
  }
}

// ---------- 删除（被引用时禁用，主进程 CONFLICT 兜底） ----------

async function handleRemove(jdk: Jdk): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除 JDK「${jdk.name}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return // 用户取消
  }
  try {
    await jdksStore.remove(jdk.id)
    ElMessage.success(`已删除「${jdk.name}」`)
  } catch (err) {
    ElMessage.error(errText(err))
  }
}

// ---------- 生命周期 ----------

onMounted(() => {
  jdksStore.bindScanProgress()
  void jdksStore.refresh().catch((err: unknown) => {
    ElMessage.error(`JDK 列表加载失败：${errText(err)}`)
  })
  // 引用计数依赖项目列表；直达本页（未经过项目面板）时补拉一次
  if (!projectsStore.loaded) {
    void projectsStore.refresh().catch(() => {})
  }
})

onBeforeUnmount(() => {
  jdksStore.unbindScanProgress()
  if (validateTimer) clearTimeout(validateTimer)
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h2>JDK 管理</h2>
      <span class="hint">
        扫描标准目录（Program Files 各发行版 + JAVA_HOME + 设置页追加目录）；手动添加走同一套校验
      </span>
    </div>

    <div class="toolbar">
      <el-button type="primary" :loading="jdksStore.scanning" @click="handleScan">
        {{ scanButtonText }}
      </el-button>
      <el-button :disabled="jdksStore.scanning" @click="openAdd">手动添加</el-button>
    </div>

    <el-table v-if="jdksStore.jdks.length > 0" :data="jdksStore.jdks" size="default">
      <el-table-column prop="name" label="名称" min-width="200" show-overflow-tooltip />
      <el-table-column prop="version" label="版本" width="130" show-overflow-tooltip />
      <el-table-column prop="vendor" label="发行方" min-width="140" show-overflow-tooltip />
      <el-table-column prop="homePath" label="路径" min-width="280" show-overflow-tooltip />
      <el-table-column label="来源" width="84" align="center">
        <template #default="{ row }">
          <el-tag :type="row.source === 'manual' ? 'warning' : 'info'" size="small">
            {{ row.source === 'manual' ? '手动' : '扫描' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="被引用" width="100" align="center">
        <template #default="{ row }">
          <el-tag v-if="refCountOf(row) > 0" type="success" size="small">
            {{ refCountOf(row) }} 个项目
          </el-tag>
          <span v-else class="muted">无</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑路径</el-button>
          <el-tooltip
            :disabled="refCountOf(row) === 0"
            content="被项目引用，不能删除；请先删除这些项目或改绑其他 JDK"
            placement="top"
          >
            <span class="disabled-wrap">
              <el-button link type="danger" :disabled="refCountOf(row) > 0" @click="handleRemove(row)">
                删除
              </el-button>
            </span>
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-else description="暂无 JDK：点击「扫描 JDK」自动发现本机已装 JDK，或「手动添加」指定路径" />

    <el-dialog
      v-model="dialog.visible"
      :title="dialog.mode === 'add' ? '手动添加 JDK' : '编辑 JDK 路径'"
      width="580px"
    >
      <el-form label-width="90px">
        <el-form-item label="JDK 路径" required>
          <el-input v-model="dialog.homePath" placeholder="如 D:\java17（目录须含 bin\java.exe）" clearable />
        </el-form-item>
        <el-form-item label="校验结果">
          <span v-if="dialog.validating" class="muted">正在校验…</span>
          <el-alert
            v-else-if="dialog.validation?.ok"
            type="success"
            :closable="false"
            :title="`校验通过：${dialog.validation.jdk?.name ?? ''}`"
            :description="`版本 ${dialog.validation.jdk?.version ?? '-'} · 发行方 ${
              dialog.validation.jdk?.vendor ?? '-'
            }`"
          />
          <el-alert
            v-else-if="dialog.validation"
            type="error"
            :closable="false"
            :title="dialog.validation.error ?? '校验失败'"
          />
          <span v-else class="muted">输入路径后自动校验</span>
        </el-form-item>
        <el-form-item label="显示名称">
          <el-input v-model="dialog.name" :placeholder="dialog.validation?.jdk?.name ?? '留空使用自动派生名称'" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.visible = false">取消</el-button>
        <el-button type="primary" :disabled="!canSubmit" @click="submitDialog">
          {{ dialog.mode === 'add' ? '添加' : '保存' }}
        </el-button>
      </template>
    </el-dialog>
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
.muted {
  color: var(--el-text-color-secondary);
}
.disabled-wrap {
  margin-left: 8px;
}
</style>
