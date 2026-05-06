<template>
  <div class="app-layout" :class="{ dark: appStore.darkMode }">
    <!-- ========== LEFT SIDEBAR ========== -->
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header" @click="navigate('Chat')">
        <div class="logo-icon">DA</div>
        <span class="logo-text" v-show="!sidebarCollapsed">DeepSeek Agent</span>
      </div>

      <button class="collapse-btn" @click="toggleSidebar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path v-if="!sidebarCollapsed" d="M11 19l-7-7 7-7m8 14l-7-7 7-7"/>
          <path v-else d="M13 5l7 7-7 7M6 5l7 7-7 7"/>
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <span>{{ $t('nav.chat') }}</span>
            </router-link>
            <router-link to="/history" class="nav-item" :class="{ active: route.name === 'History' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span>{{ $t('nav.history') }}</span>
            </router-link>
            <router-link to="/search" class="nav-item" :class="{ active: route.name === 'Search' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
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
            <router-link to="/tasks" class="nav-item" :class="{ active: route.name === 'Tasks' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>
              <span>{{ $t('nav.tasks') }}</span>
            </router-link>
            <router-link to="/channel" class="nav-item" :class="{ active: route.name === 'Channel' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span>{{ $t('nav.channel') }}</span>
            </router-link>
            <router-link to="/workspace" class="nav-item" :class="{ active: route.name === 'Workspace' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
              <span>工作台</span>
            </router-link>
            <router-link to="/skills" class="nav-item" :class="{ active: route.name === 'Skills' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              <span>{{ $t('nav.skills') }}</span>
            </router-link>
            <router-link to="/memory" class="nav-item" :class="{ active: route.name === 'Memory' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              <span>{{ $t('nav.memory') }}</span>
            </router-link>
            <router-link to="/models" class="nav-item" :class="{ active: route.name === 'Models' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              <span>{{ $t('nav.models') }}</span>
            </router-link>
          </div>
        </div>

        <!-- Monitor Group -->
        <div class="nav-group">
          <div class="nav-group-title" @click="toggleGroup('monitor')">
            <span>{{ $t('nav.monitorGroup') }}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: groups.monitor }"><path d="M6 9l6 6 6-6"/></svg>
          </div>
          <div class="nav-items" v-show="groups.monitor">
            <router-link to="/logs" class="nav-item" :class="{ active: route.name === 'Logs' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <span>{{ $t('nav.logs') }}</span>
            </router-link>
            <router-link to="/usage" class="nav-item" :class="{ active: route.name === 'Usage' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
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
            <router-link to="/gateway" class="nav-item" :class="{ active: route.name === 'Gateway' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              <span>{{ $t('nav.gateway') }}</span>
            </router-link>
            <router-link to="/users" class="nav-item" :class="{ active: route.name === 'Users' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <span>{{ $t('nav.users') }}</span>
            </router-link>
            <router-link to="/settings" class="nav-item" :class="{ active: route.name === 'Settings' }">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              <span>{{ $t('nav.settings') }}</span>
            </router-link>
          </div>
        </div>
      </nav>

      <!-- Footer -->
      <div class="sidebar-footer" v-show="!sidebarCollapsed">
        <div class="footer-row"><span class="footer-label">{{ $t('nav.user') }}</span><span class="footer-value">{{ appStore.currentAgent }}</span></div>
        <div class="footer-row" style="flex-direction: column; align-items: flex-start; gap: 4px;"><span class="footer-label">{{ $t('nav.model') }}</span>
          <n-select size="tiny" :value="appStore.currentModel" :options="modelOpts" @update:value="appStore.setModel" class="model-mini" filterable :consistent-menu-width="false" />
        </div>
        <div class="footer-bottom">
          <span class="connection-status"><span class="conn-dot"></span>{{ $t('nav.connected') }}</span>
          <n-switch size="small" :value="appStore.darkMode" @update:value="appStore.toggleDarkMode()">
            <template #checked>🌙</template><template #unchecked>☀️</template>
          </n-switch>
        </div>
        <div class="version-info">
          <a href="#" class="version-link">DeepSeek Agent v0.1.0</a>
        </div>
      </div>
    </aside>

    <!-- ========== SESSION LIST (Chat Only) ========== -->
    <div class="session-panel" v-if="showSessionPanel">
      <div class="session-header">
        <span class="session-header-title">{{ $t('nav.sessionTitle') }}</span>
        <n-button size="tiny" quaternary @click="handleNewChat" :title="$t('chat.newChat')">
          <template #icon><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></template>
        </n-button>
      </div>
      <div class="session-hint">{{ $t('nav.sessionHint') }}</div>
      <div class="session-list">
        <div v-for="s in chatStore.sessions" :key="s.id" class="session-item" :class="{ active: s.id === chatStore.currentSessionId }" @click="selectSession(s.id)">
          <div class="session-icon">💬</div>
          <div class="session-info"><div class="session-title">{{ s.title }}</div><div class="session-meta">{{ s.model }} · {{ fmtDate(s.updatedAt) }}</div></div>
          <n-button class="session-del" quaternary circle size="tiny" @click.stop="delSession(s.id)"><template #icon>×</template></n-button>
        </div>
        <n-empty v-if="chatStore.sessions.length === 0" :description="$t('nav.noSessions')" class="empty-hint" />
      </div>
    </div>

    <!-- ========== MAIN CONTENT ========== -->
    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useChatStore } from '@/stores/chat'
import { getModelSelectOptions } from '@/data/models'

