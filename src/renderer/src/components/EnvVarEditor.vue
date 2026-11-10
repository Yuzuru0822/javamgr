<script setup lang="ts">
import { computed } from 'vue'

/**
 * 环境变量键值编辑器（计划 §2.4 ProjectForm 子组件）。
 * v-model 绑定 Record<string, string>；空键行不生效；重复键后行覆盖前行（保存前过滤）。
 */
const model = defineModel<Record<string, string>>({ required: true })

interface Row {
  key: string
  value: string
}

const rows = computed<Row[]>({
  get: () => Object.entries(model.value).map(([key, value]) => ({ key, value })),
  set: (next) => {
    const merged: Record<string, string> = {}
    for (const row of next) {
      const key = row.key.trim()
      if (key) merged[key] = row.value
    }
    model.value = merged
  }
})

function updateRow(index: number, patch: Partial<Row>): void {
  rows.value = rows.value.map((row, i) => (i === index ? { ...row, ...patch } : row))
}

function addRow(): void {
  rows.value = [...rows.value, { key: '', value: '' }]
}

function removeRow(index: number): void {
  rows.value = rows.value.filter((_, i) => i !== index)
}
</script>

<template>
  <div class="env-editor">
    <div v-if="rows.length === 0" class="empty">
      暂无环境变量（JAVA_HOME 由绑定的 JDK 自动注入，无需手填）
      <el-button link type="primary" @click="addRow">添加变量</el-button>
    </div>
    <div v-for="(row, index) in rows" :key="index" class="row">
      <el-input
        :model-value="row.key"
        placeholder="变量名，如 APP_ENV"
        class="key"
        @update:model-value="(v: string) => updateRow(index, { key: v })"
      />
      <el-input
        :model-value="row.value"
        placeholder="值"
        class="value"
        @update:model-value="(v: string) => updateRow(index, { value: v })"
      />
      <el-button link type="danger" @click="removeRow(index)">删除</el-button>
    </div>
    <el-button v-if="rows.length > 0" link type="primary" class="add" @click="addRow">
      + 添加变量
    </el-button>
  </div>
</template>

<style scoped>
.env-editor {
  width: 100%;
}
.empty {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.key {
  flex: 2;
}
.value {
  flex: 3;
}
.add {
  margin-top: 2px;
}
</style>
