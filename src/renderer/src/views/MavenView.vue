<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Maven, MavenValidation } from '@shared/types'
import { ipc } from '@renderer/api/ipc'
import { useMavensStore } from '@renderer/stores/mavens'
import { useProjectsStore } from '@renderer/stores/projects'

/**
 * Maven 管理页（2026-11-18，形态对齐 JdkView）：
 * - 自动探测：M2_HOME / MAVEN_HOME / PATH（瞬间完成，无进度事件）；手动条目含自定义
 *   settings/仓库配置，探测合并时不覆盖；
 * - 手动添加 / 编辑：路径输入 → 防抖 400ms 调 maven:validate 即时反馈（成功显示派生版本 +
 *   conf\settings.xml 解析出的 localRepository 建议，失败显示原因）→ 提交时主进程复检入库；
 * - settings.xml / 本地仓库路径：可选；编辑时空串提交 = 显式清除（null 语义）；
 * - 删除：被项目构建配置引用时禁用并 tooltip 提示（主进程 removeMaven 有 CONFLICT 兜底）。
 */
const mavensStore = useMavensStore()
const projectsStore = useProjectsStore()

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ---------- 被引用项目数（从 projects store 派生，构建配置 mavenId 绑定） ----------

const refCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const p of projectsStore.projects) {
    if (p.mavenId) counts.set(p.mavenId, (counts.get(p.mavenId) ?? 0) + 1)
  }
  return counts
})

const refCountOf = (maven: Maven): number => refCounts.value.get(maven.id) ?? 0

// ---------- 自动探测 ----------

async function handleScan(): Promise<void> {
  try {
    await mavensStore.scan()
    ElMessage.success(
      `探测完成：当前共 ${mavensStore.mavens.length} 个 Maven（手动添加的条目已保留）`
    )
  } catch (err) {
    ElMessage.error(`探测失败：${errText(err)}`)
  }
}

// ---------- 添加 / 编辑对话框（共用：路径输入 + 即时校验） ----------

const dialog = reactive({
  visible: false,
  mode: 'add' as 'add' | 'edit',
  editingId: '',
  homePath: '',
  name: '',
  settingsPath: '',
  localRepoPath: '',
  validating: false,
  validation: null as MavenValidation | null
})

const VALIDATE_DEBOUNCE_MS = 400
let validateTimer: ReturnType<typeof setTimeout> | null = null

function openAdd(): void {
  dialog.mode = 'add'
  dialog.editingId = ''
  dialog.homePath = ''
  dialog.name = ''
  dialog.settingsPath = ''
  dialog.localRepoPath = ''
  dialog.validation = null
  dialog.visible = true
}

function openEdit(maven: Maven): void {
  dialog.mode = 'edit'
  dialog.editingId = maven.id
  dialog.homePath = maven.homePath
  dialog.name = maven.name
  dialog.settingsPath = maven.settingsPath ?? ''
  dialog.localRepoPath = maven.localRepoPath ?? ''
  dialog.validation = null
  dialog.visible = true
}

// 路径变化 → 防抖即时校验（maven:validate 不入库，纯反馈；提交时主进程复检兜底）
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
          dialog.validation = await ipc.maven.validate(trimmed)
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

/** 采纳建议：把默认 settings.xml / 其解析出的 localRepository 一键填入输入框 */
function adoptDefaultSettings(): void {
  const p = dialog.validation?.defaultSettingsPath
  if (p) dialog.settingsPath = p
}

function adoptSettingsLocalRepo(): void {
  const p = dialog.validation?.settingsLocalRepo
  if (p) dialog.localRepoPath = p
}

async function submitDialog(): Promise<void> {
  const homePath = dialog.homePath.trim()
  const name = dialog.name.trim()
  const settingsPath = dialog.settingsPath.trim()
  const localRepoPath = dialog.localRepoPath.trim()
  try {
    if (dialog.mode === 'add') {
      await mavensStore.add({
        homePath,
        ...(name.length > 0 ? { name } : {}),
        ...(settingsPath.length > 0 ? { settingsPath } : {}),
        ...(localRepoPath.length > 0 ? { localRepoPath } : {})
      })
      ElMessage.success('Maven 已添加')
    } else {
      await mavensStore.update({
        id: dialog.editingId,
        homePath,
        ...(name.length > 0 ? { name } : {}),
        // 编辑态空串 = 显式清除（null）；所见即所得
        settingsPath: settingsPath.length > 0 ? settingsPath : null,
        localRepoPath: localRepoPath.length > 0 ? localRepoPath : null
      })
      ElMessage.success('Maven 已更新')
    }
    dialog.visible = false
  } catch (err) {
    // VALIDATION_ERROR（路径/settings.xml 校验失败）等在此提示，对话框保持打开供修正
    ElMessage.error(errText(err))
  }
}

// ---------- 删除（被引用时禁用，主进程 CONFLICT 兜底） ----------

async function handleRemove(maven: Maven): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除 Maven「${maven.name}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return // 用户取消
  }
  try {
    await mavensStore.remove(maven.id)
    ElMessage.success(`已删除「${maven.name}」`)
  } catch (err) {
    ElMessage.error(errText(err))
  }
}

// ---------- 文件/目录选择 ----------

