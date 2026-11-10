<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useSettingsStore } from '@renderer/stores/settings'
import { useProjectsStore } from '@renderer/stores/projects'

const route = useRoute()
const activeMenu = computed(() => route.path)

// App 启动即拉取设置（S1）：默认值来自主进程 config-store（settings.json 单一权威）
const settingsStore = useSettingsStore()
// S3：全局订阅 proc:statusChanged（无论当前页面，状态镜像保持最新；视图按需 tick uptime）
const projectsStore = useProjectsStore()
onMounted(() => {
  settingsStore.load().catch((err: unknown) => console.error('读取设置失败：', err))
  projectsStore.bindStatusEvents()
})
</script>

<template>
  <el-container class="shell">
    <el-aside width="200px" class="side">
      <div class="brand">Java 进程管理器</div>
      <el-menu :default-active="activeMenu" router>
        <el-menu-item index="/projects">项目面板</el-menu-item>
        <el-menu-item index="/jdk">JDK 管理</el-menu-item>
        <el-menu-item index="/settings">设置</el-menu-item>
      </el-menu>
    </el-aside>
    <el-main class="main">
      <router-view />
    </el-main>
  </el-container>
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
}
</style>

<style scoped>
.shell {
  height: 100%;
}
.side {
  border-right: 1px solid var(--el-border-color-light);
}
.brand {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
}
.main {
  background: var(--el-fill-color-lighter);
}
</style>
