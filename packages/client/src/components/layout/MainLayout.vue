<template>
  <div class="app-layout" :style="{ '--sidebar-w': sidebarCollapsed ? '48px' : sidebarWidth + 'px' }">
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
      <span class="mobile-title">{{ currentPageTitle }}</span>
      <!-- 移动端操作组（聊天页）：产物 / 搜索 / 分享 / 详情面板 —— 与 ChatView header 合并避免双层标题栏 -->
      <div v-if="route.name === 'Chat'" class="mobile-actions">
        <button class="mobile-action-btn" @click="dispatchChatAction('artifacts')" :title="$t('chat.artifactsTitle')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="mobile-action-btn" @click="dispatchChatAction('search')" :title="$t('chat.searchMessages')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
        </button>
        <button class="mobile-action-btn" @click="dispatchChatAction('share')" :title="$t('chat.share')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        </button>
        <button class="mobile-action-btn" :class="{ active: appStore.detailPanelVisible }" @click="appStore.toggleDetailPanel()" :title="$t('nav.detailPanel')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
        </button>
      </div>
      <button class="mobile-new-chat" @click="handleNewChat" :title="$t('nav.newTask')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>

    <!-- Mobile overlay backdrop -->
    <div class="mobile-overlay" v-if="mobileMenuOpen" @click="mobileMenuOpen = false"></div>

    <!-- 红绿灯悬浮区（仅 Electron App）：独立横条横跨全窗口（对齐 WorkBuddy main-header）。
         三段：①红绿灯(0~87px) ②侧边栏上方(87~220px，收缩按钮驻留) ③工作区段(220px+，会话标题+模型+操作)。
         sidebar 收缩不影响它；整行可拖拽；交互元素 no-drag。
         展开/收起：横栏收缩按钮、单击分隔条、Cmd+B（按钮式，无拖拽） -->
    <div v-if="isDesktop" class="traffic-spacer">
      <div class="traffic-sidebar-zone"></div>
      <!-- 工作区段：当前会话标题 + 模型 + 工作区 + 上下文用量 -->
      <div class="traffic-workspace-zone" :class="{ collapsed: sidebarCollapsed }">
        <!-- 可编辑标题：hover 显示笔，点笔进入编辑态重命名会话 -->
        <div v-if="editingTitle" class="traffic-title-edit">
          <input
            ref="titleInputRef"
            v-model="editingTitleValue"
            class="traffic-title-input"
            :placeholder="$t('nav.newTask')"
            @keyup.enter="saveRename"
            @keyup.esc="cancelRename"
            @blur="saveRename"
          />
        </div>
        <div v-else class="traffic-title-wrap">
          <span class="traffic-session-title">{{ chatStore.currentSession?.title || $t('nav.newTask') }}</span>
          <button v-if="chatStore.currentSession" class="traffic-rename-btn" @click="startRename" :title="$t('chat.renameTitle')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
        </div>
        <!-- 上下文用量圆环（会话信息组：标题/模型后；操作按钮区保持纯操作） -->
        <ContextUsageRing />
        <!-- 任务进度胶囊（环形进度右侧；Web 端在 chat-header 同位置） -->
        <PlanCapsule />
      </div>
      <div class="traffic-actions">
        <!-- 本会话产物（App 端 header 隐藏后保留入口，事件驱动 ChatView 弹层） -->
        <button class="traffic-action-btn" @click="dispatchChatAction('artifacts')" :title="$t('chat.artifactsTitle')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </button>
        <!-- 历史消息搜索（App 端 header 隐藏后保留入口） -->
        <button class="traffic-action-btn" @click="dispatchChatAction('search')" :title="$t('chat.searchMessages')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
        </button>
        <!-- 对话分享（Grok 式传播：复制/下载 Markdown、生成分享图） -->
        <button class="traffic-action-btn" @click="dispatchChatAction('share')" :title="$t('chat.share')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        </button>
        <!-- 右侧面板开关（会话级：产物/文件/变更/预览/时间线/幽灵；与 Web header 分享后同位置） -->
        <button class="traffic-action-btn" :class="{ active: appStore.detailPanelVisible }" @click="appStore.toggleDetailPanel()" :title="$t('nav.detailPanel')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
        </button>
      </div>
    </div>

    <div class="app-body">
    <!-- ========== LEFT SIDEBAR ========== -->
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed, 'mobile-open': mobileMenuOpen }">
      <!-- Logo：点击伸缩侧边栏（展开顺时针 360° / 收起逆时针 360°），旋转与伸缩进度同步 -->
      <div
        class="sidebar-header"
        @click="onLogoClick"
        :title="sidebarCollapsed ? $t('nav.expand') : $t('nav.collapse')"
      >
        <img src="/logo.png" alt="SUPERCRZY" class="logo-icon" :style="{ transform: `rotate(${logoAngle}deg)` }" />
        <span class="logo-text" v-show="!sidebarCollapsed"><span class="logo-brand"><span class="brand-name">SUPERCRZY</span> <span class="bot-badge">BOT</span></span></span>
      </div>

      <!-- 伸缩按钮已移到侧边栏底部 footer（展开态在主题左侧 / 收起态在头像上方），不再骑缘 -->

      <!-- 收起态图标列（Web 与 App 一致：收缩后保留核心功能 SVG，Grok 同款窄栏） -->
      <nav v-if="sidebarCollapsed && !isMobile" class="sidebar-icon-rail">
        <button class="rail-btn" :class="{ active: route.name === 'Chat' }" @click="handleNewChat" :title="$t('nav.newTask')">
          <SvgIcon name="message" :size="17" />
        </button>
        <router-link to="/collab" class="rail-btn" :class="{ active: route.name === 'Collab' }" :title="$t('nav.collab')">
          <SvgIcon name="messages" :size="17" />
        </router-link>
          <router-link to="/automations" class="rail-btn" :class="{ active: route.name === 'Automations' || route.name === 'Routines' }" :title="$t('nav.autoExec')">
            <SvgIcon name="clock" :size="17" />
          </router-link>
          <router-link to="/skills" class="rail-btn" :class="{ active: route.name === 'Skills' }" :title="$t('nav.skills')">
            <SvgIcon name="star" :size="17" />
          </router-link>
        </nav>

      <!-- Navigation Groups -->
      <nav class="nav-groups" v-show="!sidebarCollapsed">
        <!-- 导航平铺（无分组标题）：新建任务 + 功能入口 -->
        <div class="nav-items" style="padding: 2px 8px;">
          <!-- 超级协作平台：置顶主入口（多 AI 协作工作台，取代幽灵工作台） -->
          <router-link to="/collab" class="nav-item collab-nav" :class="{ active: route.name === 'Collab' }">
            <SvgIcon name="messages" :size="16" />
            <span>{{ $t('nav.collab') }}</span>
          </router-link>
          <!-- 新建任务：点击创建新会话并进入欢迎页；已有对话从下方会话列表进入 -->
          <router-link to="/" class="nav-item" :class="{ active: route.name === 'Chat' }" @click="handleNewChat">
            <SvgIcon name="message" :size="16" />
            <span>{{ $t('nav.newTask') }}</span>
          </router-link>
          <router-link v-if="!isMobile" to="/automations" class="nav-item" :class="{ active: route.name === 'Automations' || route.name === 'Routines' }">
            <SvgIcon name="clock" :size="16" />
            <span>{{ $t('nav.autoExec') }}</span>
          </router-link>
          <router-link to="/skills" class="nav-item" :class="{ active: route.name === 'Skills' }">
            <SvgIcon name="star" :size="16" />
            <span>{{ $t('nav.skills') }}</span>
          </router-link>
          <!-- AI 资讯（新闻生态看板，2026-08-28 加）：supercrzy.com 实时 AI 新闻 -->
          <router-link to="/news" class="nav-item" :class="{ active: route.name === 'News' }">
            <SvgIcon name="globe" :size="16" />
            <span>{{ $t('nav.news') }}</span>
          </router-link>
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
          <!-- 空间分组：按工作区目录归类会话（对齐 WorkBuddy） -->
          <div v-for="g in chatStore.groupedSessions" :key="g.key" class="chat-group">
            <div class="chat-group-header" @click="toggleGroup(g.key)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="chat-group-caret" :class="{ rotated: !collapsedGroups.has(g.key) }"><polyline points="6 9 12 15 18 9"/></svg>
              <SvgIcon v-if="g.key !== '__temp__'" name="folder" :size="12" class="chat-group-icon" />
              <SvgIcon v-else name="message" :size="12" class="chat-group-icon" />
              <span class="chat-group-title">{{ g.key === '__temp__' ? $t('nav.tempGroup') : displayPath(g.title) }}</span>
              <span class="chat-group-count">{{ g.sessions.length }}</span>
            </div>
            <div v-show="!collapsedGroups.has(g.key)" class="chat-group-items">
              <div
                v-for="s in g.sessions"
                :key="s.id"
                class="chat-item"
                :class="{ active: s.id === chatStore.currentSessionId }"
                @click="selectSession(s.id)"
              >
                <SvgIcon name="message" :size="13" class="chat-item-icon" />
                <div class="chat-item-info">
                  <div class="chat-item-title">{{ s.title }}</div>
                  <div class="chat-item-meta">{{ formatRelativeTime(s.updatedAt) }}</div>
                </div>
                <n-dropdown
                  trigger="click"
                  placement="bottom-end"
                  class="session-menu-pop"
                  :options="sessionMenuOptions(s)"
                  @select="(key: string) => onSessionMenu(key, s.id)"
                >
                  <button class="chat-item-del" @click.stop title="更多">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
                  </button>
                </n-dropdown>
              </div>
            </div>
          </div>
          <div v-if="chatStore.groupedSessions.length === 0" class="chats-empty">{{ $t('nav.noSessions') }}</div>

          <!-- 归档区：归档会话折叠组（可恢复/删除） -->
          <div v-if="chatStore.archivedSessions.length > 0" class="chat-group archived-group">
            <div class="chat-group-header" @click="archiveGroupOpen = !archiveGroupOpen">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="chat-group-caret" :class="{ rotated: archiveGroupOpen }"><polyline points="6 9 12 15 18 9"/></svg>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="chat-group-icon"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v10a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V9"/><line x1="10" y1="13" x2="14" y2="13"/></svg>
              <span class="chat-group-title">{{ $t('nav.archiveGroup') }}</span>
              <span class="chat-group-count">{{ chatStore.archivedSessions.length }}</span>
            </div>
            <div v-show="archiveGroupOpen" class="chat-group-items">
              <div
                v-for="s in chatStore.archivedSessions"
                :key="s.id"
                class="chat-item"
                :class="{ active: s.id === chatStore.currentSessionId }"
                @click="selectSession(s.id)"
              >
                <SvgIcon name="message" :size="13" class="chat-item-icon" />
                <div class="chat-item-info">
                  <div class="chat-item-title">{{ s.title }}</div>
                  <div class="chat-item-meta">{{ formatRelativeTime(s.updatedAt) }}</div>
                </div>
                <n-dropdown
                  trigger="click"
                  placement="bottom-end"
                  class="session-menu-pop"
                  :options="sessionMenuOptions(s)"
                  @select="(key: string) => onSessionMenu(key, s.id)"
                >
                  <button class="chat-item-del" @click.stop title="更多">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
                  </button>
                </n-dropdown>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer: 展开态单行（用户 + 收起|主题|设置）/ 收起态仅头像（展开入口改为顶部 LOGO 点击） -->
      <div class="sidebar-footer" :class="{ collapsed: sidebarCollapsed }">
        <button v-if="sidebarCollapsed" class="footer-user collapsed-user" @click="openProfile" :title="$t('nav.user')">
          <span class="footer-avatar-wrap">
            <ProfileAvatar :avatar="appStore.userAvatar" :name="appStore.userName || 'U'" :size="26" :radius="7" />
            <span class="conn-dot"></span>
          </span>
        </button>
        <template v-else>
          <button class="footer-user" @click="openProfile" :title="$t('nav.user')">
            <span class="footer-avatar-wrap">
              <ProfileAvatar :avatar="appStore.userAvatar" :name="appStore.userName || 'U'" :size="26" :radius="7" />
              <span class="conn-dot"></span>
            </span>
            <span class="footer-value">{{ appStore.userName || 'SUPERCRZY' }}</span>
          </button>
          <div class="footer-actions">
            <button class="theme-toggle" @click="appStore.toggleDarkMode()" :title="$t('nav.theme')">
              <SvgIcon :name="appStore.darkMode ? 'sun' : 'moon'" :size="14" />
            </button>
            <button class="settings-btn" @click="() => openSettings()" :title="$t('nav.settings')">
              <SvgIcon name="settings" :size="14" />
            </button>
          </div>
        </template>
      </div>
    </aside>

    <!-- 分隔条（sash）：侧边栏右缘蓝色细线，单击切换展开/收起（与 App 端一致的伸缩入口；移动端抽屉式布局不显示） -->
    <div
      v-if="!isMobile"
      class="sidebar-sash"
      @click="toggleSidebar"
      :title="sidebarCollapsed ? $t('nav.expand') : $t('nav.collapse')"
    ></div>

    <!-- 会话工作目录选择弹窗（三点菜单"选择工作目录"打开） -->
    <WorkspacePickerModal
      :show="!!wsPickerSessionId"
      :initial-path="(chatStore.sessions.find((s) => s.id === wsPickerSessionId)?.workspaceDir) || ''"
      @select="onPickWorkspace"
      @close="wsPickerSessionId = null"
    />

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
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { useI18n } from 'vue-i18n'
import { useChatStore, formatRelativeTime } from '@/stores/chat'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import ProfileAvatar from '@/components/ui/ProfileAvatar.vue'
import DetailPanel from '@/components/layout/DetailPanel.vue'
import ContextUsageRing from '@/components/chat/ContextUsageRing.vue'
import PlanCapsule from '@/components/chat/PlanCapsule.vue'
import WorkspacePickerModal from '@/components/workspace/WorkspacePickerModal.vue'

