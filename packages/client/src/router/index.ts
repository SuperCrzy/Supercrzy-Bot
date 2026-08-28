import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import i18n from '@/i18n'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('@/components/layout/MainLayout.vue'),
    children: [
      { path: '', name: 'Chat', component: () => import('@/views/ChatView.vue'), meta: { title: 'nav.chat' } },
      { path: 'ghost', name: 'Ghost', component: () => import('@/views/GhostWorkbenchView.vue'), meta: { title: 'nav.ghost' } },
      { path: 'search', name: 'Search', component: () => import('@/views/SearchView.vue'), meta: { title: 'nav.search' } },
      { path: 'tasks', name: 'Tasks', component: () => import('@/views/TasksView.vue'), meta: { title: 'nav.tasks' } },
      { path: 'automations', name: 'Automations', component: () => import('@/views/AutomationsView.vue'), meta: { title: 'nav.automations' } },
      { path: 'routines', name: 'Routines', component: () => import('@/views/RoutinesView.vue'), meta: { title: 'nav.routines' } },
      { path: 'workspace', name: 'Workspace', component: () => import('@/views/WorkspaceView.vue'), meta: { title: 'nav.workspace' } },
      { path: 'skills', name: 'Skills', component: () => import('@/views/SkillsView.vue'), meta: { title: 'nav.skills' } },
      { path: 'memory', name: 'Memory', component: () => import('@/views/MemoryView.vue'), meta: { title: 'nav.memory' } },
      { path: 'models', name: 'Models', component: () => import('@/views/ModelsView.vue'), meta: { title: 'nav.models' } },
      { path: 'logs', name: 'Logs', component: () => import('@/views/LogsView.vue'), meta: { title: 'nav.logs' } },
      { path: 'usage', name: 'Usage', component: () => import('@/views/UsageView.vue'), meta: { title: 'nav.usage' } },
      { path: 'images', name: 'ImagesSettings', component: () => import('@/views/ImagesSettingsView.vue'), meta: { title: 'nav.imagesSettings' } },
      { path: 'gateway', name: 'Gateway', component: () => import('@/views/GatewayView.vue'), meta: { title: 'nav.gateway' } },
      { path: 'settings', name: 'Settings', component: () => import('@/views/SettingsView.vue'), meta: { title: 'nav.settings' } },
      // 兜底：未知路径（含已删除的旧路由如 /history）重定向到聊天页，避免白屏
      { path: ':pathMatch(.*)*', redirect: '/' },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  const title = to.meta.title as string
  if (title) document.title = `${i18n().global.t(title)} - SUPERCRZY BOT`
})

export { routes }
export default () => router