const router = useRouter()
const route = useRoute()
const appStore = useAppStore()
const chatStore = useChatStore()

const sidebarCollapsed = ref(false)

const groups = reactive({ chat: true, agent: true, monitor: true, system: true })

const modelOpts = getModelSelectOptions()

// Show session panel only on Chat route
const showSessionPanel = computed(() => route.name === 'Chat')

function toggleGroup(g: keyof typeof groups) { groups[g] = !groups[g] }
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value }
function navigate(name: string) { router.push({ name }) }
function handleNewChat() { chatStore.createSession() }
function selectSession(id: string) { chatStore.selectSession(id) }
function delSession(id: string) { chatStore.deleteSession(id) }
function fmtDate(d: string) {
  const diff = Date.now() - new Date(d).getTime()
  if (diff < 60000) return '刚刚'; if (diff < 3600000) return `${Math.floor(diff / 60000)}m 前`; if (diff < 86400000) return `${Math.floor(diff / 3600000)}h 前`
  return new Date(d).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}
</script>

<style scoped>
.app-layout { display: flex; height: 100vh; background: var(--bg-primary); color: var(--text-primary); --bg-primary: #fff; --bg-secondary: #f5f5f5; --bg-sidebar: #fafafa; --text-primary: #1a1a1a; --text-secondary: #666; --text-muted: #999; --border-color: #e5e5e5; --accent: #4F46E5; --accent-light: #EEF2FF; }
.app-layout.dark { --bg-primary: #1a1a2e; --bg-secondary: #16213e; --bg-sidebar: #0f0f23; --text-primary: #e5e5e5; --text-secondary: #a0a0a0; --text-muted: #666; --border-color: #2a2a4a; --accent: #6366F1; --accent-light: #1e1b4b; }

/* Sidebar */
.sidebar { width: 200px; min-width: 200px; background: var(--bg-sidebar); border-right: 1px solid var(--border-color); display: flex; flex-direction: column; transition: width .2s,min-width .2s; position: relative; }
.sidebar.collapsed { width: 52px; min-width: 52px; }
.sidebar-header { display: flex; align-items: center; gap: 10px; padding: 14px 14px; cursor: pointer; border-bottom: 1px solid var(--border-color); }
.logo-icon { width: 28px; height: 28px; border-radius: 7px; background: linear-gradient(135deg, #4F46E5, #06B6D4); color: #fff; font-weight: 700; font-size: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.logo-text { font-size: 14px; font-weight: 600; white-space: nowrap; }
.collapse-btn { position: absolute; top: 14px; right: -14px; width: 28px; height: 28px; border-radius: 50%; background: var(--bg-primary); border: 1px solid var(--border-color); cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); z-index: 10; padding: 0; }
.collapse-btn:hover { background: var(--bg-secondary); }
.nav-groups { flex: 1; overflow-y: auto; padding: 6px 0; }
.nav-group { margin-bottom: 2px; }
.nav-group-title { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; font-size: 11px; font-weight: 600; color: var(--text-muted); cursor: pointer; text-transform: uppercase; letter-spacing: .5px; }
.nav-group-title:hover { color: var(--text-secondary); }
.nav-group-title svg { transition: transform .2s; }
.nav-group-title svg.rotated { transform: rotate(180deg); }
.nav-items { display: flex; flex-direction: column; gap: 1px; padding: 0 6px; }
.nav-item { display: flex; align-items: center; gap: 9px; padding: 7px 10px; border-radius: 6px; font-size: 13px; color: var(--text-secondary); text-decoration: none; cursor: pointer; transition: background .12s,color .12s; }
.nav-item:hover { background: var(--bg-secondary); color: var(--text-primary); }
.nav-item.active { background: var(--accent-light); color: var(--accent); font-weight: 500; }
.nav-item.router-link-active { background: var(--accent-light); color: var(--accent); font-weight: 500; }

/* Footer */
.sidebar-footer { padding: 10px 12px; border-top: 1px solid var(--border-color); font-size: 12px; }
.footer-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.footer-label { color: var(--text-muted); }
.footer-value { color: var(--text-primary); font-weight: 500; }
.model-mini { width: 100%; }
.footer-bottom { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; }
.connection-status { display: flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 11px; }
.conn-dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; }
.version-info { font-size: 11px; color: var(--text-muted); text-align: center; margin-top: 4px; }
.version-link { color: var(--text-muted); text-decoration: none; }

/* Session Panel */
.session-panel { width: 260px; min-width: 260px; border-right: 1px solid var(--border-color); display: flex; flex-direction: column; background: var(--bg-secondary); }
.session-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--border-color); }
.session-header-title { font-size: 13px; font-weight: 600; }
.session-hint { font-size: 11px; color: var(--text-muted); padding: 8px 14px; border-bottom: 1px solid var(--border-color); line-height: 1.5; }
.session-list { flex: 1; overflow-y: auto; padding: 6px 8px; }
.session-item { display: flex; align-items: center; gap: 8px; padding: 10px; border-radius: 8px; cursor: pointer; transition: background .12s; position: relative; }
.session-item:hover { background: var(--bg-primary); }
.session-item.active { background: var(--accent-light); }
.session-icon { font-size: 15px; flex-shrink: 0; }
.session-info { flex: 1; min-width: 0; }
.session-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.session-del { opacity: 0; transition: opacity .12s; }
.session-item:hover .session-del { opacity: .5; }
.session-del:hover { opacity: 1 !important; }
.empty-hint { margin-top: 40px; }

.main-content { flex: 1; min-width: 0; overflow: hidden; }
</style>
