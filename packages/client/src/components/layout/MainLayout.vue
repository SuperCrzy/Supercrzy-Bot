<template>
  <div class="app-layout" :class="{ dark: appStore.darkMode }">
    <!-- ========== MOBILE TOP BAR ========== -->
    <div class="mobile-topbar">
      <button class="hamburger-btn" @click="mobileMenuOpen = !mobileMenuOpen">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="3" y1="6" x2="21" y2="6" v-if="!mobileMenuOpen"/>
          <line x1="3" y1="12" x2="21" y2="12" v-if="!mobileMenuOpen"/>
          <line x1="3" y1="18" x2="21" y2="18" v-if="!mobileMenuOpen"/>
          <line x1="18" y1="6" x2="6" y2="18" v-if="mobileMenuOpen"/>
          <line x1="6" y1="6" x2="18" y2="18" v-if="mobileMenuOpen"/>
        </svg>
      </button>
      <img src="/logo.png" alt="SUPERCRZY" class="mobile-logo" />
      <span class="mobile-title">{{ currentPageTitle }}</span>
      <button class="mobile-new-chat" @click="handleNewChat">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>

    <!-- Mobile overlay backdrop -->
    <div class="mobile-overlay" v-if="mobileMenuOpen" @click="mobileMenuOpen = false"></div>

    <!-- ========== LEFT SIDEBAR ========== -->
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed, 'mobile-open': mobileMenuOpen }">
      <!-- Logo -->
      <div class="sidebar-header" @click="navigate('Chat')">
        <img src="/logo.png" alt="SUPERCRZY" class="logo-icon" />
        <span class="logo-text" v-show="!sidebarCollapsed">SUPERCRZY BOT</span>
      </div>

      <button class="collapse-btn" @click="toggleSidebar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path v-if="!sidebarCollapsed" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          <path v-else d="M13 5l7 7-7 7M6 5l7 7-7 7" />
        </svg>
      </button>

      <!-- Navigation Groups -->
      <nav class="nav-groups" v-show="!sidebarCollapsed">
        <!-- Chat Group -->
        <div class="nav-group">
          <div class="nav-group-title" @click="toggleGroup('chat')">
            <span>{{ $t('nav.chatGroup') }}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: groups.chat }"><path d="M6 9l6 6 6-6"/></svg>
          </div>
          <div class="nav-items" v-show="groups.chat">
            <router-link to="/" class="nav-item" :class="{ active: route.name === 'Chat' }">
              <SvgIcon name="message" :size="16" />
              <span>{{ $t('nav.chat') }}</span>
            </router-link>
            <router-link to="/history" class="nav-item" :class="{ active: route.name === 'History' }">
              <SvgIcon name="history" :size="16" />
              <span>{{ $t('nav.history') }}</span>
            </router-link>
            <router-link v-if="!isMobile" to="/search" class="nav-item" :class="{ active: route.name === 'Search' }">
              <SvgIcon name="search" :size="16" />
              <span>{{ $t('nav.search') }}</span>
            </router-link>
          </div>
        </div>

        <!-- Agent Group -->
        <div class="nav-group">
          <div class="nav-group-title" @click="toggleGroup('agent')">
            <span>{{ $t('nav.agentGroup') }}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: groups.agent }"><path d="M6 9l6 6 6-6"/></svg>
          </div>
          <div class="nav-items" v-show="groups.agent">
            <router-link v-if="!isMobile" to="/tasks" class="nav-item" :class="{ active: route.name === 'Tasks' }">
              <SvgIcon name="layers" :size="16" />
              <span>{{ $t('nav.tasks') }}</span>
            </router-link>
            <router-link v-if="!isMobile" to="/automations" class="nav-item" :class="{ active: route.name === 'Automations' }">
              <SvgIcon name="clock" :size="16" />
              <span>{{ $t('nav.automations') }}</span>
            </router-link>
            <router-link v-if="!isMobile" to="/channel" class="nav-item" :class="{ active: route.name === 'Channel' }">
              <SvgIcon name="plug" :size="16" />
              <span>{{ $t('nav.channel') }}</span>
            </router-link>
            <router-link v-if="!isMobile" to="/workspace" class="nav-item" :class="{ active: route.name === 'Workspace' }">
              <SvgIcon name="terminal" :size="16" />
              <span>{{ $t('nav.workspace') }}</span>
            </router-link>
            <router-link to="/skills" class="nav-item" :class="{ active: route.name === 'Skills' }">
              <SvgIcon name="star" :size="16" />
              <span>{{ $t('nav.skills') }}</span>
            </router-link>
            <router-link to="/memory" class="nav-item" :class="{ active: route.name === 'Memory' }">
              <SvgIcon name="brain" :size="16" />
              <span>{{ $t('nav.memory') }}</span>
            </router-link>
            <router-link v-if="!isMobile" to="/models" class="nav-item" :class="{ active: route.name === 'Models' }">
              <SvgIcon name="monitor" :size="16" />
              <span>{{ $t('nav.models') }}</span>
            </router-link>
          </div>
        </div>

        <!-- Monitor Group -->
        <div class="nav-group" v-if="!isMobile">
          <div class="nav-group-title" @click="toggleGroup('monitor')">
            <span>{{ $t('nav.monitorGroup') }}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: groups.monitor }"><path d="M6 9l6 6 6-6"/></svg>
          </div>
          <div class="nav-items" v-show="groups.monitor">
            <router-link to="/logs" class="nav-item" :class="{ active: route.name === 'Logs' }">
              <SvgIcon name="file-text" :size="16" />
              <span>{{ $t('nav.logs') }}</span>
            </router-link>
            <router-link to="/usage" class="nav-item" :class="{ active: route.name === 'Usage' }">
              <SvgIcon name="activity" :size="16" />
              <span>{{ $t('nav.usage') }}</span>
            </router-link>
          </div>
        </div>

        <!-- System Group -->
        <div class="nav-group">
          <div class="nav-group-title" @click="toggleGroup('system')">
            <span>{{ $t('nav.systemGroup') }}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: groups.system }"><path d="M6 9l6 6 6-6"/></svg>
          </div>
          <div class="nav-items" v-show="groups.system">
            <router-link v-if="!isMobile" to="/gateway" class="nav-item" :class="{ active: route.name === 'Gateway' }">
              <SvgIcon name="globe" :size="16" />
              <span>{{ $t('nav.gateway') }}</span>
            </router-link>
            <router-link v-if="!isMobile" to="/users" class="nav-item" :class="{ active: route.name === 'Users' }">
              <SvgIcon name="user" :size="16" />
              <span>{{ $t('nav.users') }}</span>
            </router-link>
            <router-link to="/settings" class="nav-item" :class="{ active: route.name === 'Settings' }">
              <SvgIcon name="settings" :size="16" />
              <span>{{ $t('nav.settings') }}</span>
            </router-link>
          </div>
        </div>

        <!-- Advanced Group — mobile only, collapsed by default -->
        <div class="nav-group" v-if="isMobile">
          <div class="nav-group-title" @click="advancedOpen = !advancedOpen">
            <span>{{ $t('nav.agentGroup') }}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: advancedOpen }"><path d="M6 9l6 6 6-6"/></svg>
          </div>
          <div class="nav-items" v-show="advancedOpen">
            <router-link to="/tasks" class="nav-item" :class="{ active: route.name === 'Tasks' }">
              <SvgIcon name="layers" :size="14" /><span>{{ $t('nav.tasks') }}</span>
            </router-link>
            <router-link to="/workspace" class="nav-item" :class="{ active: route.name === 'Workspace' }">
              <SvgIcon name="terminal" :size="14" /><span>{{ $t('nav.workspace') }}</span>
            </router-link>
            <router-link to="/automations" class="nav-item" :class="{ active: route.name === 'Automations' }">
              <SvgIcon name="clock" :size="14" /><span>{{ $t('nav.automations') }}</span>
            </router-link>
            <router-link to="/models" class="nav-item" :class="{ active: route.name === 'Models' }">
              <SvgIcon name="monitor" :size="14" /><span>{{ $t('nav.models') }}</span>
            </router-link>
            <router-link to="/logs" class="nav-item" :class="{ active: route.name === 'Logs' }">
              <SvgIcon name="file-text" :size="14" /><span>{{ $t('nav.logs') }}</span>
            </router-link>
            <router-link to="/usage" class="nav-item" :class="{ active: route.name === 'Usage' }">
              <SvgIcon name="activity" :size="14" /><span>{{ $t('nav.usage') }}</span>
            </router-link>
            <router-link to="/gateway" class="nav-item" :class="{ active: route.name === 'Gateway' }">
              <SvgIcon name="globe" :size="14" /><span>{{ $t('nav.gateway') }}</span>
            </router-link>
          </div>
        </div>
      </nav>

      <!-- ===== Session List (integrated in sidebar) ===== -->
      <div class="sidebar-chats" v-show="!sidebarCollapsed">
        <div class="chats-header" @click="toggleChatsCollapsed">
          <span class="chats-title">{{ $t('nav.chatGroup') }}</span>
          <span class="chats-actions" @click.stop>
            <button class="chats-collapse-btn" @click="toggleChatsCollapsed" :title="chatsCollapsed ? $t('nav.expand') : $t('nav.collapse')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :style="{ transform: chatsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform .2s' }"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <n-button size="tiny" quaternary @click="handleNewChat">
              <template #icon><SvgIcon name="plus" :size="16" /></template>
            </n-button>
          </span>
        </div>
        <div class="chats-list" v-show="!chatsCollapsed">
          <div
            v-for="s in chatStore.sessions"
            :key="s.id"
            class="chat-item"
            :class="{ active: s.id === chatStore.currentSessionId }"
            @click="selectSession(s.id)"
          >
            <SvgIcon name="message" :size="13" class="chat-item-icon" />
            <div class="chat-item-info">
              <div class="chat-item-title">{{ s.title }}</div>
              <div class="chat-item-meta">{{ getModelShortName(s.model) }} · {{ formatRelativeTime(s.updatedAt) }}</div>
            </div>
            <button class="chat-item-del" @click.stop="delSession(s.id)" :title="$t('common.delete')">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div v-if="chatStore.sessions.length === 0" class="chats-empty">{{ $t('nav.noSessions') }}</div>
        </div>
      </div>

      <!-- Footer -->
      <div class="sidebar-footer" v-show="!sidebarCollapsed">
        <div class="footer-row">
          <span class="footer-label">{{ $t('nav.user') }}</span>
          <span class="footer-value">{{ appStore.currentAgent }}</span>
        </div>
        <div class="footer-bottom">
          <span class="connection-status"><span class="conn-dot"></span>{{ $t('nav.connected') }}</span>
          <button class="theme-toggle" @click="appStore.toggleDarkMode()">
            <SvgIcon :name="appStore.darkMode ? 'sun' : 'moon'" :size="14" />
          </button>
        </div>
        <div class="version-info">
          <span class="version-link">SUPERCRZY BOT v{{ APP_VERSION }}</span>
          <button class="changelog-btn" @click="showChangelog = true" title="更新日志">
            <SvgIcon name="zap" :size="12" />
            <span>{{ $t('nav.changelog') }}</span>
          </button>
        </div>
      </div>
    </aside>

    <!-- ========== MAIN CONTENT ========== -->
    <main class="main-content">
      <router-view />
    </main>

    <!-- ========== RIGHT DETAIL PANEL ========== -->
    <DetailPanel
      :visible="appStore.detailPanelVisible"
      :active-tab="appStore.detailPanelTab"
      @toggle="appStore.toggleDetailPanel"
      @update:tab="appStore.setDetailPanelTab"
    />

    <!-- ========== CHANGELOG MODAL ========== -->
    <n-modal v-model:show="showChangelog" preset="card" :title="$t('nav.changelogTitle')" style="max-width:560px" @update:show="(v: boolean) => { if (!v) dismissChangelog() }">
      <div class="changelog-list">
        <div v-for="entry in CHANGELOG" :key="entry.version" class="changelog-entry">
          <div class="changelog-header">
            <span class="changelog-version">v{{ entry.version }}</span>
            <span class="changelog-date">{{ entry.date }}</span>
            <span class="changelog-title">{{ entry.title }}</span>
          </div>
          <ul v-if="entry.features.length" class="changelog-items">
            <li v-for="(f, i) in entry.features" :key="'f' + i" class="changelog-feature">{{ f }}</li>
          </ul>
          <ul v-if="entry.fixes.length" class="changelog-items">
            <li v-for="(f, i) in entry.fixes" :key="'x' + i" class="changelog-fix">{{ f }}</li>
          </ul>
        </div>
      </div>
      <template #action>
        <div class="changelog-actions">
          <span class="changelog-seen-hint">v{{ APP_VERSION }} · {{ gitHead }}</span>
          <div class="changelog-action-btns">
            <n-button v-if="updating" size="small" type="primary" loading disabled>{{ $t('nav.updating') }}</n-button>
            <n-button v-else size="small" type="primary" @click="runUpdate">{{ $t('nav.updateNow') }}</n-button>
          </div>
        </div>
        <div v-if="updateLog" class="update-log">
          <div v-for="(line, i) in updateLog" :key="i" class="update-log-line" :class="{ err: line.ok === false }">
            <span class="update-log-step">{{ line.message }}</span>
          </div>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useI18n } from 'vue-i18n'