const router = useRouter()
const route = useRoute()
const appStore = useAppStore()
const chatStore = useChatStore()

const sidebarCollapsed = ref(false)
// ---- 横栏标题重命名（点笔编辑会话标题） ----
const editingTitle = ref(false)
const editingTitleValue = ref('')
const titleInputRef = ref<HTMLInputElement>()
function startRename() {
  if (!chatStore.currentSession) return
  editingTitleValue.value = chatStore.currentSession.title
  editingTitle.value = true
  nextTick(() => titleInputRef.value?.focus())
}
async function saveRename() {
  if (!editingTitle.value) return
  editingTitle.value = false
  const sid = chatStore.currentSessionId
  if (sid) await chatStore.renameSession(sid, editingTitleValue.value)
}
function cancelRename() { editingTitle.value = false }
/** 侧边栏展开宽度：固定 220px（按钮式交互，无拖拽调宽） */
const sidebarWidth = ref(220)

const mobileMenuOpen = ref(false)
const isMobile = ref(false)
const chatsCollapsed = ref(false)

// ---- 桌面 App 沉浸式顶栏：isDesktop（Electron 环境，setup 同步判断避免首帧延迟）+ 后端状态 ----
const isDesktop = ref(false)
const backendReady = ref('')
;(() => {
  try {
    const d = (window as any).supercrzyDesktop
    if (d?.isDesktop) {
      isDesktop.value = true
      d.onBackendStatus?.((s: any) => { backendReady.value = s.status === 'ready' ? '已连接' : s.status })
    }
  } catch { /* 浏览器环境 */ }
})()

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

