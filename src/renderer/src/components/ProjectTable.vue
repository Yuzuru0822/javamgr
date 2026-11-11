<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ProjectWithRuntime } from '@shared/types'
import type { ProjectSortKey, ProjectSortOrder } from '@renderer/utils/project-sort'
import { uptimeMsOf } from '@renderer/utils/project-sort'
import { formatDuration, statusLabels } from '@renderer/utils/format'
import StatusLight from '@renderer/components/StatusLight.vue'

/**
 * 项目列表视图（v0.6.0）：分页表格，与卡片视图同构——
 * 排序/分页由父组件（DashboardView）持有并注入已排序分页后的行；
 * 操作与多选事件签名和 ProjectCard 完全一致（select: [id, checked]），
 * 两个视图共享同一 selectedIds 集合，切换视图勾选不丢。
 * 表头排序（sortable="custom"）上抛 sort-change，与工具栏排序控件同步同一状态。
 */
const props = defineProps<{
  /** 当前页行（父组件已完成排序 + 分页切片） */
  projects: ProjectWithRuntime[]
  /** JDK 名映射（id → 展示名） */
  jdkNames: Map<string, string>
  /** 视图层秒级 tick（运行时间派生用） */
  now: number
  /** 多选批量操作：已勾选的项目 id 集合（父组件持有） */
  selectedIds: Set<string>
  /** 当前排序状态（驱动表头箭头显示；default = 无排序） */
  sortKey: ProjectSortKey
  sortOrder: ProjectSortOrder
}>()

const emit = defineEmits<{
  start: [id: string]
  stop: [id: string]
  restart: [id: string]
  logs: [project: ProjectWithRuntime]
  edit: [project: ProjectWithRuntime]
  remove: [project: ProjectWithRuntime]
  select: [id: string, checked: boolean]
  /** 表头排序点击（el-table sort-change 原样透传；order=null 表示取消排序） */
  sortChange: [prop: string, order: 'ascending' | 'descending' | null]
}>()

const tableRef = ref<{ sort: (prop: string, order: 'ascending' | 'descending' | null) => void }>()

const isRunningLike = (status: ProjectWithRuntime['status']): boolean =>
  status === 'RUNNING' || status === 'STARTING'

const uptimeText = (project: ProjectWithRuntime): string | undefined => {
  const ms = uptimeMsOf(project, props.now)
  return ms === undefined ? undefined : formatDuration(ms)
}

const jdkNameOf = (project: ProjectWithRuntime): string =>
  props.jdkNames.get(project.jdkId) ?? '（JDK 缺失）'

// 工具栏排序控件改动时同步表头箭头（table.sort 为程序调用不 emit；prop 传任一
// 排序列 + null 即清除排序指示——EP 按列名查不到时静默忽略，故 default 用 'name'）
watch(
  [() => props.sortKey, () => props.sortOrder],
  ([key, order]) => {
    if (key === 'default') tableRef.value?.sort('name', null)
    else tableRef.value?.sort(key, order === 'desc' ? 'descending' : 'ascending')
  },
  { flush: 'post' }
)

const defaultSort = computed(() => ({
  prop: props.sortKey === 'default' ? '' : props.sortKey,
  order: (props.sortKey === 'default' ? null : props.sortOrder === 'desc' ? 'descending' : 'ascending') as
    | 'ascending'
    | 'descending'
    | null
}))
/** el-table sort-change 原样透传（模板内联箭头带 TS 标注 vue-tsc 解析不了，收进 script） */
function onSortChange(ctx: { prop: string; order: 'ascending' | 'descending' | null }): void {
  emit('sortChange', ctx.prop, ctx.order)
}

/** 勾选列 change 转发（el-checkbox model-value 为 boolean | string | number 联合类型） */
function onCheck(id: string, value: boolean | string | number): void {
  emit('select', id, value === true)
}

/** 状态列中文文案（slot row 为 any，收进 script 走类型化索引） */
function statusText(status: ProjectWithRuntime['status']): string {
  return statusLabels[status]
}
</script>

<template>
  <el-table
    ref="tableRef"
    :data="projects"
    row-key="id"
    size="small"
    :default-sort="defaultSort"
    @sort-change="onSortChange"
  >
    <el-table-column width="42" align="center">
      <template #default="{ row }">
        <el-checkbox
          :model-value="selectedIds.has(row.id)"
          :aria-label="`选择项目 ${row.name}`"
          @update:model-value="(v: boolean | string | number) => onCheck(row.id, v)"
        />
      </template>
    </el-table-column>

    <el-table-column prop="status" label="状态" width="110" sortable="custom" align="center">
      <template #default="{ row }">
        <span class="status-cell">
          <StatusLight :status="row.status" :note="row.note" />
          {{ statusText(row.status) }}
        </span>
      </template>
    </el-table-column>

    <el-table-column prop="name" label="名称" min-width="170" sortable="custom">
      <template #default="{ row }">
        <span class="name-cell" :title="row.jarPath">{{ row.name }}</span>
      </template>
    </el-table-column>

    <el-table-column label="JDK" min-width="130" show-overflow-tooltip>
      <template #default="{ row }">{{ jdkNameOf(row) }}</template>
    </el-table-column>

    <el-table-column prop="pid" label="PID" width="90" sortable="custom" align="right">
      <template #default="{ row }">
        <span class="num">{{ row.pid ?? '-' }}</span>
      </template>
    </el-table-column>

    <el-table-column prop="uptime" label="运行时间" width="130" sortable="custom" align="right">
      <template #default="{ row }">
        <span v-if="uptimeText(row)" class="num">{{ uptimeText(row) }}</span>
        <el-tag v-else-if="row.status === 'STARTING'" size="small" type="warning">等待中</el-tag>
        <span v-else class="num">-</span>
      </template>
    </el-table-column>

    <el-table-column label="备注" min-width="150">
      <template #default="{ row }">
        <span v-if="row.status === 'ABNORMAL_EXIT'" class="exit-cell">
          异常退出<template v-if="row.exitCode !== undefined">（退出码 {{ row.exitCode }}）</template>
        </span>
        <span v-else-if="row.note" class="note-cell" :title="row.note">{{ row.note }}</span>
        <span v-else class="note-cell">-</span>
      </template>
    </el-table-column>

    <el-table-column label="操作" width="270" fixed="right" align="center">
      <template #default="{ row }">
        <el-button
          v-if="!isRunningLike(row.status)"
          type="success"
          size="small"
          link
          @click="emit('start', row.id)"
        >
          启动
        </el-button>
        <el-button v-else type="danger" size="small" link @click="emit('stop', row.id)">
          停止
        </el-button>
        <el-button :disabled="!isRunningLike(row.status)" size="small" link @click="emit('restart', row.id)">
          重启
        </el-button>
        <el-button size="small" link @click="emit('logs', row)">日志</el-button>
        <el-button link type="primary" size="small" @click="emit('edit', row)">编辑</el-button>
        <el-button link type="danger" size="small" @click="emit('remove', row)">删除</el-button>
      </template>
    </el-table-column>
  </el-table>
</template>

<style scoped>
.status-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.name-cell {
  font-weight: 600;
  cursor: default;
}
.num {
  font-variant-numeric: tabular-nums;
}
.exit-cell {
  color: var(--el-color-danger);
  font-size: 12px;
  font-weight: 600;
}
.note-cell {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
