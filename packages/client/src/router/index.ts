import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('@/components/layout/MainLayout.vue'),
    children: [
      { path: '', name: 'Chat', component: () => import('@/views/ChatView.vue'), meta: { title: 'nav.chat' } },
      { path: 'history', name: 'History', component: () => import('@/views/HistoryView.vue'), meta: { title: 'nav.history' } },
      { path: 'search', name: 'Search', component: () => import('@/views/SearchView.vue'), meta: { title: 'nav.search' } },
      { path: 'tasks', name: 'Tasks', component: () => import('@/views/TasksView.vue'), meta: { title: 'nav.tasks' } },
      { path: 'automations', name: 'Automations', component: () => import('@/views/AutomationsView.vue'), meta: { title: 'nav.automations' } },
      { path: 'channel', name: 'Channel', component: () => import('@/views/ChannelView.vue'), meta: { title: 'nav.channel' } },
      { path: 'workspace', name: 'Workspace', component: () => import('@/views/WorkspaceView.vue'), meta: { title: 'nav.workspace' } },
      { path: 'skills', name: 'Skills', component: () => import('@/views/SkillsView.vue'), meta: { title: 'nav.skills' } },
      { path: 'memory', name: 'Memory', component: () => import('@/views/MemoryView.vue'), meta: { title: 'nav.memory' } },
      { path: 'models', name: 'Models', component: () => import('@/views/ModelsView.vue'), meta: { title: 'nav.models' } },
      { path: 'logs', name: 'Logs', component: () => import('@/views/LogsView.vue'), meta: { title: 'nav.logs' } },
      { path: 'usage', name: 'Usage', component: () => import('@/views/UsageView.vue'), meta: { title: 'nav.usage' } },
      { path: 'gateway', name: 'Gateway', component: () => import('@/views/GatewayView.vue'), meta: { title: 'nav.gateway' } },
      { path: 'users', name: 'Users', component: () => import('@/views/UsersView.vue'), meta: { title: 'nav.users' } },
      { path: 'settings', name: 'Settings', component: () => import('@/views/SettingsView.vue'), meta: { title: 'nav.settings' } },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  const title = to.meta.title as string
  if (title) document.title = `${title} - SUPERCRZY BOT`
})

export { routes }
export default () => router