const { t, locale } = useI18n({ useScope: 'global' })
const nMessage = useMessage()

/** 是否中文界面（更新日志按语言展示） */
const isZh = computed(() => locale.value.startsWith('zh'))

/** 顶部标题（移动端）：聊天页显示当前任务标题（无会话=新建任务），其它页用路由 meta */
const currentPageTitle = computed(() => {
  if (route.path.startsWith('/chat')) {
    return chatStore.currentSession?.title || t('nav.newTask')
  }
  return route.meta.title ? t(route.meta.title as string) : 'SUPERCRZY BOT'
})

function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value }

/** LOGO 累计旋转角：展开 +360°（顺时针）/ 收起 -360°（逆时针），转盘式反馈 */
const logoAngle = ref(0)

function onLogoClick() {
  logoAngle.value += sidebarCollapsed.value ? 360 : -360
  toggleSidebar()
}

/** 桌面端横栏功能按钮 → 通知 ChatView 打开产物弹层/搜索弹窗/分享菜单（App 端 header 隐藏后的入口）。
    非聊天页时先跳回聊天页，等组件挂载完成（懒加载 chunk）再发事件 */
function dispatchChatAction(action: 'artifacts' | 'search' | 'share') {
  if (route.name !== 'Chat') {
    router.push({ name: 'Chat' })
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('supercrzy:chat-action', { detail: action }))
    }, 200)
  } else {
    window.dispatchEvent(new CustomEvent('supercrzy:chat-action', { detail: action }))
  }
}

