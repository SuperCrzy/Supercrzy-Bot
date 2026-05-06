import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('@/components/layout/MainLayout.vue'),
    children: [
      { path: '', name: 'Chat', component: () => import('@/views/ChatView.vue'), meta: { title: '对话' } },
      { path: 'history', name: 'History', component: () => import('@/views/HistoryView.vue'), meta: { title: '历史' } },
      { path: 'search', name: 'Search', component: () => import('@/views/SearchView.vue'), meta: { title: '搜索' } },
      { path: 'tasks', name: 'Tasks', component: () => import('@/views/TasksView.vue'), meta: { title: '任务' } },
      { path: 'channel', name: 'Channel', component: () => import('@/views/ChannelView.vue'), meta: { title: '频道' } },
      { path: 'workspace', name: 'Workspace', component: () => import('@/views/WorkspaceView.vue'), meta: { title: '工作台' } },
      { path: 'skills', name: 'Skills', component: () => import('@/views/SkillsView.vue'), meta: { title: '技能' } },
      { path: 'memory', name: 'Memory', component: () => import('@/views/MemoryView.vue'), meta: { title: '记忆' } },
      { path: 'models', name: 'Models', component: () => import('@/views/ModelsView.vue'), meta: { title: '模型' } },
      { path: 'logs', name: 'Logs', component: () => import('@/views/LogsView.vue'), meta: { title: '日志' } },
      { path: 'usage', name: 'Usage', component: () => import('@/views/UsageView.vue'), meta: { title: '用量' } },
      { path: 'gateway', name: 'Gateway', component: () => import('@/views/GatewayView.vue'), meta: { title: '网关' } },
      { path: 'users', name: 'Users', component: () => import('@/views/UsersView.vue'), meta: { title: '用户' } },
      { path: 'settings', name: 'Settings', component: () => import('@/views/SettingsView.vue'), meta: { title: '设置' } },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  const title = to.meta.title as string
  if (title) document.title = `${title} - DeepSeek Agent`
})

export { routes }
export default () => router