import { useChatStore, formatRelativeTime } from '@/stores/chat'
import { getModelShortName } from '@/data/models'
import { APP_VERSION, CHANGELOG, type ChangelogEntry } from '@/data/changelog'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import DetailPanel from '@/components/layout/DetailPanel.vue'

const router = useRouter()
const route = useRoute()
const appStore = useAppStore()
const showChangelog = ref(false)
const chatStore = useChatStore()

const sidebarCollapsed = ref(false)
const mobileMenuOpen = ref(false)
const isMobile = ref(false)
const advancedOpen = ref(false)
const chatsCollapsed = ref(false)

// ---- 模型选择器选项（联合类型：普通项 / 分组项）----
type ModelSelectOption =
  | { label: string; value: string }
  | { type: 'group'; label: string; key: string; children: Array<{ label: string; value: string }> }

const isGroup = (opt: ModelSelectOption): opt is Extract<ModelSelectOption, { type: 'group' }> => 'type' in opt
const optKey = (opt: ModelSelectOption) => (isGroup(opt) ? opt.key : opt.value)
const optValue = (opt: ModelSelectOption) => (isGroup(opt) ? '' : opt.value)
const optChildren = (opt: ModelSelectOption) => (isGroup(opt) ? opt.children : [])

function checkMobile() { isMobile.value = window.innerWidth <= 768 }
onMounted(() => { checkMobile(); window.addEventListener('resize', checkMobile) })

