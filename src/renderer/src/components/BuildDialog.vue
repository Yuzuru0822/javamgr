<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { BuildState } from '@shared/types'
import { ipc, ipcEvents } from '@renderer/api/ipc'

/**
 * 构建输出对话框（v0.7.0 构建按钮）：
 * - 打开即 build:getState 拉取最近一次构建快照（输出缓冲 + 终态），进行中的构建持续
 *   订阅 build:output / build:statusChanged 跟随（关对话框再开不丢输出）；
 * - 输出区终端风格（等宽 + 深色），贴底跟随（用户上滚则暂停，回到底部恢复——
 *   与 LogViewer 同款 pinned 语义的简化版）；
 * - running：可取消（杀 mvn 进程树）；终态：可重新构建；错误行（[ERROR]）红色标注。
 */
const props = defineProps<{
  visible: boolean
  projectId: string | null
  projectName: string
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

const state = ref<BuildState | null>(null)
const outputEl = ref<HTMLElement | null>(null)
let pinned = true
let unsubOutput: (() => void) | null = null
let unsubStatus: (() => void) | null = null

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const statusTag = computed<{ text: string; type: 'success' | 'danger' | 'info' | 'warning' } | null>(() => {
  if (!state.value) return null
  switch (state.value.status) {
    case 'running':
      return { text: '构建中', type: 'warning' }
    case 'success':
      return { text: '构建成功', type: 'success' }
    case 'failure':
      return { text: '构建失败', type: 'danger' }
    case 'cancelled':
      return { text: '已取消', type: 'info' }
  }
})

const isRunning = computed(() => state.value?.status === 'running')

const lines = computed(() => state.value?.lines ?? [])

function isErrorLine(text: string): boolean {
  return /\[ERROR\]/.test(text)
}

function stickToBottom(): void {
  const el = outputEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

function onScroll(): void {
  const el = outputEl.value
  if (!el) return
  pinned = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
}

function bindEvents(): void {
  unsubOutput?.()
  unsubStatus?.()
  unsubOutput = ipcEvents.buildOutput((event) => {
    if (event.projectId !== props.projectId || !state.value) return
    state.value.lines.push(...event.lines)
    if (pinned) void nextTick(stickToBottom)
  })
  unsubStatus = ipcEvents.buildStatusChanged((event) => {
    if (event.projectId !== props.projectId || !state.value) return
    state.value.status = event.status
    state.value.durationMs = event.durationMs
    if (event.exitCode !== undefined) state.value.exitCode = event.exitCode
    if (event.status === 'success') {
      ElMessage.success(`「${props.projectName}」构建成功（${((event.durationMs ?? 0) / 1000).toFixed(1)}s）`)
    } else if (event.status === 'failure') {
      ElMessage.error(`「${props.projectName}」构建失败（退出码 ${event.exitCode ?? '-'}）`)
    }
  })
}

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      unsubOutput?.()
      unsubOutput = null
      unsubStatus?.()
      unsubStatus = null
      return
    }
    pinned = true
    state.value = null
    if (!props.projectId) return
    try {
      state.value = await ipc.build.getState(props.projectId)
    } catch (err) {
      ElMessage.error(`读取构建状态失败：${errText(err)}`)
    }
    bindEvents()
    void nextTick(stickToBottom)
  }
)

async function cancel(): Promise<void> {
  if (!props.projectId) return
  try {
    await ipc.build.stop(props.projectId)
  } catch (err) {
    ElMessage.error(`取消失败：${errText(err)}`)
  }
}

async function rerun(): Promise<void> {
  if (!props.projectId) return
  try {
    state.value = await ipc.build.run(props.projectId)
    pinned = true
    void nextTick(stickToBottom)
  } catch (err) {
    ElMessage.error(errText(err))
  }
}

function close(): void {
  emit('update:visible', false)
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="`构建「${projectName}」`"
    width="780px"
    @update:model-value="(v: boolean) => emit('update:visible', v)"
  >
    <div v-if="state" class="meta">
      <el-tag v-if="statusTag" :type="statusTag.type" size="small">{{ statusTag.text }}</el-tag>
      <span class="meta-item" title="实际执行的命令">cmd /c {{ state.commandLine }}</span>
      <span class="meta-item" title="构建工作目录">📁 {{ state.workDir }}</span>
      <span v-if="state.durationMs !== undefined" class="meta-item">
        耗时 {{ (state.durationMs / 1000).toFixed(1) }}s
      </span>
    </div>
    <div ref="outputEl" class="output" @scroll="onScroll">
      <div v-if="lines.length === 0" class="empty">{{ isRunning ? '等待构建输出…' : '暂无输出' }}</div>
      <div
        v-for="(line, i) in lines"
        :key="i"
        class="line"
        :class="{ 'line-error': isErrorLine(line), 'line-info': line.startsWith('[javamgr]') }"
      >{{ line }}</div>
    </div>
    <template #footer>
      <el-button v-if="isRunning" type="danger" plain @click="cancel">取消构建</el-button>
      <el-button v-else type="primary" @click="rerun">重新构建</el-button>
      <el-button @click="close">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.meta-item {
  word-break: break-all;
}
.output {
  background: #1e1e1e;
  color: #d4d4d4;
  border-radius: 4px;
  padding: 8px 10px;
  height: 420px;
  overflow-y: auto;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
}
.empty {
  color: #6a6a6a;
  padding: 8px 2px;
}
.line {
  white-space: pre-wrap;
  word-break: break-all;
}
.line-error {
  color: #f56c6c;
}
.line-info {
  color: #67c23a;
}
</style>
