<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { ProjectInput, ProjectWithRuntime } from '@shared/types'
import { ipc } from '@renderer/api/ipc'
import { useJdksStore } from '@renderer/stores/jdks'
import { useProjectsStore } from '@renderer/stores/projects'
import EnvVarEditor from '@renderer/components/EnvVarEditor.vue'

/**
 * 项目新建/编辑表单（计划 §2.4 / §3 S3.6，el-dialog）：
 * 名称 / jar 路径(文件选择) / JDK 下拉(空时提示去 JDK 页) / JVM 参数 / 程序参数 /
 * 环境变量(EnvVarEditor) / 日志文件路径(可选) / 编码覆盖(auto|utf8|gbk)。
 *
 * 编辑运行中项目：允许保存但提示"重启后生效"（jarPath/JVM 参数等不热替换）；
 * logFilePath 变更为例外——S4 将在此处调用即时切换钩子（log-manager 重路由+重置游标）。
 */
const props = defineProps<{
  visible: boolean
  /** 编辑目标（null = 新建） */
  project: ProjectWithRuntime | null
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  saved: []
}>()

const jdksStore = useJdksStore()
const projectsStore = useProjectsStore()
const router = useRouter()

const form = reactive({
  name: '',
  jarPath: '',
  jdkId: '',
  jvmArgsText: '',
  programArgsText: '',
  envVars: {} as Record<string, string>,
  logFilePath: '',
  encodingOverride: 'auto' as 'auto' | 'utf8' | 'gbk'
})

const isEdit = computed(() => props.project !== null)
const editingRunning = computed(
  () => props.project !== null && (props.project.status === 'RUNNING' || props.project.status === 'STARTING')
)

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    const p = props.project
    if (p) {
      form.name = p.name
      form.jarPath = p.jarPath
      form.jdkId = p.jdkId
      form.jvmArgsText = p.jvmArgs.join('\n')
      form.programArgsText = p.programArgs.join('\n')
      form.envVars = { ...p.envVars }
      form.logFilePath = p.logFilePath ?? ''
      form.encodingOverride = p.encodingOverride ?? 'auto'
    } else {
      form.name = ''
      form.jarPath = ''
      form.jdkId = jdksStore.jdks[0]?.id ?? ''
      form.jvmArgsText = ''
      form.programArgsText = ''
      form.envVars = {}
      form.logFilePath = ''
      form.encodingOverride = 'auto'
    }
  }
)

/** 多行文本 → string[]（去空行去首尾空白） */
function toArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

const canSubmit = computed(
  () => form.name.trim().length > 0 && form.jarPath.trim().length > 0 && form.jdkId.length > 0
)

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function pickJar(): Promise<void> {
  try {
    const picked = await ipc.app.pickFile({
      title: '选择 jar 文件',
      filters: [{ name: 'JAR 文件', extensions: ['jar'] }]
    })
    if (picked) form.jarPath = picked
  } catch (err) {
    ElMessage.error(`文件选择失败：${errText(err)}`)
  }
}

function close(): void {
  emit('update:visible', false)
}

async function submit(): Promise<void> {
  const input: ProjectInput = {
    name: form.name.trim(),
    jarPath: form.jarPath.trim(),
    jdkId: form.jdkId,
    jvmArgs: toArgs(form.jvmArgsText),
    programArgs: toArgs(form.programArgsText),
    envVars: { ...form.envVars },
    ...(form.logFilePath.trim().length > 0 ? { logFilePath: form.logFilePath.trim() } : {}),
    ...(form.encodingOverride !== 'auto' ? { encodingOverride: form.encodingOverride } : {})
  }
  try {
    const wasRunning = editingRunning.value
    const logPathChanged =
      props.project !== null && (props.project.logFilePath ?? '') !== (input.logFilePath ?? '')
    if (props.project) {
      await projectsStore.update({ ...input, id: props.project.id })
      // logFilePath 变更例外（S4 已接通）：主进程 projects:update diff 后即时调用
      // log-manager.switchRoute（重路由 + 重置游标），本 run 内生效
      if (wasRunning) {
        ElMessage.warning(
          logPathChanged ? '已保存：日志路由已即时切换（其余配置重启后生效）' : '已保存：项目正在运行，配置将在重启后生效'
        )
      } else {
        ElMessage.success('项目已保存')
      }
    } else {
      await projectsStore.create(input)
      ElMessage.success('项目已创建')
    }
    close()
    emit('saved')
  } catch (err) {
    ElMessage.error(errText(err)) // VALIDATION_ERROR 等，对话框保持打开供修正
  }
}

function goJdkPage(): void {
  close()
  void router.push('/jdk')
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="isEdit ? '编辑项目' : '新建项目'"
    width="640px"
    @update:model-value="(v: boolean) => emit('update:visible', v)"
  >
    <el-alert
      v-if="editingRunning"
      type="warning"
      :closable="false"
      show-icon
      title="项目正在运行：保存的配置重启后生效（日志文件路径变更除外）"
      class="run-hint"
    />
    <el-form label-width="96px">
      <el-form-item label="名称" required>
        <el-input v-model="form.name" placeholder="如 LoggyDemo" maxlength="64" />
      </el-form-item>
      <el-form-item label="Jar 路径" required>
        <div class="jar-row">
          <el-input v-model="form.jarPath" placeholder="预构建 jar 的绝对路径（不做编译构建）" />
          <el-button @click="pickJar">浏览…</el-button>
        </div>
      </el-form-item>
      <el-form-item label="JDK" required>
        <template v-if="jdksStore.jdks.length > 0">
          <el-select v-model="form.jdkId" placeholder="选择绑定的 JDK" class="jdk-select">
            <el-option
              v-for="jdk in jdksStore.jdks"
              :key="jdk.id"
              :value="jdk.id"
              :label="`${jdk.name}（${jdk.version}）`"
            />
          </el-select>
        </template>
        <template v-else>
          <div class="jdk-empty">
            尚无 JDK：
            <el-button link type="primary" @click="goJdkPage">去 JDK 页扫描/添加</el-button>
          </div>
        </template>
      </el-form-item>
      <el-form-item label="JVM 参数">
        <el-input
          v-model="form.jvmArgsText"
          type="textarea"
          :rows="2"
          placeholder="每行一个，如 -Xmx256m 或 -Dloggy.mode=gbk"
        />
      </el-form-item>
      <el-form-item label="程序参数">
        <el-input
          v-model="form.programArgsText"
          type="textarea"
          :rows="2"
          placeholder="每行一个，跟在 -jar xxx.jar 之后，如 --interval=1000"
        />
      </el-form-item>
      <el-form-item label="环境变量">
        <EnvVarEditor v-model="form.envVars" />
      </el-form-item>
      <el-form-item label="日志文件">
        <el-input v-model="form.logFilePath" placeholder="可选：logback 日志文件路径，配置后 tail 文件而非捕获 stdout" />
      </el-form-item>
      <el-form-item label="编码覆盖">
        <el-select v-model="form.encodingOverride" class="jdk-select">
          <el-option value="auto" label="auto（自动检测 UTF-8/GBK）" />
          <el-option value="utf8" label="utf8" />
          <el-option value="gbk" label="gbk" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" @click="submit">
        {{ isEdit ? '保存' : '创建' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.run-hint {
  margin-bottom: 12px;
}
.jar-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.jdk-select {
  width: 100%;
}
.jdk-empty {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