// Cmd+B / Ctrl+B 切换侧边栏（Grok mod+b 同款）
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault()
    sidebarCollapsed.value = !sidebarCollapsed.value
  }
}
onMounted(() => { window.addEventListener('keydown', onKeydown) })
onUnmounted(() => { window.removeEventListener('keydown', onKeydown) })
function toggleChatsCollapsed() { chatsCollapsed.value = !chatsCollapsed.value }
function handleNewChat() {
  // 不立即创建会话：回到欢迎页草稿态，发送第一条消息时才真正建会话（避免空"新对话"堆积）
  chatStore.resetToWelcome()
  if (route.name !== 'Chat') router.push({ name: 'Chat' })
}

// =================================================================
// 空间分组：会话按工作区目录归类（对齐 WorkBuddy）；wsCurrent 供 ChatView 全局工作区使用
// =================================================================
/** 当前工作区（localStorage 持久化；会话创建时绑定到 workspace_dir） */
const wsCurrent = ref(localStorage.getItem('supercrzy:workspace') || '')

/** 折叠的分组 key 集合（默认全部展开） */
const collapsedGroups = ref<Set<string>>(new Set())
const archiveGroupOpen = ref(false)
function toggleGroup(key: string) {
  const next = new Set(collapsedGroups.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedGroups.value = next
}

/** 路径显示：取最后两段 */
function displayPath(p: string) {
  const parts = p.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || p
}

function selectSession(id: string) {
  chatStore.selectSession(id)
  // 从任务/工作台等页面点会话 → 跳回聊天页（否则只切了状态、页面没反应）
  if (route.name !== 'Chat') router.push({ name: 'Chat' })
}
async function delSession(id: string) {
  try {
    await chatStore.deleteSession(id)
  } catch {
    // 删除失败已回滚本地，提示用户（避免"界面删了但刷新又出现"）
    nMessage.error(t('chat.deleteFail') || '删除失败，请重试')
  }
}

// ============ 会话三点菜单（更多）：选择工作目录 / 删除 ============
/** 正在选择工作目录的会话 id（null = 弹窗关闭） */
const wsPickerSessionId = ref<string | null>(null)

/** 三点菜单选项（目录过长时只显示最后两段短名） */
function sessionMenuOptions(s: { id: string; workspaceDir?: string; archived?: boolean }): Array<{ label: string; key: string; title?: string }> {
  const dir = s.workspaceDir || ''
  const opts: Array<{ label: string; key: string; title?: string }> = []
  if (!s.archived) {
    opts.push({ label: dir ? `${t('nav.pickWorkspace')}：${displayPath(dir)}` : t('nav.pickWorkspace'), key: 'workspace', title: dir || undefined })
    opts.push({ label: t('nav.archiveSession'), key: 'archive' })
  } else {
    opts.push({ label: t('nav.restoreSession'), key: 'restore' })
  }
  opts.push({ label: t('common.delete'), key: 'delete' })
  return opts
}

/** 菜单选择 */
function onSessionMenu(key: string, sessionId: string) {
  if (key === 'workspace') {
    wsPickerSessionId.value = sessionId
  } else if (key === 'archive') {
    chatStore.archiveSession(sessionId, true)
  } else if (key === 'restore') {
    chatStore.archiveSession(sessionId, false)
  } else if (key === 'delete') {
    delSession(sessionId)
  }
}

/** 目录选择完成 → 绑定为会话工作目录 */
async function onPickWorkspace(path: string) {
  const sid = wsPickerSessionId.value
  if (!sid) return
  await chatStore.setSessionWorkspace(sid, path)
  nMessage.success(`${t('nav.workspaceSaved')}: ${path}`)
}

/** 跳转设置页（可带 tab 参数，如 account） */
function openSettings(tab?: string) {
  router.push({ name: 'Settings', query: tab ? { tab } : undefined })
}
/** 个人资料：设置页账户 Tab */
function openProfile() { openSettings('account') }

onMounted(() => {
  appStore.loadSettings()
  chatStore.loadSessions()
})
</script>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-primary);
  color: var(--text-primary);
}
.app-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* ===== Sidebar（宽度用 CSS 变量，支持拖拽调整 + 横栏标题联动） ===== */
.sidebar {
  width: var(--sidebar-w, 220px);
  min-width: var(--sidebar-w, 220px);
  flex-shrink: 0;
  background: var(--bg-sidebar);
  display: flex;
  flex-direction: column;
  /* 400ms：伸缩过程人眼可感知（200ms + ease-out 前段过陡，收起时旋转被布局变化淹没） */
  transition: width 0.4s var(--ease-out),
              min-width 0.4s var(--ease-out);
  position: relative;
}

