import { createRouter, createWebHashHistory } from 'vue-router'

/** hash 路由：打包后 file:// 加载无需服务端重写 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/projects' },
    {
      path: '/projects',
      name: 'projects',
      component: () => import('@renderer/views/DashboardView.vue')
    },
    {
      path: '/jdk',
      name: 'jdk',
      component: () => import('@renderer/views/JdkView.vue')
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@renderer/views/SettingsView.vue')
    }
  ]
})

export default router