const { t } = useI18n({ useScope: 'global' })

const currentPageTitle = computed(() => (route.meta.title ? t(route.meta.title as string) : 'SUPERCRZY BOT'))

const groups = reactive({ chat: true, agent: true, monitor: true, system: true })

function toggleGroup(g: keyof typeof groups) { groups[g] = !groups[g] }
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value }
function toggleChatsCollapsed() { chatsCollapsed.value = !chatsCollapsed.value }
function navigate(name: string) { router.push({ name }) }
function handleNewChat() { chatStore.createSession() }
function selectSession(id: string) { chatStore.selectSession(id) }
function delSession(id: string) { chatStore.deleteSession(id) }

const CHANGELOG_SEEN_KEY = 'supercrzy:changelog_seen'

const updating = ref(false)
const updateLog = ref<Array<{ message: string; ok: boolean | null }>>([])
const gitHead = ref('')

/** 一键更新：调后端 /api/system/update，SSE 流式接收进度 */
async function runUpdate() {
  if (updating.value) return
  updating.value = true
  updateLog.value = []
  try {
    const res = await fetch('/api/system/update', { method: 'POST' })
    const reader = res.body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const d = JSON.parse(line.slice(6))
            if (d.step && d.message) {
              updateLog.value.push({ message: `${d.step}${d.ok === false ? ' ✗' : d.ok === true ? ' ✓' : '...'}: ${d.message}`, ok: d.ok })
            }
          } catch {}
        }
      }
    }
  } catch (err: any) {
    updateLog.value.push({ message: `更新请求失败: ${err.message}`, ok: false })
  } finally {
    updating.value = false
    // 刷新版本信息
    loadVersion()
  }
}