.sidebar.collapsed {
  width: 48px;
  min-width: 48px;
}

/* 红绿灯悬浮区（Electron App 沉浸式）：独立横条横跨全窗口（对齐 WorkBuddy main-header）。
   三段布局：①红绿灯悬浮在左上角(x=21~71) ②侧边栏上方留白(hover 滑出热区) ③工作区段(标题+模型)。
   整行可拖拽；交互元素 no-drag */
.traffic-spacer {
  position: relative;
  display: flex;
  align-items: center;
  height: 56px;
  min-height: 56px;
  padding: 0 12px 0 87px; /* 左侧 87px 红绿灯让位（对齐 WorkBuddy） */
  flex-shrink: 0;
  -webkit-app-region: drag; /* 整行可拖拽窗口 */
  user-select: none;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border-color);
  overflow: hidden;
}
/* 横栏收缩侧边栏按钮：驻留在红绿灯右侧（始终可见，不随 sidebar 宽度变化） */


/* 侧边栏上方区：红绿灯右侧到 sidebar 右缘之间留白（宽度随侧边栏；收起态宽度为负被裁，不影响按钮） */
.traffic-sidebar-zone {
  position: absolute;
  left: 87px;
  top: 0;
  bottom: 0;
  width: calc(var(--sidebar-w, 220px) - 87px);
  -webkit-app-region: no-drag;
  cursor: default;
}
/* 工作区段：会话标题 + 模型徽标（从侧边栏右缘 + 12px 间距开始，随侧边栏宽度联动） */
.traffic-workspace-zone {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: calc(var(--sidebar-w, 220px) + 12px - 80px); /* 贴分隔线但留间距（标题左移 80px） */
  min-width: 0;
  flex: 1;
  -webkit-app-region: no-drag;
  pointer-events: none;
}
/* 收起态：侧边栏窄栏(48px)后标题右移 40px，避开红绿灯/窗口按钮 */
.traffic-workspace-zone.collapsed {
  margin-left: calc(var(--sidebar-w, 220px) + 12px - 80px + 40px);
}
.traffic-session-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

