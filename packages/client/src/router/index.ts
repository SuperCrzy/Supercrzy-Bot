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
      // ---- Media space (2026-11-13): Home / News / Lab / Rank ----
      // The space split only exists on mobile (SpaceDock); on desktop these four pages sit
      // beside the BOT pages with no gating.
      { path: 'home', name: 'Home', component: () => import('@/views/HomeView.vue'), meta: { title: 'nav.home' } },
      { path: 'lab', name: 'Lab', component: () => import('@/views/LabView.vue'), meta: { title: 'nav.lab' } },
      { path: 'rank', name: 'Rank', component: () => import('@/views/RankView.vue'), meta: { title: 'nav.rank' } },
      // Content search (articles / lab / rankings) — the site's own /search page, embedded.
      // The app's /search is chat-history search; both exist and must not be conflated.
      { path: 'explore', name: 'Explore', component: () => import('@/views/ExploreView.vue'), meta: { title: 'nav.explore' } },
      // Site account (subscription / history) — same auth system as the app, different job
      // than the BOT space's Settings page. This is the page the top-bar user icon opens.
      { path: 'account', name: 'Account', component: () => import('@/views/AccountView.vue'), meta: { title: 'nav.account' } },
      // Native "About" second-level page: legal links, version row with release-channel check.
      { path: 'about', name: 'AppAbout', component: () => import('@/views/AboutView.vue'), meta: { title: 'about.title' } },
      { path: 'collab', name: 'Collab', component: () => import('@/views/CollabWorkbenchView.vue'), meta: { title: 'nav.collab' } },
      { path: 'search', name: 'Search', component: () => import('@/views/SearchView.vue'), meta: { title: 'nav.search' } },
      { path: 'automations', name: 'Automations', component: () => import('@/views/AutomationHubView.vue'), meta: { title: 'nav.automations' } },
      { path: 'routines', name: 'Routines', component: () => import('@/views/RoutinesView.vue'), meta: { title: 'nav.routines' } },
      { path: 'skills', name: 'Skills', component: () => import('@/views/SkillsView.vue'), meta: { title: 'nav.skills' } },
      { path: 'news', name: 'News', component: () => import('@/views/NewsView.vue'), meta: { title: 'nav.news' } },
      { path: 'memory', name: 'Memory', component: () => import('@/views/MemoryView.vue'), meta: { title: 'nav.memory' } },
      { path: 'models', name: 'Models', component: () => import('@/views/ModelsView.vue'), meta: { title: 'nav.models' } },
      { path: 'artifacts', name: 'Artifacts', component: () => import('@/views/ArtifactsView.vue'), meta: { title: 'nav.artifacts' } },
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
  // Set the title first: every early return below (preview bypass, redirect) would otherwise
  // skip it, and the window would keep the static <title> from index.html.
  const title = to.meta.title as string
  // Brand is SUPERCRZY; "BOT" is the product line inside it, not the suffix of every page title.
  if (title) document.title = `${i18n().global.t(title)} - SUPERCRZY`

  // Dev-only preview bypass. The auth service (auth.supercrzy.com) is unreachable from
  // mainland China, so layout work cannot otherwise be looked at locally. Visit any route
  // with ?preview=1 once; the rest of the session stays unlocked. Never active in a build.
  if (import.meta.env.DEV) {
    if (to.query.preview === '1') sessionStorage.setItem('dev-preview', '1')
    if (sessionStorage.getItem('dev-preview') === '1') return
  }

  // The app requires an account, so resolve who is signed in before the first
  // route renders. ensureReady() is memoised — this costs one request per boot.
  const account = useAccountStore()
  await account.ensureReady()

  if (!account.signedIn && !to.meta.public) return { name: 'Login' }
  if (account.signedIn && to.name === 'Login') return { name: 'Chat' }
})

export { routes }
export default () => router