/** 拉取后端版本信息（git head） */
async function loadVersion() {
  try {
    const r = await fetch('/api/system/version')
    const d = await r.json()
    gitHead.value = d.gitHead || ''
  } catch {}
}

onMounted(() => {
  appStore.loadSettings()
  chatStore.loadSessions()
  loadVersion()
  // 版本更新提示：已读版本 ≠ 当前版本 → 自动弹出更新日志
  checkChangelogAutoOpen()
})

/** 自动版本提示：新版本发布后首次打开应用弹更新日志 */
function checkChangelogAutoOpen() {
  try {
    const seen = localStorage.getItem(CHANGELOG_SEEN_KEY)
    if (seen !== APP_VERSION) {
      // 延迟到页面渲染稳定后弹出
      setTimeout(() => { showChangelog.value = true }, 600)
    }
  } catch { /* localStorage 不可用时静默 */ }
}

function dismissChangelog(remember = true) {
  showChangelog.value = false
  if (remember) {
    try { localStorage.setItem(CHANGELOG_SEEN_KEY, APP_VERSION) } catch {}
  }
}
</script>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  background: var(--bg-primary);
  color: var(--text-primary);
}

/* ===== Sidebar ===== */
.sidebar {
  width: 220px;
  min-width: 220px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  transition: width var(--duration-normal) var(--ease-out),
              min-width var(--duration-normal) var(--ease-out);
  position: relative;
}

