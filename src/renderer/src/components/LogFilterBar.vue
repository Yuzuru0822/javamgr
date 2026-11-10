<script setup lang="ts">
import type { FilterableLevel } from '@renderer/stores/logs'

/**
 * 日志过滤条（计划 §2.4 LogFilterBar / §3 S4.7）：
 * 关键字输入（不区分大小写）+ 级别下拉（TRACE~FATAL）+ 跳转匹配（上/下一个）+
 * 查看命中上下文（±contextLines，调 logs:search——由父组件 LogViewer 执行）。
 * 本组件纯受控（v-model 双字段 + 事件上抛）。
 */
const keyword = defineModel<string>('keyword', { required: true })
const level = defineModel<FilterableLevel | ''>('level', { required: true })

defineProps<{
  /** 当前过滤条件下可跳转的匹配数 */
  matchCount: number
  /** 当前跳转索引（1 基，展示用） */
  matchIndex: number
}>()

const emit = defineEmits<{
  prev: []
  next: []
  /** 点击查看当前命中的 ±contextLines 上下文（logs:search） */
  context: []
  clear: []
}>()

const LEVELS: Array<{ value: FilterableLevel | ''; label: string }> = [
  { value: '', label: '全部级别' },
  { value: 'TRACE', label: 'TRACE' },
  { value: 'DEBUG', label: 'DEBUG' },
  { value: 'INFO', label: 'INFO' },
  { value: 'WARN', label: 'WARN' },
  { value: 'ERROR', label: 'ERROR' },
  { value: 'FATAL', label: 'FATAL' }
]
</script>

<template>
  <div class="filter-bar">
    <el-input
      :model-value="keyword"
      clearable
      placeholder="关键字（不区分大小写）"
      class="keyword"
      @update:model-value="(v: string) => (keyword = v ?? '')"
      @keyup.enter="emit('next')"
    />
    <el-select :model-value="level" class="level" @update:model-value="(v: FilterableLevel | '') => (level = v)">
      <el-option v-for="opt in LEVELS" :key="opt.value" :value="opt.value" :label="opt.label" />
    </el-select>
    <el-button :disabled="matchCount === 0" @click="emit('prev')">上一个</el-button>
    <el-button :disabled="matchCount === 0" @click="emit('next')">下一个</el-button>
    <span class="match-info">
      {{ matchCount === 0 ? '无匹配' : `${matchIndex}/${matchCount}` }}
    </span>
    <el-button type="primary" plain :disabled="matchCount === 0" @click="emit('context')">
      上下文
    </el-button>
    <el-button link @click="emit('clear')">重置</el-button>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.keyword {
  width: 240px;
}
.level {
  width: 120px;
}
.match-info {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  min-width: 48px;
  text-align: center;
}
</style>