.traffic-title-wrap {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  -webkit-app-region: no-drag;
  pointer-events: auto;
}
.traffic-title-wrap .traffic-session-title {
  max-width: 280px;
}
.traffic-rename-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  flex-shrink: 0;
  transition: opacity var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}
.traffic-title-wrap:hover .traffic-rename-btn { opacity: 1; }
.traffic-rename-btn:hover { color: var(--accent); background: var(--bg-hover); }
.traffic-title-edit {
  display: inline-flex;
  align-items: center;
  -webkit-app-region: no-drag;
  pointer-events: auto;
}
.traffic-title-input {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--accent);
  border-radius: 6px;
  padding: 2px 8px;
  outline: none;
  width: 260px;
  max-width: 40vw;
}
.traffic-model-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 500;
  color: var(--accent);
  background: var(--accent-muted);
  border-radius: 4px;
  padding: 2px 7px;
}
.traffic-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  -webkit-app-region: no-drag;
  flex-shrink: 0;
}
/* 横栏功能按钮（产物/搜索/Agent 模式）：低调图标按钮，hover 显底色，active 高亮 */
.traffic-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  -webkit-app-region: no-drag;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.traffic-action-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.traffic-action-btn.active {
  color: var(--accent);
  background: var(--accent-muted, color-mix(in srgb, var(--accent) 12%, transparent));
}

