<script setup lang="ts">
import { computed } from 'vue'
import type { RunStatus } from '@shared/types'

/**
 * 四态红绿灯（计划 §2.4 / A5）：绿 RUNNING / 灰 STOPPED / 黄 STARTING / 红 ABNORMAL_EXIT。
 * note（"重识别"/"外部退出，退出码未知"等）经 title 悬浮提示。
 */
const props = defineProps<{
  status: RunStatus
  note?: string
}>()

const META: Record<RunStatus, { color: string; label: string }> = {
  RUNNING: { color: 'var(--el-color-success)', label: '运行中' },
  STOPPED: { color: 'var(--el-text-color-disabled)', label: '已停止' },
  STARTING: { color: 'var(--el-color-warning)', label: '启动中' },
  ABNORMAL_EXIT: { color: 'var(--el-color-danger)', label: '异常退出' }
}

const meta = computed(() => META[props.status])
const tooltip = computed(() =>
  props.note ? `${meta.value.label}（${props.note}）` : meta.value.label
)
</script>

<template>
  <span class="status-light" :title="tooltip">
    <span class="dot" :style="{ backgroundColor: meta.color }" />
    <span class="label">{{ meta.label }}</span>
  </span>
</template>

<style scoped>
.status-light {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
}
.label {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
</style>