async function pickSettings(): Promise<void> {
  try {
    const picked = await ipc.app.pickFile({
      title: '选择 settings.xml',
      filters: [
        { name: 'Maven settings', extensions: ['xml'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (picked) dialog.settingsPath = picked
  } catch (err) {
    ElMessage.error(`文件选择失败：${errText(err)}`)
  }
}

async function pickLocalRepo(): Promise<void> {
  try {
    const picked = await ipc.app.pickFile({ title: '选择本地仓库目录', directory: true })
    if (picked) dialog.localRepoPath = picked
  } catch (err) {
    ElMessage.error(`目录选择失败：${errText(err)}`)
  }
}

// ---------- 生命周期 ----------

onMounted(() => {
  void mavensStore.refresh().catch((err: unknown) => {
    ElMessage.error(`Maven 列表加载失败：${errText(err)}`)
  })
  // 引用计数依赖项目列表；直达本页（未经过项目面板）时补拉一次
  if (!projectsStore.loaded) {
    void projectsStore.refresh().catch(() => {})
  }
})

onBeforeUnmount(() => {
  if (validateTimer) clearTimeout(validateTimer)
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h2>Maven 管理</h2>
      <span class="hint">
        管理 Maven 版本、settings.xml 与本地仓库；项目「构建配置」从这里选择 Maven
      </span>
    </div>

    <div class="toolbar">
      <el-button type="primary" :loading="mavensStore.scanning" @click="handleScan">
        自动探测
      </el-button>
      <el-button :disabled="mavensStore.scanning" @click="openAdd">手动添加</el-button>
    </div>

    <el-table v-if="mavensStore.mavens.length > 0" :data="mavensStore.mavens" size="default">
      <el-table-column prop="name" label="名称" min-width="180" show-overflow-tooltip />
      <el-table-column prop="version" label="版本" width="100" show-overflow-tooltip />
      <el-table-column prop="homePath" label="路径" min-width="260" show-overflow-tooltip />
      <el-table-column label="settings.xml" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.settingsPath">{{ row.settingsPath }}</span>
          <span v-else class="muted">默认</span>
        </template>
      </el-table-column>
      <el-table-column label="本地仓库" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.localRepoPath">{{ row.localRepoPath }}</span>
          <span v-else class="muted">默认（~/.m2）</span>
        </template>
      </el-table-column>
      <el-table-column label="来源" width="84" align="center">
        <template #default="{ row }">
          <el-tag :type="row.source === 'manual' ? 'warning' : 'info'" size="small">
            {{ row.source === 'manual' ? '手动' : '探测' }}
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
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-tooltip
            :disabled="refCountOf(row) === 0"
            content="被项目构建配置引用，不能删除；请先在这些项目中改绑或清除 Maven"
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
    <el-empty
      v-else
      description="暂无 Maven：点击「自动探测」发现 M2_HOME / MAVEN_HOME / PATH 中的 Maven，或「手动添加」指定路径"
    />

    <el-dialog
      v-model="dialog.visible"
      :title="dialog.mode === 'add' ? '手动添加 Maven' : '编辑 Maven'"
      width="620px"
    >
      <el-form label-width="110px">
        <el-form-item label="Maven 路径" required>
          <el-input
            v-model="dialog.homePath"
            placeholder="如 D:\apache-maven-3.9.9（目录须含 bin\mvn.cmd）"
            clearable
          />
        </el-form-item>
        <el-form-item label="校验结果">
          <span v-if="dialog.validating" class="muted">正在校验…</span>
          <el-alert v-else-if="dialog.validation?.ok" type="success" :closable="false">
            <template #title>
              校验通过：{{ dialog.validation.maven?.name ?? '' }}
              <el-button
                v-if="dialog.validation.defaultSettingsPath"
                link
                type="primary"
                size="small"
                class="inline-link"
                @click="adoptDefaultSettings"
              >
                采纳默认 settings.xml
              </el-button>
            </template>
            <div v-if="dialog.validation.settingsLocalRepo" class="alert-line">
              settings.xml 本地仓库：<code>{{ dialog.validation.settingsLocalRepo }}</code>
              <el-button link type="primary" size="small" class="inline-link" @click="adoptSettingsLocalRepo">
                采纳为仓库路径
              </el-button>
            </div>
            <div v-else class="alert-line muted">默认 settings.xml 未声明 localRepository（将使用 ~/.m2/repository）</div>
          </el-alert>
          <el-alert
            v-else-if="dialog.validation"
            type="error"
            :closable="false"
            :title="dialog.validation.error ?? '校验失败'"
          />
          <span v-else class="muted">输入路径后自动校验</span>
        </el-form-item>
        <el-form-item label="显示名称">
          <el-input v-model="dialog.name" :placeholder="dialog.validation?.maven?.name ?? '留空使用自动派生名称'" />
        </el-form-item>
        <el-form-item label="settings.xml">
          <div class="row-with-browse">
            <el-input
              v-model="dialog.settingsPath"
              :placeholder="dialog.validation?.defaultSettingsPath ?? '可选：自定义 settings.xml（缺省用 Maven 自身解析规则）'"
              clearable
            />
            <el-button @click="pickSettings">浏览…</el-button>
          </div>
        </el-form-item>
        <el-form-item label="本地仓库">
          <div class="row-with-browse">
            <el-input
              v-model="dialog.localRepoPath"
              :placeholder="dialog.validation?.settingsLocalRepo ?? '可选：显式指定本地仓库路径（缺省从 settings.xml 解析）'"
              clearable
            />
            <el-button @click="pickLocalRepo">浏览…</el-button>
          </div>
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
.row-with-browse {
  display: flex;
  gap: 8px;
  width: 100%;
}
.inline-link {
  margin-left: 8px;
  vertical-align: baseline;
}
.alert-line {
  font-size: 12px;
  word-break: break-all;
}
</style>