.sidebar.collapsed {
  width: 52px;
  min-width: 52px;
}

.sidebar-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-color);
}

.logo-icon {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  object-fit: contain;
}

.logo-text {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  font-family: 'Saira Stencil One', sans-serif;
  letter-spacing: 1px;
}

.collapse-btn {
  position: absolute;
  top: 14px;
  right: -14px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  z-index: 10;
  padding: 0;
}

.collapse-btn:hover {
  background: var(--bg-secondary);
}

.nav-groups {
  flex: 0 1 auto;
  overflow-y: auto;
  padding: 6px 0;
  max-height: 40vh;
}

.nav-group { margin-bottom: 2px; }

.nav-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-muted);
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.nav-group-title:hover { color: var(--text-secondary); }

.nav-group-title svg {
  transition: transform var(--duration-normal) var(--ease-out);
}

.nav-group-title svg.rotated { transform: rotate(180deg); }

.nav-items {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 6px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-secondary);
  text-decoration: none;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-item.active,
.nav-item.router-link-exact-active {
  background: var(--bg-active);
  color: var(--accent);
  font-weight: 500;
}

/* ===== Sidebar Chats (integrated session list) ===== */
.sidebar-chats {
  flex: 1;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border-color);
  min-height: 40px;
  overflow: hidden;
}
.chats-actions { display: flex; align-items: center; gap: 2px; }
.chats-collapse-btn {
  background: none; border: none; cursor: pointer;
  color: var(--text-muted); padding: 4px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
}
.chats-collapse-btn:hover { background: var(--bg-hover, rgba(127,127,127,.12)); color: var(--text-primary); }

.chats-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 6px;
  flex-shrink: 0;
}

.chats-title {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.chats-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 6px;
}

.chat-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
  position: relative;
}

.chat-item:hover { background: var(--bg-hover); }
.chat-item.active { background: var(--bg-active); }

.chat-item-icon {
  color: var(--text-muted);
  flex-shrink: 0;
  margin-top: 1px;
}

.chat-item-info {
  flex: 1;
  min-width: 0;
}

.chat-item-title {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
}

.chat-item-meta {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 1px;
  line-height: 1.3;
}

.chat-item-del {
  opacity: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-muted);
  padding: 0;
  flex-shrink: 0;
  transition: opacity var(--duration-fast);
}

.chat-item:hover .chat-item-del { opacity: 0.4; }
.chat-item-del:hover { opacity: 1 !important; color: var(--error); background: var(--error-muted); }

.chats-empty {
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  padding: 16px 8px;
}

/* ===== Sidebar Model Selector ===== */
/* .sidebar-model removed (moved to chat composer) */


.sidebar-model-select:focus {
  border-color: var(--accent, #4F46E5);
}
.sidebar-model-select option {
  background: var(--bg-primary);
  color: var(--text-primary);
}

.model-add-link:hover { color: var(--accent); }

/* ===== Sidebar Footer (always at bottom) ===== */
.sidebar-footer {
  padding: 8px 12px;
  border-top: 1px solid var(--border-color);
  font-size: var(--text-sm);
  flex-shrink: 0;
}

.footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.footer-label { color: var(--text-muted); font-size: 11px; }
.footer-value { color: var(--text-primary); font-weight: 500; font-size: 11px; }
.model-mini { width: 100%; }

.footer-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 6px 0;
}