/* 分隔条（sash）：贴在侧边栏右缘的视觉细线，单击切换展开/收起（按钮式，无拖拽）。
   视觉线用 right 定位贴 sidebar 右缘：展开/收起两种状态下都对齐侧边栏边界线 */
.sidebar-sash {
  position: relative;
  width: 8px;
  margin-left: -8px; /* 覆盖到侧边栏右缘上方，实际命中区 8px */
  flex-shrink: 0;
  cursor: pointer;
  z-index: 20;
  -webkit-app-region: no-drag;
}
/* 收起态（48px LOGO 列）：sash 命中区太窄（40~48px），加宽到 12px 便于点击（视觉线仍贴右缘） */
.sidebar.collapsed + .sidebar-sash {
  width: 12px;
  margin-left: -12px;
}
.sidebar-sash::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  right: 1px; /* 贴 sash 右缘 = 侧边栏右缘，两种状态对齐 */
  width: 2px;
  background: transparent;
  transition: background var(--duration-fast) var(--ease-out), width var(--duration-fast) var(--ease-out);
}
.sidebar-sash:hover::after {
  background: var(--accent);
  width: 3px;
}

/* 收起态图标列（桌面端）：48px 窄栏内竖排功能图标；flex:1 吃掉剩余空间，让底部头像贴底 */
.sidebar-icon-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  flex: 1;
  min-height: 0;
}
.rail-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
  text-decoration: none;
}
.rail-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.rail-btn.active { background: var(--bg-active); color: var(--accent); }

.sidebar-header {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;
  min-height: 56px;
  box-sizing: border-box;
  padding: 0 14px;
  cursor: pointer;
}
/* 收起态：LOGO 圆标居中 */
.sidebar.collapsed .sidebar-header {
  padding: 0;
  justify-content: center;
  gap: 0;
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
  cursor: pointer;
  /* 旋转过渡与侧边栏宽度过渡同步（400ms + 同一缓动曲线）→ 旋转进度对齐伸缩进度 */
  transition: transform 0.4s var(--ease-out);
}

.logo-text {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  font-family: 'Saira Stencil One', sans-serif;
  letter-spacing: 1px;
}

