import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import i18n from '@/i18n'
import { useAccountStore } from '@/stores/account'

const routes: RouteRecordRaw[] = [
  // Sign-in lives outside MainLayout: there is no navigation to offer until the
  // account exists, and the layout would otherwise mount the whole app behind
  // the login screen.
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/LoginView.vue'),
    meta: { title: 'nav.login', public: true },
  },
  {
    path: '/',
    component: () => import('@/components/layout/MainLayout.vue'),
    children: [
      { path: '', name: 'Chat', component: () => import('@/views/ChatView.vue'), meta: { title: 'nav.chat' } },
      { path: 'collab', name: 'Collab', component: () => import('@/views/CollabWorkbenchView.vue'), meta: { title: 'nav.collab' } },
      { path: 'search', name: 'Search', component: () => import('@/views/SearchView.vue'), meta: { title: 'nav.search' } },
      { path: 'automations', name: 'Automations', component: () => import('@/views/AutomationHubView.vue'), meta: { title: 'nav.automations' } },
      { path: 'routines', name: 'Routines', component: () => import('@/views/RoutinesView.vue'), meta: { title: 'nav.routines' } },
      { path: 'skills', name: 'Skills', component: () => import('@/views/SkillsView.vue'), meta: { title: 'nav.skills' } },
      { path: 'news', name: 'News', component: () => import('@/views/NewsView.vue'), meta: { title: 'nav.news' } },
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

router.beforeEach(async (to) => {
  // The app requires an account, so resolve who is signed in before the first
  // route renders. ensureReady() is memoised — this costs one request per boot.
  const account = useAccountStore()
  await account.ensureReady()

  if (!account.signedIn && !to.meta.public) return { name: 'Login' }
  if (account.signedIn && to.name === 'Login') return { name: 'Chat' }

  const title = to.meta.title as string
  if (title) document.title = `${i18n().global.t(title)} - SUPERCRZY BOT`
})

export { routes }
export default () => router