.connection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.conn-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success);
}

.theme-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
  background: transparent;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 0;
}

.theme-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.version-info {
  font-size: var(--text-xs);
  color: var(--text-muted);
  text-align: center;
  margin-top: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.version-link {
  color: var(--text-muted);
  text-decoration: none;
}

.changelog-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--accent);
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  cursor: pointer;
  transition: background .15s, border-color .15s;
}

.changelog-btn:hover {
  background: var(--accent-subtle);
  border-color: var(--accent);
}

/* ===== Changelog Modal ===== */
.changelog-list {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-height: 60vh;
  overflow-y: auto;
  padding-right: 4px;
}

.changelog-entry {
  border-left: 3px solid var(--border-color);
  padding-left: 14px;
}

.changelog-entry:first-child {
  border-left-color: var(--accent);
}

.changelog-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.changelog-version {
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
}

.changelog-date {
  font-size: 11px;
  color: var(--text-muted);
}

.changelog-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.changelog-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.changelog-feature,
.changelog-fix {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  padding-left: 14px;
  position: relative;
}

.changelog-feature::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}

.changelog-fix::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warning);
}

.changelog-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.changelog-seen-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.update-log {
  margin-top: 12px;
  max-height: 160px;
  overflow-y: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 8px 12px;
}

.update-log-line {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
}

.update-log-line.err {
  color: var(--error);
}

/* ===== Main Content ===== */
.main-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

/* =================================================================
   MOBILE ( ≤ 768px )
   ================================================================= */
@media (max-width: 768px) {
  /* app-layout needs top padding to account for fixed topbar */
  .app-layout { flex-direction: column; padding-top: 48px; }

  /* Top bar — fixed so it stays visible when scrolling */
  .mobile-topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 48px;
    padding: 0 12px;
    background: var(--bg-sidebar);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
  }

  .hamburger-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px; height: 32px;
    border: none; background: none;
    color: var(--text-primary);
    cursor: pointer; padding: 0;
    flex-shrink: 0;
  }

  .mobile-logo {
    width: 24px; height: 24px;
    border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    object-fit: contain;
  }

  .mobile-title {
    flex: 1;
    font-size: 14px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .mobile-new-chat {
    display: flex; align-items: center; justify-content: center;
    width: 32px; height: 32px;
    border: none; background: none;
    color: var(--text-secondary);
    cursor: pointer; padding: 0;
  }

  /* Overlay */
  .mobile-overlay {
    position: fixed;
    inset: 48px 0 0 0;
    background: rgba(0,0,0,0.5);
    z-index: 98;
  }

  /* Sidebar slides in */
  .sidebar {
    position: fixed;
    top: 48px; left: 0; bottom: 0;
    width: 260px;
    z-index: 99;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    box-shadow: 4px 0 20px rgba(0,0,0,0.3);
  }

  .sidebar.mobile-open {
    transform: translateX(0);
  }

  .sidebar.collapsed { transform: translateX(-100%); }

  /* Hide desktop elements */
  .collapse-btn { display: none; }
  .sidebar-header { padding: 12px 14px; }

  /* Keep nav groups expanded for quick access on mobile */
  .nav-groups { flex: 1; max-height: none; }

  .nav-item { min-height: 48px; font-size: 14px; }

  /* Hide chat history in sidebar — use History page instead */
  .sidebar-chats { display: none !important; }

  /* Main content fills rest */
  .main-content {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  /* Detail panel on mobile: bottom sheet */
  :deep(.detail-panel) {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    height: 50vh;
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -4px 20px rgba(0,0,0,0.2);
  }

  :deep(.detail-panel-slide-enter-active),
  :deep(.detail-panel-slide-leave-active) {
    transition: transform 0.3s ease;
  }
  :deep(.detail-panel-slide-enter-from),
  :deep(.detail-panel-slide-leave-to) {
    transform: translateY(100%);
  }
}

/* ===== Hide mobile topbar on desktop ===== */
.mobile-topbar { display: none; }
.mobile-overlay { display: none; }

@media (max-width: 768px) {
  .mobile-topbar { display: flex; }
  .mobile-overlay { display: block; }
}
</style>