/* 品牌行：SUPERCRZY + BOT 徽章 垂直居中 */
.logo-brand {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  line-height: 1.4;
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

/* 2026-08-29 超级协作平台：置顶主入口高亮（取代幽灵工作台） */
.nav-item.collab-nav {
  color: #534AB7;
  background: #f5f3ff;
  margin-bottom: 2px;
}
.nav-item.collab-nav.active {
  background: #eeedfe;
  color: #3c3489;
  font-weight: 500;
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
  min-height: 0;  /* flexbox 滚动关键：禁止被内容撑高，超出才滚动 */
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 6px;
  scrollbar-width: thin;
  scrollbar-color: var(--border-color-strong, var(--text-muted)) transparent;
}
.chats-list::-webkit-scrollbar {
  width: 6px;
}
.chats-list::-webkit-scrollbar-thumb {
  background: var(--border-color-strong, var(--text-muted));
  border-radius: 3px;
  opacity: 0.6;
}
.chats-list::-webkit-scrollbar-thumb:hover {
  opacity: 1;
}
.chats-list::-webkit-scrollbar-track {
  background: transparent;
}

/* 空间分组（按工作区目录归类会话） */
.chat-group { margin-bottom: 2px; }
.chat-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px 3px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  user-select: none;
  color: var(--text-secondary);
}
.chat-group-header:hover { background: var(--bg-hover); }
.chat-group-caret {
  color: var(--text-tertiary);
  transition: transform var(--duration-fast) var(--ease-out);
  flex-shrink: 0;
}
.chat-group-caret.rotated { transform: rotate(90deg); }
.chat-group-icon { color: var(--text-tertiary); flex-shrink: 0; }
.chat-group-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.chat-group-count {
  font-size: 10px;
  color: var(--text-tertiary);
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 0 5px;
  line-height: 14px;
}
.chat-group-items { padding-left: 6px; }

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

/* ===== Sidebar Footer (展开态单行: 用户 + 主题 + 设置；收起态仅头像) ===== */
.sidebar-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
}
/* 收起态：仅头像，水平居中（点击进设置完整界面） */
.sidebar-footer.collapsed {
  justify-content: center;
  padding: 10px 0;
}

.footer-user {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex: 1;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  color: var(--text-primary);
}
.footer-user:hover .footer-value { color: var(--accent); }

/* 收起态头像按钮：覆盖 .footer-user 的 flex:1，内容居中（必须定义在 .footer-user 之后，同优先级后者胜） */
.sidebar-footer.collapsed .collapsed-user {
  flex: none;
  justify-content: center;
  padding: 0;
}

.footer-avatar-wrap {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}

/* 连接状态：头像右下角小绿点（描边用侧边栏背景色，收起态也一致） */
.footer-avatar-wrap .conn-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success);
  border: 2px solid var(--bg-sidebar);
}

.footer-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-weight: 500;
  font-size: 12px;
  transition: color .15s;
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.theme-toggle,
.settings-btn {
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

.theme-toggle:hover,
.settings-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* ===== Main Content ===== */
.main-content {
  flex: 1;
  min-width: 0;
  min-height: 0; /* flex 列容器必须：防止视图内容把 app-body 撑高，子元素 100% 高度才正确 */
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

  /* 移动端操作组（合并 ChatView header 后承载：产物/搜索/分享/详情） */
  .mobile-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }
  .mobile-action-btn {
    display: flex; align-items: center; justify-content: center;
    width: 30px; height: 30px;
    border: none; background: none;
    color: var(--text-secondary);
    cursor: pointer; padding: 0;
    border-radius: 6px;
  }
  .mobile-action-btn:active { background: var(--bg-hover, rgba(255,255,255,.06)); }
  .mobile-action-btn.active { color: var(--accent); }

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

<!-- 会话三点菜单弹出层定制（naive dropdown teleport 到 body，class 落在 .n-dropdown-menu 自身，须非 scoped） -->
<style>
.session-menu-pop.n-dropdown-menu {
  border-radius: 12px;
  min-width: 168px;
  max-width: 300px;
  padding: 6px;
  overflow: hidden;
}
.session-menu-pop.n-dropdown-menu .n-dropdown-option {
  border-radius: 8px;
  font-size: 12.5px;
}
.session-menu-pop.n-dropdown-menu .n-dropdown-option-body__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
