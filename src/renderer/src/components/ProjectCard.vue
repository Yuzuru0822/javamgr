<script setup lang="ts">
import { computed } from 'vue'
import type { ProjectWithRuntime, RunStatus } from '@shared/types'
import StatusLight from '@renderer/components/StatusLight.vue'

/**
 * 项目卡片（计划 §2.4 / §3 S3.6）：红绿灯 + 名称 + JDK/PID/uptime + 启停按钮。
 * 操作事件上抛 DashboardView 统一处理（含确认框与消息提示）；
 * "查看日志"打开 LogViewer 抽屉（S4：实时滚动/暂停/过滤/上下文检索）；
 * 多选复选框（2026-11-10）：勾选状态由父组件持有（selectedIds Set），上抛 select。
 */
const props = defineProps<{
  project: ProjectWithRuntime
  jdkName: string
  /** 视图层秒级 tick（RUNNING uptime 派生用，避免每卡片自起定时器） */
  now: number
  /** 多选批量操作：本卡片是否已勾选 */
  selected: boolean
}>()

const emit = defineEmits<{
  start: [id: string]
  stop: [id: string]
  restart: [id: string]
  logs: [project: ProjectWithRuntime]
  edit: [project: ProjectWithRuntime]
  remove: [project: ProjectWithRuntime]
  /** 多选勾选/取消（父组件持有 selectedIds 集合） */
  select: [id: string, checked: boolean]
}>()

const isRunningLike = computed(() => isRunningStatus(props.project.status))

function isRunningStatus(status: RunStatus): boolean {
  return status === 'RUNNING' || status === 'STARTING'
}

const uptimeText = computed(() => {
  const p = props.project
  if (p.status !== 'RUNNING' || p.startTime === undefined) return undefined
  return formatDuration(props.now - p.startTime)
})

/** 天/时/分/秒 人性化时长 */
function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  if (m > 0) return `${m}分${sec}秒`
  return `${sec}秒`
}
</script>

<template>
  <el-card class="project-card" shadow="hover" :class="{ abnormal: project.status === 'ABNORMAL_EXIT' }">
    <div class="head">
      <el-checkbox
        :model-value="selected"
        :aria-label="`选择项目 ${project.name}`"
        @update:model-value="(v: boolean) => emit('select', project.id, v === true)"
      />
      <StatusLight :status="project.status" :note="project.note" />
      <span class="name" :title="project.name">{{ project.name }}</span>
    </div>

    <div class="meta">
      <div class="line" :title="project.jarPath">Jar：{{ project.jarPath }}</div>
      <div class="line">JDK：{{ jdkName }}</div>
      <div class="line tags">
        <el-tag v-if="project.pid !== undefined" size="small" type="info">PID {{ project.pid }}</el-tag>
        <el-tag v-if="uptimeText" size="small" type="success">已运行 {{ uptimeText }}</el-tag>
        <el-tag v-if="project.status === 'STARTING'" size="small" type="warning">等待首条输出/存活兜底</el-tag>
      </div>
      <div v-if="project.status === 'ABNORMAL_EXIT'" class="exit-line">
        异常退出<template v-if="project.exitCode !== undefined">（退出码 {{ project.exitCode }}）</template>
      </div>
      <div v-if="project.note" class="note-line" :title="project.note">{{ project.note }}</div>
    </div>

    <div class="actions">
      <el-button
        v-if="!isRunningLike"
        type="success"
        size="small"
        @click="emit('start', project.id)"
      >
        启动
      </el-button>
      <el-button v-else type="danger" size="small" plain @click="emit('stop', project.id)">
        停止
      </el-button>
      <el-button :disabled="!isRunningLike" size="small" @click="emit('restart', project.id)">
        重启
      </el-button>
      <el-button size="small" @click="emit('logs', project)">查看日志</el-button>
      <span class="spacer" />
      <el-button link type="primary" size="small" @click="emit('edit', project)">编辑</el-button>
      <el-button link type="danger" size="small" @click="emit('remove', project)">删除</el-button>
    </div>
  </el-card>
</template>

<style scoped>
.project-card {
  min-width: 0;
}
.project-card.abnormal {
  border-color: var(--el-color-danger-light-5);
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.name {
  font-weight: 600;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  margin-bottom: 12px;
}
.line {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 4px;
}
.tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  white-space: normal;
}
.exit-line {
  color: var(--el-color-danger);
  font-size: 13px;
  font-weight: 600;
  margin-top: 4px;
}
.note-line {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin-top: 2px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.spacer {
  flex: 1;
}
</style>
