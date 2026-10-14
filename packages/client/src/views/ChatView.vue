<template>
  <div class="chat-container">
    <!-- Top bar（桌面 Electron 隐藏：标题/模型已融合进顶部横栏；移动端隐藏：由 MainLayout mobile-topbar 承担，避免双标题栏） -->
    <header v-if="!isDesktop && !isMobile" class="chat-header">
      <div class="chat-title-area">
        <h2 class="chat-title">{{ currentSession?.title || $t('nav.newTask') }}</h2>
        <!-- 上下文用量圆环（老板定：放回标题旁边） -->
        <ContextUsageRing />
        <!-- 任务进度胶囊（环形进度右侧；App 端在顶部横栏同位置） -->
        <PlanCapsule />
      </div>
      <div class="header-actions">
        <!-- 会话产物：点文件夹图标查看本会话 AI 生成的所有文件 -->
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-button size="small" quaternary class="header-artifacts-btn" @click="artifactsPopoverOpen = !artifactsPopoverOpen">
              <template #icon>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              </template>
              <span v-if="sessionArtifacts.length > 0" class="artifact-count">{{ sessionArtifacts.length }}</span>
            </n-button>
          </template>
          {{ $t('chat.artifactsTitle') }}
        </n-tooltip>
        <!-- 搜索历史消息放大镜 -->
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-button size="small" quaternary class="search-mag-btn" @click="openSearch">
              <template #icon>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
              </template>
            </n-button>
          </template>
          {{ $t('chat.searchMessages') }}
        </n-tooltip>
        <!-- 对话分享（Web 端入口；App 端在顶部横栏，菜单 fixed 定位通用） -->
        <n-tooltip v-if="messages.length > 0" trigger="hover">
          <template #trigger>
            <n-button size="small" quaternary class="share-btn" @click="shareMenuOpen = !shareMenuOpen">
              <template #icon>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              </template>
            </n-button>
          </template>
          {{ $t('chat.share') }}
        </n-tooltip>
        <!-- 右侧面板开关（会话级：产物/文件/变更/预览/时间线/幽灵；放分享后，与侧边栏个人区分开） -->
        <n-tooltip v-if="messages.length > 0" trigger="hover">
          <template #trigger>
            <n-button
              size="small"
              quaternary
              class="header-panel-btn"
              :class="{ active: appStore.detailPanelVisible }"
              @click="appStore.toggleDetailPanel()"
            >
              <template #icon>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
              </template>
            </n-button>
          </template>
          {{ $t('nav.detailPanel') }}
        </n-tooltip>
        <!-- 顶部"新建对话"仅移动端保留：电脑端与侧边栏"新建任务"重复 -->
        <n-button v-if="isMobile" size="small" quaternary @click="handleNewChat">
          <template #icon>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          {{ $t('nav.newTask') }}
        </n-button>
      </div>
    </header>



    <!-- 分享菜单（fixed 定位右上角，Web header / App 横栏共用；Teleport 避免被滚动容器裁剪） -->
    <Teleport to="body">
      <div v-if="shareMenuOpen" class="share-overlay" @click.self="shareMenuOpen = false">
        <div class="share-menu">
          <button class="share-item" @click="copyConversationMarkdown">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            {{ $t('chat.shareCopyMd') }}
          </button>
          <button class="share-item" @click="downloadConversationMarkdown">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            {{ $t('chat.shareDownloadMd') }}
          </button>
          <button class="share-item" @click="generateShareImage">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            {{ $t('chat.shareImage') }}
          </button>
        </div>
      </div>
    </Teleport>

    <!-- 产物弹层（右上角文件夹按钮展开） -->
    <div v-if="artifactsPopoverOpen" class="artifacts-overlay" @click.self="artifactsPopoverOpen = false">
      <div class="artifacts-pop">
        <div class="ap-pop-head">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          {{ $t('chat.artifactsTitle') }} ({{ sessionArtifacts.length }})
        </div>
        <div class="sa-list ap-pop-list">
          <div v-for="a in sessionArtifacts" :key="a.id" class="sa-item" :title="a.path">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="sa-file-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="sa-name" @click="previewArtifactFile(a)">{{ a.name }}</span>
            <span class="sa-badge" :class="a.action">{{ a.action === 'created' ? $t('chat.artifactCreated') : $t('chat.artifactUpdated') }}</span>
            <span class="sa-size">{{ formatArtifactSize(a.size) }}</span>
            <span class="sa-time">{{ formatArtifactTime(a.created_at) }}</span>
            <button class="sa-open" :title="$t('chat.artifactOpen')" @click="openArtifactFile(a)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </button>
            <button class="sa-open" :title="$t('chat.artifactReveal')" @click="openArtifactFolder(a)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            </button>
          </div>
          <div v-if="sessionArtifacts.length === 0" class="ap-pop-empty">{{ $t('chat.artifactsEmpty') }}</div>
        </div>
      </div>
    </div>

    <!-- Messages -->
    <div class="messages-area" ref="messagesRef" @scroll="onScroll" @click="closeMsgMenu">
      <!-- 错误横幅（对齐 WorkBuddy ErrorBanner：任务出错浮顶部，可复制错误报告/重试，替代一闪而过的小弹条） -->
      <ErrorBanner
        v-if="errorBanner"
        :title="errorBanner.title"
        :message="errorBanner.message"
        :details="errorBanner.details"
        :can-retry="errorBanner.canRetry"
        @dismiss="dismissErrorBanner"
        @retry="retryErrorBanner"
      />
      <!-- 快速回底按钮：内容可滚动时常驻右下角（固定位置），贴底弱化、离开底部高亮 -->
      <!-- Welcome -->
      <div v-if="messages.length === 0" class="welcome-area">
        <img src="/logo.png" alt="SUPERCRZY" class="welcome-logo" />
        <h1 class="welcome-title">
          <span class="welcome-brand">
            {{ $t('chat.welcomePrefix') }}
            <span class="brand-name">SUPERCRZY</span>
            <span class="bot-badge">BOT</span>
          </span>
        </h1>
        <p class="welcome-subtitle">{{ $t('chat.welcomeDesc') }}</p>
        <div v-if="!appStore.hasApiKey && !keyGuideDismissed" class="welcome-key-hint">
          <button class="key-guide-close" @click="keyGuideDismissed = true" :title="$t('chat.apiKeyDismiss')">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <div class="key-guide-title">{{ $t('chat.apiKeyGuideTitle') }}</div>
          <div class="key-guide-steps">
            <div class="key-guide-step"><span class="kg-n">1</span>{{ $t('chat.apiKeyStep1') }}</div>
            <div class="key-guide-step"><span class="kg-n">2</span>{{ $t('chat.apiKeyStep2') }}</div>
            <div class="key-guide-step"><span class="kg-n">3</span>{{ $t('chat.apiKeyStep3') }}</div>
          </div>
          <router-link to="/models" class="key-guide-btn">{{ $t('chat.apiKeyHintAction') }}</router-link>
        </div>

        <!-- 中央大输入框（欢迎页） -->
        <div class="welcome-composer">
          <div class="wc-row">
            <!-- ➕ 添加菜单 -->
            <div class="wc-plus-wrap">
              <button class="wc-plus" :class="{ open: welcomePlusOpen }" @click="welcomePlusOpen = !welcomePlusOpen" :title="$t('chat.wcAdd')">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <div v-if="welcomePlusOpen" class="wc-popover">
                <div class="wc-pop-item" @click="pickFile">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  {{ $t('chat.wcAddFile') }}
                </div>
                <div class="wc-pop-item" @click="pickImage">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  {{ $t('chat.wcAddImage') }}
                </div>
                <div class="wc-pop-item" @click="openSkillPicker">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                  {{ $t('chat.wcAddSkill') }}
                </div>
              </div>
            </div>

            <!-- 大输入框 -->
            <div class="wc-input-box">
              <textarea
                v-model="inputText"
                class="wc-input"
                :placeholder="$t('chat.wcPlaceholder')"
                @keydown.enter.exact.prevent="handleSend"
                                ref="welcomeInputRef"
              ></textarea>
              <!-- 右侧：模型 / 语音 / 发送 -->
              <div class="wc-actions">
                <select
                  class="input-model-select wc-model"
                  :value="appStore.currentModel"
                  @change="appStore.setModel(($event.target as HTMLSelectElement).value)"
                  :title="$t('models.currentModel')"
                >
                  <template v-for="opt in appStore.modelSelectOptions" :key="optKey(opt)">
                    <optgroup v-if="isGroup(opt)" :label="opt.label">
                      <option v-for="child in optChildren(opt)" :key="child.value" :value="child.value">{{ child.label }}</option>
                    </optgroup>
                    <option v-else :value="optValue(opt)">{{ opt.label }}</option>
                  </template>
                </select>
                <button class="wc-icon-btn" :class="{ listening: isListening }" :title="isListening ? $t('chat.wcVoiceStop') : $t('chat.wcVoice')" @click="toggleVoice">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>
                </button>
                <button class="wc-send" :disabled="!canSend" :title="appStore.hasApiKey ? $t('chat.send') : $t('chat.sendConfigFirst')" @click="handleSend">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                </button>
              </div>
            </div>
          </div>

          <!-- 已选技能 / 附件 chips -->
          <div v-if="welcomeSkills.length > 0 || uploadedFiles.length > 0" class="wc-chips">
            <span v-for="s in welcomeSkills" :key="s.name" class="wc-chip">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              {{ s.displayName }}
              <button class="wc-chip-x" @click="removeSkill(s.name)">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </span>
            <span v-for="f in uploadedFiles" :key="f.id" class="wc-chip">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              {{ f.name }}
            </span>
          </div>

          <!-- 任务设置（折叠：默认收起，点击展开工作文件夹 + 权限——减少首屏密度） -->
          <div class="wc-settings">
            <button class="wc-settings-toggle" @click="welcomeSettingsOpen = !welcomeSettingsOpen">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              <span class="wc-settings-label">{{ $t('chat.wcSettings') }}</span>
              <span class="wc-settings-summary">{{ currentWorkspaceDir || $t('chat.wcWorkspaceNone') }} · {{ permShortLabel }}</span>
              <svg class="wc-settings-arrow" :class="{ open: welcomeSettingsOpen }" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <div v-show="welcomeSettingsOpen" class="wc-config-row">
            <button class="wc-config" @click="openFsPicker" :class="{ set: currentWorkspaceDir }">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span class="wc-config-label">{{ $t('chat.wcWorkspace') }}：</span>
              <span class="wc-config-val">{{ currentWorkspaceDir || $t('chat.wcWorkspaceNone') }}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <div class="wc-perm">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <span class="wc-config-label">{{ $t('chat.wcPermission') }}：</span>
              <select v-model="welcomePerm" class="wc-perm-select" @change="applyWelcomePerm">
                <option value="workspace-only">{{ $t('chat.permWorkspaceOnly') }}</option>
                <option value="sandbox">{{ $t('chat.permSandbox') }}</option>
                <option value="full">{{ $t('chat.permFull') }}</option>
              </select>
            </div>
          </div>
          </div>

          <!-- 技能选择面板 -->
          <div v-if="skillPickerOpen" class="wc-skill-panel">
            <div class="wc-skill-head">{{ $t('chat.wcSkillPickerTitle') }}</div>
            <div class="wc-skill-grid">
              <div
                v-for="sk in skillList"
                :key="sk.id"
                class="wc-skill-item"
                :class="{ picked: welcomeSkills.some((s) => s.name === sk.name) }"
                @click="toggleSkill(sk)"
              >
                <span class="wc-skill-name">{{ l10n(sk.name, sk.name_en) }}</span>
                <span class="wc-skill-desc">{{ l10n(sk.description, sk.description_en) }}</span>
              </div>
              <div v-if="skillList.length === 0" class="wc-skill-empty">{{ $t('chat.wcSkillEmpty') }}</div>
            </div>
          </div>
        </div>

        <!-- 首用引导：任务模板（阶段三-③④；点一下填进输入框，不直接发送） -->
        <WelcomeTemplates @pick="onTemplatePick" />
      </div>

      <!-- 文件夹选择弹窗：浏览 + 搜索（公共组件；欢迎页"工作文件夹"入口使用） -->
      <WorkspacePickerModal
        :show="fsPickerOpen"
        :initial-path="currentWorkspaceDir || ''"
        @select="selectWorkspace"
        @close="fsPickerOpen = false"
      />

      <!-- 产物预览弹窗 -->
      <div v-if="previewArtifact" class="fs-overlay" @click.self="previewArtifact = null">
        <div class="fs-modal ap-modal">
          <div class="fs-head">
            <span class="ap-name">{{ previewArtifact.name }}</span>
            <button class="fs-close" @click="previewArtifact = null">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <p class="ap-path">{{ previewArtifact.path }}</p>
          <div v-if="previewFail" class="ap-fail">{{ $t('chat.artifactPreviewFail') }}</div>
          <pre v-else class="ap-content">{{ previewArtifact.content }}</pre>
        </div>
      </div>

      <!-- Messages（尾部优先渐进渲染：首屏最近 RENDER_CHUNK 条，向上滚动加载更早——长会话不全量进 DOM） -->
      <div
        v-for="(msg, msgIdx) in visibleMessages"
        :key="msg.id"
        class="message-wrapper"
        :data-msg-id="msg.id"
        :class="{ compact: appStore.compactMode }"
      >
        <!-- 按天分隔线（2026-08-27 加：跨天消息间插入日期分隔） -->
        <div v-if="showDayDivider(msgIdx)" class="day-divider">
          <span>{{ dayLabel(msgIdx) }}</span>
        </div>
        <div class="message" :class="msg.role">
          <div class="message-header">
            <!-- TurnFoldAvatar（WorkBuddy 同款）：耗时独立显示在头像下方，点击头像切换整轮折叠（耗时已由消息总计时徽标承担，不再重复） -->
            <div class="avatar-wrap">
              <div class="message-avatar" :class="{ 'turn-foldable': msg.role !== 'user' && hasProcess(msg) }" :title="msg.role !== 'user' && hasProcess(msg) ? $t('chat.toggleProcess') : ''" @click="msg.role !== 'user' && hasProcess(msg) && toggleMsgFold(msg)">
                <!-- 2026-08-29 超级协作平台：有 actor 的多 AI 用图标头像，单 AI（无 actor）保留原 logo -->
                <template v-if="msg.role !== 'user' && actorMeta(msg.actor)">
                  <span class="actor-avatar" :style="{ background: actorMeta(msg.actor)!.bg, color: actorMeta(msg.actor)!.color }">{{ actorMeta(msg.actor)!.icon }}</span>
                </template>
                <img v-else-if="msg.role !== 'user'" src="/logo.png" alt="SUPERCRZY" class="avatar-logo" />
                <ProfileAvatar v-else :avatar="appStore.userAvatar" :name="appStore.userName || 'U'" :size="28" :radius="7" />
              </div>
            </div>
            <div class="message-meta">
              <span class="message-role">{{ messageRoleLabel(msg) }}</span>
              <span class="message-time">{{ formatTime(msg.createdAt, msg.id) }}</span>
            </div>
            <!-- 引用按钮：hover 显示，一键把该消息引用进输入框（AI 优先针对引用回答） -->
            <button
              class="message-quote-btn"
              :title="$t('chat.quoteMessage')"
              @click="quoteMessage(msg)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
            </button>
          </div>
          <div class="message-body">
            <!-- 附件展示（attachmentList 兼容 flow 持久化后的多种 attachments 形态） -->
            <div v-if="attachmentList(msg).length > 0" class="message-attachments">
              <div
                v-for="att in attachmentList(msg)"
                :key="att.id"
                class="attachment-card"
                @click="openAttachment(att)"
              >
                <div class="attachment-preview">
                  <img
                    v-if="isImageType(att.type)"
                    :src="att.url"
                    :alt="att.name"
                    class="attachment-image"
                  />
                  <div v-else class="attachment-file-icon">
                    <svg v-if="isPdfType(att.type)" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <svg v-else-if="isSheetType(att.type)" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
                    <svg v-else-if="isDocType(att.type)" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                    <svg v-else width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  </div>
                </div>
                <div class="attachment-info">
                  <span class="attachment-name">{{ att.name }}</span>
                  <span class="attachment-size">{{ formatFileSize(att.size) }}</span>
                  <span v-if="att.ocrTexts && att.ocrTexts.length" class="ocr-badge" :title="att.ocrTexts.join('\n')">{{ $t('chat.ocrRecognized', { n: att.ocrTexts.length }) }}</span>
                </div>
              </div>
            </div>

            <!-- 消息核心：思考状态 + 时序流（折叠条/块渲染）+ 无流正文 + 重试 + 停止横幅（WorkBuddy 块架构，MessageFlowRenderer） -->
            <MessageFlowRenderer
              :msg="msg"
              :is-loading="chatStore.isLoading"
              :is-last-message="messages[messages.length - 1] === msg"
              :show-reasoning="appStore.showReasoning"
              :permission="chatStore.currentSession?.permissionLevel || 'sandbox'"
              :auto-approve-seconds="appStore.toolAutoApproveSeconds"
              @allow="onToolAllow($event)"
              @deny="onToolDeny($event)"
              @allow-session="onToolAllowSession($event)"
              @continue-from-checkpoint="continueFromCheckpoint($event)"
            />
            <!-- 多模型对比：打字模式（流式中，live 列） / 完成模式（content 是 { results: [...] } JSON） -->
            <CompareResult
              v-if="compareActiveId === msg.id && compareLive.length"
              :data="{ results: [], recommendation: '' }"
              :live="compareLive"
              :live-reco="compareLiveReco"
              :live-finished="compareLiveFinished"
            />
            <CompareResult
              v-else-if="isCompareContent(msg.content)"
              :data="parseCompareContent(msg.content)"
            />
            <!-- 交付摘要：本消息产物卡片行（默认折叠只显示前 3 个 + 展开全部；多个产物不铺开） -->
            <!-- 任务交付页（P1-05）：状态 + 结论 + 产物 + 改动 + 统计 + 下一步。
                 此前只有"产物卡片行"，且仅当产生了文件才出现；现在凡有实际动作的任务都有交付叙事。 -->
            <div v-if="hasDelivery(msg)" class="delivery-summary">
              <!-- ① 状态 + 一句话结论 -->
              <div v-if="msg.deliverySummary?.summary" class="ds-head" :class="deliveryHeadClass(msg)">
                <span class="ds-dot"></span>
                <span class="ds-status">{{ deliveryStatusText(msg) }}</span>
                <span class="ds-summary-text">{{ msg.deliverySummary?.summary }}</span>
              </div>
              <!-- ② 产物卡片 -->
              <template v-if="msg.deliverySummary?.artifacts.length">
              <div class="ds-title" :class="{ 'ds-title-toggle': deliverySummaryArtifacts(msg).length > 3 }" @click="toggleDeliverySummary(msg)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                {{ $t('chat.deliveryTitle') }} ({{ msg.deliverySummary.artifactCount }})
                <svg v-if="deliverySummaryArtifacts(msg).length > 3" class="ds-toggle-arrow" :class="{ open: deliverySummaryExpanded(msg) }" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
              </div>
              <div class="ds-cards">
                <div v-for="(a, i) in deliverySummaryArtifacts(msg)" :key="i" class="ds-card" :title="a.path">
                  <span class="ds-card-icon">
                    <svg v-if="isArtifactImage(a)" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                    <svg v-else-if="isArtifactSheet(a)" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
                    <svg v-else-if="isArtifactDoc(a)" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                  </span>
                  <span class="ds-card-info">
                    <span class="ds-card-name">{{ a.name }}</span>
                    <span class="ds-card-path">{{ a.path }}</span>
                  </span>
                  <button class="ds-card-open" :title="$t('chat.artifactOpen')" @click="openDeliveryArtifact(a)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </button>
                </div>
                <div v-if="deliverySummaryArtifacts(msg).length > 3" class="ds-more" @click="toggleDeliverySummary(msg)">
                  {{ deliverySummaryExpanded(msg) ? $t('chatui.webFetchCollapse') : $t('chat.deliveryMore', { n: msg.deliverySummary.artifactCount - 3 }) }}
                </div>
              </div>
              </template>
              <!-- ③ 改动清单（最多列 5 个 + 余量计数） -->
              <div v-if="msg.deliverySummary?.changedFiles?.length" class="ds-changes">
                <span class="ds-changes-label">{{ $t('chat.deliveryChanges', { n: msg.deliverySummary?.changedCount || msg.deliverySummary?.changedFiles?.length }) }}</span>
                <span v-for="(c, i) in (msg.deliverySummary?.changedFiles || []).slice(0, 5)" :key="i" class="ds-change" :title="c.path">{{ c.name }}</span>
                <span v-if="(msg.deliverySummary?.changedFiles?.length || 0) > 5" class="ds-change-more">+{{ (msg.deliverySummary?.changedFiles?.length || 0) - 5 }}</span>
              </div>
              <!-- ④ 统计（轮次 / 工具 / 耗时 / token / 成本） -->
              <div class="ds-stats">
                <span>{{ $t('chat.deliveryTurns', { n: msg.deliverySummary?.turns }) }}</span>
                <span>{{ $t('chat.deliveryTools', { n: msg.deliverySummary?.toolCallCount }) }}</span>
                <span v-if="msg.deliverySummary?.durationMs">{{ fmtDeliveryDuration(msg.deliverySummary?.durationMs || 0) }}</span>
                <span v-if="msg.deliverySummary?.totalTokens">{{ $t('chat.deliveryTokens', { n: msg.deliverySummary?.totalTokens }) }}</span>
                <span v-if="msg.deliverySummary?.cost">{{ fmtDeliveryCost(msg.deliverySummary?.cost) }}</span>
              </div>
              <!-- ⑤ 下一步：未完成时给出可继续的检查点 -->
              <div v-if="msg.deliverySummary?.canResume && msg.deliverySummary?.checkpointId" class="ds-next">
                {{ $t('chat.deliveryResume') }}
                <code class="ds-ckpt">{{ msg.deliverySummary?.checkpointId }}</code>
              </div>
            </div>

            <!-- AI 画图（P0）：draw_diagram 生成的矢量图，白底卡片内联渲染（flow 内联图除外——那部分在 MessageFlowRenderer 按位置渲染） -->
            <div v-if="msg.diagrams && msg.diagrams.length && msg.diagrams.some((d) => !flowDiagramSet(msg).has(d.svg))" class="diagram-list">
              <div
                v-for="(d, di) in msg.diagrams.filter((dd) => !flowDiagramSet(msg).has(dd.svg))"
                :key="di"
                class="diagram-card"
                :title="$t('chat.viewDiagram')"
                @click="openDiagram(d)"
              >
                <div class="diagram-title">
                  <span class="dt-name">{{ d.title }}</span>
                  <span class="dt-zoom">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35M11 8v6M8 11h6"/></svg>
                  </span>
                </div>
                <div class="diagram-body" v-html="sanitizeSvg(d.svg)"></div>
              </div>
            </div>

            <!-- Routine 推荐（学 Grok"演示一次就学会"）：复杂任务完成后 AI 主动建议保存为流程 -->
            <div v-if="msg.routineSuggestion" class="routine-suggest">
              <div class="rs-info">
                <span class="rs-title">可保存为可复用流程</span>
                <span class="rs-desc">「{{ msg.routineSuggestion.title }}」用了 {{ msg.routineSuggestion.toolCount }} 次工具调用（{{ msg.routineSuggestion.turnCount }} 轮）</span>
              </div>
              <div class="rs-actions">
                <n-button size="tiny" type="primary" :loading="savingRoutine" @click="saveRoutineSuggestion(msg)">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                  保存为例程
                </n-button>
                <n-button size="tiny" quaternary @click="dismissRoutineSuggestion(msg)">忽略</n-button>
              </div>
            </div>

            <!-- 任务总计时：运行中"已用时 Xs"实时增长；done 后"已完成 Xs"。
                 计时器封装在 ElapsedBadge 内部（整秒边界对齐），不再用页面级 nowTs —— 见该组件注释。 -->
            <div v-if="msg.role === 'assistant' && (msg.elapsedMs || (msg.startedAt && chatStore.isLoading))" class="message-tokens">
              <ElapsedBadge
                :started-at="msg.startedAt"
                :elapsed-ms="msg.elapsedMs"
                :running="chatStore.isLoading"
              />
            </div>

            <!-- Token usage（受设置"显示成本"控制） -->
            <div v-if="appStore.showCost && msg.role === 'assistant' && msg.tokenCount" class="message-tokens">
              <span>{{ msg.tokenCount }} tokens</span>
              <span v-if="msg.cost"> · {{ formatCurrency(msg.cost) }}</span>
            </div>

            <!-- Agent 结构化提问已浮层化（QuestionFloating 顶部浮层，WorkBuddy 同款——原内嵌 question-card 移除，避免藏消息里不明显） -->

          </div>

          <!-- 消息操作工具栏：消息完成后显示（流式中不显示；相邻 AI 消息不重复显示） -->
          <div v-if="!chatStore.isLoading && !(msg.role === 'assistant' && nextIsAssistant(msg))" class="message-actions">
            <!-- 复制（用户 + AI 消息都有） -->
            <button class="msg-action" :title="copiedMsgId === msg.id ? $t('chat.copied') : $t('chat.copy')" @click="copyMessage(msg)">
              <svg v-if="copiedMsgId !== msg.id" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
              <span>{{ copiedMsgId === msg.id ? $t('chat.copied') : $t('chat.copy') }}</span>
            </button>
            <!-- 引用（用户 + AI 消息都有，老板要求：消息下方操作条直接可见，不再只在消息头 hover） -->
            <button class="msg-action" :title="$t('chat.quoteMessage')" @click="quoteMessage(msg)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
              <span>{{ $t('chat.quoteMessage') }}</span>
            </button>
            <!-- 用户消息：编辑 + 重发 -->
            <template v-if="msg.role === 'user'">
              <button class="msg-action" :title="$t('chat.edit')" @click="startEditMessage(msg)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                <span>{{ $t('chat.edit') }}</span>
              </button>
              <button class="msg-action" :title="$t('chat.resend')" @click="resendMessage(msg)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                <span>{{ $t('chat.resend') }}</span>
              </button>
            </template>
            <!-- AI 消息：朗读 + 重新生成 + 更多（复制消息/复制请求 ID/删除） -->
            <template v-else>
              <!-- 朗读（2026-09-26）：仅回复完成后可用（流式中内容未定稿）；三态 朗读→暂停→继续
                   2026-09-28 加第四态「正在合成语音」：点下去到出声之间有一段 0.3~3s 的合成窗口，
                   这段时间按钮必须**禁用并改名** —— 否则用户以为没反应去重复点击（旧实现下第二次
                   点击会被判成"暂停"，直接导致永久静音）。 -->
              <button
                v-if="speechSupported && !chatStore.isLoading && msg.content"
                class="msg-action"
                :class="{ active: speakingMsgId === msg.id }"
                :disabled="speakingMsgId === msg.id && speechSynthesizing"
                :title="speakingMsgId === msg.id ? (speechSynthesizing ? $t('chat.speakingSynthesizing') : (speechPaused ? $t('chat.speakResume') : $t('chat.speakPause'))) : $t('chat.speak')"
                @click="toggleSpeak(msg)"
              >
                <!-- 未播放：喇叭 -->
                <svg v-if="speakingMsgId !== msg.id" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
                <!-- 合成中：环形（还没出声，暂停按钮此刻无意义） -->
                <svg v-else-if="speechSynthesizing" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a9 9 0 1 0 9 9"/></svg>
                <!-- 播放中：暂停 -->
                <svg v-else-if="!speechPaused" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                <!-- 已暂停：继续 -->
                <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                <span>{{ speakingMsgId === msg.id ? (speechSynthesizing ? $t('chat.speakingSynthesizing') : (speechPaused ? $t('chat.speakResume') : $t('chat.speakPause'))) : $t('chat.speak') }}</span>
              </button>
              <button class="msg-action" :title="$t('chat.regenerate')" @click="regenerateMessage(msg)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                <span>{{ $t('chat.regenerate') }}</span>
              </button>
              <!-- 更多菜单 -->
              <div class="msg-more-wrap">
                <button class="msg-action" :title="$t('chat.more')" @click.stop="toggleMsgMenu(msg.id)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
                </button>
                <div v-if="openMsgMenuId === msg.id" class="msg-menu" @click.stop>
                  <button class="msg-menu-item" @click="copyMessageRaw(msg)">{{ $t('chat.copyMessage') }}</button>
                  <button class="msg-menu-item" @click="copyRequestId(msg)">{{ $t('chat.copyRequestId') }}</button>
                  <button class="msg-menu-item danger" @click="deleteMessage(msg)">{{ $t('chat.delete') }}</button>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
      <!-- 选中文本引用浮动按钮（选区旁） -->
      <button
        v-if="selQuoteVisible"
        class="sel-quote-btn"
        :style="{ top: selQuotePos.y + 'px', left: selQuotePos.x + 'px' }"
        @click="quoteSelection"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
        <span>{{ $t('chat.quoteSelection') }}</span>
      </button>
      <!-- 快速回底按钮：sticky 悬浮消息区右下角。仅当：非欢迎页 + 内容可滚动 + 未贴底（贴底自动隐藏） -->
      <transition name="scroll-fade">
        <button
          v-show="canScroll && !stickToBottom && messages.length > 0"
          class="scroll-bottom-btn"
          @click.stop="scrollToBottom(true)"
          :title="$t('chat.scrollToBottom')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14" />
            <path d="M19 12l-7 7-7-7" />
          </svg>
        </button>
      </transition>

    </div>

  <!-- 授权浮层 + 提问浮层（2026-08-27 重构：从 messages-area 内移出 → chat-container 直接子级，
       absolution 在对话工作区内居中（bottom 锚在输入框上方），不再 fixed 全屏居中 -->
  <ToolApprovalFloating
    v-if="pendingApprovalTool"
    :tool="pendingApprovalTool"
    :auto-approve-seconds="appStore.toolAutoApproveSeconds"
    @allow="onToolAllow"
    @deny="onToolDeny"
    @allow-session="onToolAllowSession"
  />
  <QuestionFloating
    v-if="pendingQuestion"
    :question="pendingQuestion"
    @answer="answerQuestionFromFloating"
    @skip="skipQuestion"
  />

    <!-- 历史提问导航条（DeepSeek 式：对话区右侧固定一列点）——
         必须放在 messages-area（滚动容器）外面：absolute 定位在 chat-container（position:relative 且不滚动）上，
         消息滚动时点列保持固定在视口侧边；放滚动容器内会跟着内容一起滚 -->
    <QuestionNavRail
      v-if="messages.length > 0"
      :active-index="activeQuestionIndex"
    />

    <!-- Input area（欢迎页时隐藏，中央输入框替代；保留 DOM 供文件选择器使用） -->
    <footer class="input-area" v-show="messages.length > 0">
      <!-- 输入横幅（对齐 WorkBuddy cb-input-banner：未配置模型时输入框上方提示 + 跳转配置，替代仅按钮 title 提示） -->
      <InputBanner
        v-if="showNoKeyBanner"
        :message="$t('chat.errorBannerNoKeyDesc')"
        variant="warning"
        :actions="[{ label: $t('chat.errorBannerGoConfig'), variant: 'primary', onClick: () => router.push('/models') }]"
        @dismiss="noKeyBannerDismissed = true"
      />
      <!-- 全局执行状态条已移除（2026-09-26 老板裁决）：真机逐帧审计证实它与消息流内 PSL
           高度重复且滞后一拍（两个不同步的"当前状态"同屏打架，观感臃肿）。
           执行状态统一由两处承载：消息流内 PSL（动作级）+ 顶栏 PlanCapsule（任务级）。
           aiStatus 的赋值链路保留未删（数据流零改动，后续若需恢复渲染有现成数据）。 -->
      <div class="composer-card">
        <!-- 文件预览列表（上传后但发送前） -->
        <div v-if="uploadedFiles.length > 0" class="file-preview-list">
          <div v-for="(file, idx) in uploadedFiles" :key="file.id || idx" class="file-preview-item">
            <div class="file-preview-icon">
              <img v-if="isImageType(file.type)" :src="file.url" class="file-preview-thumb" alt="" />
              <svg v-else-if="isPdfType(file.type)" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <svg v-else-if="isDocType(file.type)" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              <svg v-else-if="isSheetType(file.type)" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
              <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <span class="file-preview-name">{{ file.name }}</span>
            <span class="file-preview-size">{{ formatFileSize(file.size) }}</span>
            <button class="file-preview-remove" @click="removeFile(idx)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        <!-- 输入触发菜单（/ 命令 与 @ 文件/技能/会话 统一选择器） -->
        <div v-if="triggerState && triggerCandidates.length > 0" class="trigger-menu" @mousedown.stop>
          <!-- 候选搜索框（本地过滤；选择技能等入口可直接搜） -->
          <div class="trigger-search-row">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              v-model="triggerSearch"
              class="trigger-search-input"
              :placeholder="$t('chat.trigger.triggerSearch')"
              @keydown.stop="onTriggerKeydown"
              @click.stop
            />
          </div>
          <div class="trigger-list">
            <div v-if="displayedCandidates.length === 0" class="trigger-empty">{{ $t('chat.trigger.triggerEmpty') }}</div>
            <div
              v-for="(c, ci) in displayedCandidates"
              :key="c.key"
              class="trigger-item"
              :class="{ active: ci === triggerSel }"
              @mouseenter="triggerSel = ci"
              @click="applyTrigger(c)"
            >
              <span class="trigger-label">{{ c.label }}</span>
              <span class="trigger-desc" v-if="c.desc">{{ c.desc }}</span>
              <span class="trigger-section">{{ c.section }}</span>
            </div>
          </div>
        </div>

        <!-- 引用对话产物选择面板（➕菜单直接弹出；只选本会话产物，不走 @） -->
        <div v-if="artifactPickerOpen" class="trigger-menu artifact-picker" @mousedown.stop>
          <div class="artifact-picker-head">
            <span>{{ $t('chat.artifactPickerTitle') }}</span>
            <button class="artifact-picker-close" @click="artifactPickerOpen = false">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="trigger-list">
            <div v-if="sessionArtifacts.length === 0" class="trigger-empty">{{ $t('chat.artifactPickerEmpty') }}</div>
            <div
              v-for="a in sessionArtifacts"
              :key="a.id"
              class="trigger-item"
              @click="selectArtifact(a)"
            >
              <span class="trigger-label">{{ a.name }}</span>
              <span class="trigger-desc">{{ a.path }}</span>
              <span class="trigger-section">{{ a.action === 'created' ? $t('chat.artifactCreated') : $t('chat.artifactUpdated') }}</span>
            </div>
          </div>
        </div>

        <!-- 待发送队列（AI 回复中发送的内容先排队，回复完成后自动发布） -->
        <div v-if="pendingQueue.length > 0" class="pending-queue">          <div class="pending-queue-head">
            <span class="pending-queue-title">{{ $t('chat.pendingQueueTitle') }} ({{ pendingQueue.length }})</span>
            <span class="pending-queue-hint">{{ $t('chat.pendingQueueHint') }}</span>
          </div>
          <div v-for="q in pendingQueue" :key="q.id" class="pending-queue-item">
            <span class="pending-queue-text">{{ q.text }}</span>
            <button class="queue-action" @click="editQueued(q.id)" :title="$t('chat.editQueued')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
            </button>
            <button class="queue-action queue-delete" @click="deleteQueued(q.id)" :title="$t('common.delete')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>

        <!-- 朗读浮条（2026-09-27）：自动/手动朗读时在输入框上方现身（要一眼看到"还在念"+能一键停，所以必须比消息操作栏按钮更显眼） -->
        <div v-if="speakingMsgId" class="speak-bar">
          <span class="speak-bar-text">{{ speechSynthesizing ? $t('chat.speakingSynthesizing') : (speechPaused ? $t('chat.speakingPaused') : $t('chat.speaking')) }}</span>
          <span v-if="speechProDegraded" class="speak-bar-hint">{{ $t('chat.speakDegraded') }}</span>
          <span class="speak-bar-spacer"></span>
          <button class="speak-bar-btn" :disabled="speechSynthesizing" @click="toggleSpeech(speakingMsgId, '')">
            {{ speechPaused ? $t('chat.speakResume') : $t('chat.speakPause') }}
          </button>
          <button class="speak-bar-btn speak-bar-stop" @click="stopSpeech()">{{ $t('chat.speakStop') }}</button>
        </div>

        <div class="input-row">
          <!-- 上传/语音已移入底部控制行（v4 输入卡重构：textarea 独占宽度） -->
          <!-- hidden 文件选择器（➕ 菜单"上传图片/文件"触发；重构时随上传按钮移除需补回，否则 ref 悬空无反应）
               上传文件不设 accept = 全类型可传（老板 2026-08-25 放宽） -->
          <input
            type="file"
            multiple
            :disabled="chatStore.isLoading"
            @change="handleFileSelect"
            hidden
            ref="fileInputRef"
          />
          <input
            type="file"
            multiple
            accept="image/*"
            :disabled="chatStore.isLoading"
            @change="handleFileSelect"
            hidden
            ref="imageInputRef"
          />

          <n-input
            v-model:value="inputText"
            type="textarea"
            :placeholder="$t('chat.inputPlaceholderFull')"
            :autosize="inputHeight > 0 ? false : { minRows: 1, maxRows: 6 }"
            :rows="inputHeight > 0 ? undefined : 1"
            :disabled="chatStore.isLoading && !appStore.busyInputMode"
            @input="onInputTrigger"
            @keydown.enter.exact.prevent="onInputEnter"
            @keydown.up="historyPrev"
            @keydown.down="historyNext"
            @keydown="onTriggerKeydown"
            class="chat-input"
            :class="{ 'chat-input-fixed': inputHeight > 0 }"
            :style="inputHeight > 0 ? { '--chat-input-h': inputHeight + 'px' } : undefined"
            ref="inputRef"
          />
        </div>

        <!-- 引用块（对话内一键引用，v4 重构：移到输入行下方，语义=随消息发送的上下文） -->
        <div v-if="quoteRef" class="quote-block">
          <div class="quote-block-head">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
            <span class="quote-block-label">{{ quoteRef.role === 'user' ? $t('chat.roleUser') : $t('chat.roleAssistant') }} · {{ $t('chat.quoteRef') }}</span>
            <button class="quote-block-remove" @click="quoteRef = null" :title="$t('common.remove')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="quote-block-text">{{ quoteRef.excerpt }}</div>
        </div>

        <div class="input-hint">
          <!-- ＋ 菜单（对齐 WorkBuddy：上传图片/文件、技能、@引用对话文件、模式等收纳进一个菜单） -->
          <n-dropdown
            trigger="click"
            placement="bottom-start"
            :options="plusMenuOptions"
            @select="onPlusMenu"
          >
            <button class="input-plus-btn" :title="$t('chat.plusMenu')">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </n-dropdown>
          <!-- 权限（挨着 ＋，对齐 WorkBuddy） -->
          <span class="input-hint-perm" :title="$t('chat.wcPermission')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="input-hint-icon"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <select
              v-model="welcomePerm"
              class="input-perm-select"
              @change="applyWelcomePerm"
            >
              <option value="workspace-only">{{ $t('chat.permWorkspaceOnly') }}</option>
              <option value="sandbox">{{ $t('chat.permSandbox') }}</option>
              <option value="full">{{ $t('chat.permFull') }}</option>
            </select>
          </span>
          <!-- 间距（权限与模型之间留白） -->
          <span class="input-hint-gap"></span>
          <!-- 模型下拉（对齐 WorkBuddy：模型切换在语音前） -->
          <span class="input-hint-model">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="input-hint-icon"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            <select
              class="input-model-select"
              :value="appStore.currentModel"
              @change="appStore.setModel(($event.target as HTMLSelectElement).value)"
              :title="$t('models.currentModel')"
            >
              <template v-for="opt in appStore.modelSelectOptions" :key="optKey(opt)">
                <optgroup v-if="isGroup(opt)" :label="opt.label">
                  <option v-for="child in optChildren(opt)" :key="child.value" :value="child.value">
                    {{ child.label }}
                  </option>
                </optgroup>
                <option v-else :value="optValue(opt)">{{ opt.label }}</option>
              </template>
            </select>
          </span>
          <span v-if="uploadedFiles.length > 0" class="input-hint-count">{{ $t('chat.fileCount', { n: uploadedFiles.length }) }}</span>
          <span class="input-hint-spacer"></span>
          <!-- 语音输入（对齐 WorkBuddy：语音紧挨发送按钮左侧） -->
          <button class="wc-icon-btn" :class="{ listening: isListening }" :title="isListening ? $t('chat.wcVoiceStop') : $t('chat.wcVoice')" @click="toggleVoice">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>
          </button>
          <!-- 暂停（阶段二-②）：后端在轮次边界停下并保留检查点，随后用"继续"从断点恢复 -->
          <button
            v-if="chatStore.isLoading"
            class="wc-icon-btn pause-btn"
            :class="{ 'is-pausing': isPausing }"
            :disabled="isPausing"
            :title="$t('chat.pause')"
            @click="pauseGeneration"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.4" height="14" rx="1.2"/><rect x="13.6" y="5" width="3.4" height="14" rx="1.2"/></svg>
          </button>
          <!-- 发送/停止一体（对齐 WorkBuddy：发送按钮在控制行最右，语音紧挨其左） -->
          <n-button
            :type="chatStore.isLoading ? 'error' : 'primary'"
            :disabled="!canSend && !chatStore.isLoading"
            @click="chatStore.isLoading ? stopGeneration() : handleSend()"
            class="send-button"
            :class="{ 'is-stop': chatStore.isLoading }"
            :title="chatStore.isLoading ? $t('chat.stop') : (appStore.hasApiKey ? $t('chat.send') : $t('chat.sendConfigFirst'))"
          >
            <svg v-if="!chatStore.isLoading" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
          </n-button>
        </div>
      </div>
      <!-- 输入高度拖拽手柄（对齐 WorkBuddy resize-handle：拖拽调高，localStorage 记忆） -->
      <div class="chat-resize-handle" @mousedown="startHeightResize" :title="$t('chat.resizeInput')"></div>
    </footer>

    <!-- 多模型对比：选择参与对比的模型 -->
    <n-modal v-model:show="comparePickerOpen" preset="card" :title="$t('chat.compareMode')" style="max-width:420px">
      <p class="compare-pick-hint">{{ $t('chat.comparePickHint') }}</p>
      <n-checkbox-group v-model:value="compareModels" class="compare-model-list">
        <label v-for="o in compareModelOptions" :key="o.value" class="compare-model-item">
          <n-checkbox :value="o.value">{{ o.label }}</n-checkbox>
        </label>
      </n-checkbox-group>
      <p v-if="compareModelOptions.length === 0" class="compare-pick-empty">{{ $t('chat.compareNoModels') }}</p>
      <template #action>
        <n-button @click="comparePickerOpen = false">{{ $t('common.cancel') }}</n-button>
        <n-button type="primary" :disabled="compareModelOptions.length === 0" @click="confirmCompare">{{ $t('common.confirm') }}</n-button>
      </template>
    </n-modal>

    <!-- 搜索历史消息弹窗（跨会话全文搜索，放大镜按钮打开） -->
    <n-modal v-model:show="searchOpen" preset="card" :title="$t('chat.searchMessages')" style="max-width:560px">
      <div class="search-modal">
        <n-input
          v-model:value="searchQuery"
          :placeholder="$t('search.searchPlaceholder')"
          clearable
          @keyup.enter="doSearch"
          @update:value="onSearchQueryChange"
        >
          <template #prefix>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
          </template>
        </n-input>
        <!-- 搜索结果列表（跨会话消息全文匹配，含提问与 AI 回复，当前会话高亮，点击进入） -->
        <div class="question-history-list">
          <button
            v-for="r in searchResults"
            :key="r.id"
            class="question-history-item"
            :class="{ active: r.session_id === chatStore.currentSession?.id }"
            @click="openSearchResult(r)"
          >
            <div class="qhi-text">{{ searchContent(r.content) }}</div>
            <div class="qhi-meta">
              <span class="qhi-time">{{ formatTime(r.created_at) }}</span>
              <span class="qhi-session">{{ r.session_title }}</span>
            </div>
          </button>
        </div>
        <div v-if="searchResults.length === 0 && searchSearched" class="search-empty">
          <n-empty :description="$t('search.noResults')" />
        </div>
      </div>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted, h } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useChatStore, isDefaultTitle } from '@/stores/chat'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { usePlanStore } from '@/stores/plan'
import ProfileAvatar from '@/components/ui/ProfileAvatar.vue'
import { getModelShortName } from '@/data/models'
import type { ChatMessage, Attachment, ToolCallEvent, ChatFlowNode } from '@/types'
import { applyToolArgsChunk, applyToolDuration, applyToolOutput, applyToolProgress, applyToolResult, toolStatusLabel, extractToolTarget, nextNodeId } from '@/utils/agent-flow'
import { errMsg } from '@/utils/i18n-error'
import { l10n } from '@/utils/i18n-field'
import { playCompletionTone } from '@/utils/sound'
// P1-04：以下纯逻辑从本文件下沉到 utils（原先堆在 6500 行里且无测试）
import { isImageType, isPdfType, isDocType, isSheetType, formatFileSize, formatArtifactSize } from '@/utils/attachment'
import { hasDelivery, deliveryHeadClass, fmtDeliveryDuration, fmtDeliveryCost } from '@/utils/delivery'
import { textOf, searchContent } from '@/utils/message-text'
import { parseTrigger } from '@/utils/trigger'
import { copyRichText, copyToClipboard, stripMarkdown } from '@/utils/clipboard'
import MarkdownIt from 'markdown-it'
// I3：AI 产出的 SVG 走 v-html 前必须清洗（见 utils/sanitize-svg.ts 的威胁模型）
import { sanitizeSvg } from '@/utils/sanitize-svg'
import { parseDeepLinkFromURL, registerDeepLinkListener } from '@/utils/deeplink'
// P1-04 拆分（2026-09-18）：交付页判定与对话导出下沉为纯模块，组件只留副作用
import {
  isArtifactImage, isArtifactSheet, isArtifactDoc,
  deliverySummaryArtifacts, deliverySummaryExpanded, toggleDeliverySummary,
  deliveryStatusKey, formatArtifactTime as formatArtifactTimeRaw,
} from '@/utils/artifact-kind'
// 分享 / 导出：纯逻辑（布局、Markdown 序列化）在 utils/share-export，副作用收在 useShareExport
// I10 低风险批（2026-09-24）：状态型逻辑下沉为 composable，组件只留接线
import { useInputHistory } from '@/composables/useInputHistory'
import { useInputHeight } from '@/composables/useInputHeight'
import { createChatText, actorMeta } from '@/utils/chat-text'
import { useQuote } from '@/composables/useQuote'
import { useMessageWindow } from '@/composables/useMessageWindow'
import { useCodeBlocks } from '@/composables/useCodeBlocks'
import { useAttachments } from '@/composables/useAttachments'
import { autoExtractDiagrams, flowDiagramSet } from '@/utils/svg-extract'
import { useInputTrigger } from '@/composables/useInputTrigger'
import { useArtifacts, type ArtifactItem } from '@/composables/useArtifacts'
import { useHistorySearch } from '@/composables/useHistorySearch'
import { useShareExport } from '@/composables/useShareExport'
import { useAskQuestion } from '@/composables/useAskQuestion'
import { useChatSpeech } from '@/composables/useChatSpeech'
import { formatTtsRate } from '@/composables/useSpeechPreview'
import { useWelcomePanel } from '@/composables/useWelcomePanel'
import ContextUsageRing from '@/components/chat/ContextUsageRing.vue'
import ElapsedBadge from '@/components/chat/ElapsedBadge.vue'
import PlanCapsule from '@/components/chat/PlanCapsule.vue'
import MessageFlowRenderer from '@/components/chat/MessageFlowRenderer.vue'
import ToolApprovalFloating from '@/components/chat/ToolApprovalFloating.vue'
import QuestionFloating from '@/components/chat/QuestionFloating.vue'
import QuestionNavRail from '@/components/chat/QuestionNavRail.vue'
import ErrorBanner from '@/components/chat/ErrorBanner.vue'
import InputBanner from '@/components/chat/InputBanner.vue'
import WorkspacePickerModal from '@/components/workspace/WorkspacePickerModal.vue'
import WelcomeTemplates from '@/components/chat/WelcomeTemplates.vue'
import CompareResult from '@/components/chat/CompareResult.vue'

const chatStore = useChatStore()
const planStore = usePlanStore()
const appStore = useAppStore()
const router = useRouter()

// ---- 历史消息搜索（右上角放大镜）→ composables/useHistorySearch.ts ----
const {
  searchOpen, searchQuery, searchResults, searchSearched,
  openSearch, onSearchQueryChange, doSearch, openSearchResult,
} = useHistorySearch({
  selectSession: (id: string) => chatStore.selectSession(id),
  afterOpen: () => router.push('/'),
})

// ============ 对话分享 / 导出 → composables/useShareExport.ts ============
const { shareMenuOpen, copyConversationMarkdown, downloadConversationMarkdown, generateShareImage } =
  useShareExport({
    title: () => currentSession.value?.title,
    messages: () => messages.value as any[],
    t: (k: string) => t(k),
    onWarn: (msg: string) => nMessage.warning(msg),
    onInfo: (msg: string) => nMessage.info(msg),
    onError: (msg: string) => nMessage.error(msg),
  })

// ---- 模型选择器选项(与侧边栏同源)----
type ModelSelectOption =
  | { label: string; value: string }
  | { type: 'group'; label: string; key: string; children: Array<{ label: string; value: string }> }
const isGroup = (opt: ModelSelectOption): opt is Extract<ModelSelectOption, { type: 'group' }> => 'type' in opt
const optKey = (opt: ModelSelectOption) => (isGroup(opt) ? opt.key : opt.value)
const optValue = (opt: ModelSelectOption) => (isGroup(opt) ? '' : opt.value)
const optChildren = (opt: ModelSelectOption) => (isGroup(opt) ? opt.children : [])
const nMessage = useMessage()

const { locale, t } = useI18n({ useScope: 'global' })
const inputText = ref('')

// ============ 输入历史 / 输入高度（抽到 composables，见 useInputHistory / useInputHeight）============
const { pushInputHistory, historyPrev, historyNext } = useInputHistory({
  inputText,
  inputRef: () => inputRef.value,
  // 触发菜单激活时 ↑↓ 归候选导航所有
  isTriggerActive: () => !!triggerState.value,
})
const { inputHeight, startHeightResize } = useInputHeight()

/** 全局执行状态条（输入框上方）：AI 当前动作（对齐 WorkBuddy progress.phase 体验） */
const aiStatus = ref<string | null>(null)
/** 状态条目标对象（如"正在获取网页 supercrzy.com"的 URL/路径/命令摘要） */
const aiStatusTarget = ref('')

/** 从工具参数提取状态条目标（URL/文件路径/命令摘要，截断 40 字符） */
/** 桌面 App（Electron）：标题/模型已融合进顶部横栏，chat-header 隐藏；Web 端保留原顶栏 */
const isDesktop = ref(false)
;(() => {
  try { if ((window as any).supercrzyDesktop?.isDesktop) isDesktop.value = true } catch { /* 浏览器 */ }
})()

/** 全局工作区默认值（localStorage；欢迎页无会话时作为会话工作目录兜底） */
const wsCurrent = ref(localStorage.getItem('supercrzy:workspace') || '')
/** 移动端判断（顶部"新建对话"按钮仅移动端显示） */
const isMobile = ref(false)
function checkMobile() { isMobile.value = window.innerWidth <= 768 }
onMounted(() => { checkMobile(); window.addEventListener('resize', checkMobile) })
// 对话内引用：消息区 mouseup 检测选中文本 → 浮动「引用选中」按钮
onMounted(() => window.addEventListener('mouseup', handleQuoteMouseUp))
onMounted(() => document.addEventListener('mousedown', onGlobalMousedown))
onUnmounted(() => document.removeEventListener('mousedown', onGlobalMousedown))
onUnmounted(() => window.removeEventListener('mouseup', handleQuoteMouseUp))
onUnmounted(() => { window.removeEventListener('resize', checkMobile) })
// 卸载清理定时器（流式中切会话/路由跳转时防泄漏：复制提示复位；耗时 tick 已下沉到 ElapsedBadge 自清理）
onUnmounted(() => {
  if (copyResetTimer) { clearTimeout(copyResetTimer); copyResetTimer = null }
})

/** 桌面端横栏按钮 → 本页弹层/搜索（MainLayout 通过 CustomEvent 触发，App 端 header 隐藏后保留入口） */
function onDesktopChatAction(e: Event) {
  const action = (e as CustomEvent).detail as string
  if (action === 'artifacts') artifactsPopoverOpen.value = !artifactsPopoverOpen.value
  else if (action === 'search') openSearch()
  else if (action === 'share') shareMenuOpen.value = !shareMenuOpen.value
}
onMounted(() => window.addEventListener('supercrzy:chat-action', onDesktopChatAction))
onUnmounted(() => window.removeEventListener('supercrzy:chat-action', onDesktopChatAction))

/** 例程执行：RoutinesView 一键重放 → 把例程指令作为消息发送（学 Grok"演示一次就学会"） */
function onExternalSendPrompt(e: Event) {
  const text = (e as CustomEvent).detail as string
  if (!text || chatStore.isLoading) return
  inputText.value = text
  handleSend()
}

// ---- 新闻"深入研究"入口（2026-08-28 加，阶段二）：从 NewsView 带 ?research= 跳到对话，自动预填并发送 deep_research ----
onMounted(() => {
  const research = router.currentRoute.value.query.research
  if (typeof research === 'string' && research.trim() && !chatStore.isLoading) {
    // 确保会话已就绪后再发送（等待首条消息可发送）
    setTimeout(() => {
      if (typeof research === 'string' && research.trim() && !chatStore.isLoading) {
        inputText.value = research.trim()
        handleSend()
        router.replace({ query: {} }) // 清掉 query，避免刷新重复触发
      }
    }, 400)
  }
})
onMounted(() => window.addEventListener('supercrzy:send-prompt', onExternalSendPrompt))
onUnmounted(() => window.removeEventListener('supercrzy:send-prompt', onExternalSendPrompt))

// ---- 回底按钮 canScroll 兜底：内容任何变化（含延迟渲染的 markdown/图片/打字机）都刷新显隐 ----
let canScrollTimer: ReturnType<typeof setTimeout> | null = null
let mutObs: MutationObserver | null = null
function scheduleCanScroll() {
  if (canScrollTimer) clearTimeout(canScrollTimer)
  canScrollTimer = setTimeout(() => {
    canScrollTimer = null
    updateCanScroll()
  }, 250)
}
onMounted(() => {
  const el = messagesRef.value
  if (el && typeof MutationObserver !== 'undefined') {
    mutObs = new MutationObserver(() => scheduleCanScroll())
    mutObs.observe(el, { childList: true, subtree: true, characterData: true })
  }
})
onUnmounted(() => {
  mutObs?.disconnect()
  mutObs = null
  if (canScrollTimer) clearTimeout(canScrollTimer)
})

const messagesRef = ref<HTMLElement>()
const inputRef = ref()
/** 正在编辑的用户消息 id（编辑态下回车提交 → submitEdit） */
const editingMessageId = ref<string | null>(null)
const fileInputRef = ref<HTMLInputElement>()
const abortController = ref<AbortController | null>(null)
/** Agent 模式（默认开）：提升到全局 store，桌面端横栏按钮与 header 同步高亮/切换 */
const agentMode = computed({
  get: () => appStore.agentMode,
  set: (v: boolean) => { appStore.agentMode = v },
})
/** 多模型对比模式：开启后发送消息走 /api/chat/compare，多模型并行回答 + 推荐最佳。
    纯问答模式（不带工具，不执行任何操作），与 Agent 模式互斥 */
const compareMode = ref(false)
/** 对比选中的模型（model id 列表；空 = 全部已配置模型） */
const compareModels = ref<string[]>([])
const comparePickerOpen = ref(false)

// ===== 输入框 ＋菜单（对齐 WorkBuddy：上传图片/文件、技能、@引用对话文件、多模型模式收纳） =====
const plusMenuOptions = computed(() => [
  { label: t('chat.plusUploadImage'), key: 'image', icon: () => h('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, [h('rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }), h('circle', { cx: '8.5', cy: '8.5', r: '1.5' }), h('polyline', { points: '21 15 16 10 5 21' })]) },
  { label: t('chat.plusUploadFile'), key: 'file', icon: () => h('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, [h('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }), h('polyline', { points: '14 2 14 8 20 8' })]) },
  { label: t('chat.plusSkill'), key: 'skill', icon: () => h('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, [h('path', { d: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' })]) },
  { label: t('chat.plusReference'), key: 'reference', icon: () => h('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, [h('circle', { cx: '12', cy: '12', r: '10' }), h('path', { d: 'M12 8v4l3 3' })]) },
  { label: t('chat.plusCompare'), key: 'compare', icon: () => h('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, [h('rect', { x: '3', y: '4', width: '8', height: '16', rx: '1.5' }), h('rect', { x: '13', y: '4', width: '8', height: '16', rx: '1.5' })]) },
])
function onPlusMenu(key: string) {
  if (key === 'image') {
    ;(imageInputRef.value as HTMLInputElement | null)?.click()
  } else if (key === 'file') {
    ;(fileInputRef.value as HTMLInputElement | null)?.click()
  } else if (key === 'skill') {
    // 选择技能：专用模式只弹技能候选（不复用全量 @ 管线）
    injectAtTrigger('skill')
  } else if (key === 'reference') {
    // 引用对话产物：直接弹产物选择面板（不走 @ 管线，避免与手动 @ 混淆）
    openArtifactPicker()
  } else if (key === 'compare') {
    openComparePicker()
  }
}
/** 输入框插入 @ 并触发候选管线（直接改 value 不触发 @input，故由 composable 手动置态 + 拉候选） */
function injectAtTrigger(mode: 'all' | 'skill' | 'reference' = 'all') {
  // 互斥：开触发候选时关闭产物选择面板（两面板同一锚点，避免重叠）
  artifactPickerOpen.value = false
  openTriggerFromMenu(mode)
}

/** 点击面板/候选框外部任意处关闭（两面板共用锚点，互斥逻辑在各自打开函数里） */
function onGlobalMousedown(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t.closest('.trigger-menu') || t.closest('.artifact-picker')) return
  closeTrigger()
  artifactPickerOpen.value = false
}

/** 首次 API key 引导：用户主动关闭后本次会话不再显示 */
const keyGuideDismissed = ref(false)

// ===== 引用对话产物（➕菜单：直接弹产物选择面板，不走 @ 管线；复用已有 sessionArtifacts/loadArtifacts） =====
const artifactPickerOpen = ref(false)

async function openArtifactPicker() {
  // 互斥：开产物面板时关闭触发候选（两面板同一锚点，避免重叠）
  closeTrigger()
  await loadArtifacts()
  artifactPickerOpen.value = true
}

/** 选中产物：输入框插入引用标记（不用 @，避免与手动 @ 混淆） */
function selectArtifact(a: ArtifactItem) {
  const marker = `引用产物:${a.name}（路径:${a.path}）`
  inputText.value = inputText.value ? `${inputText.value} ${marker}` : marker
  artifactPickerOpen.value = false
  nextTick(() => inputRef.value?.focus())
}// 流式对比打字状态：compareActiveId 关联当前生成中的消息；live 列逐模型累积
const compareActiveId = ref('')
const compareLive = ref<Array<{ id: string; label: string; text: string; done: boolean }>>([])
const compareLiveReco = ref('')
const compareLiveFinished = ref(false)
/** 模型选择面板：展平 modelSelectOptions（分组项展开 children）得到可选列表 */
const compareModelOptions = computed(() => {
  const list: Array<{ label: string; value: string }> = []
  for (const opt of appStore.modelSelectOptions) {
    if (isGroup(opt)) {
      for (const child of opt.children) list.push({ label: child.label, value: child.value })
    } else {
      list.push({ label: opt.label, value: opt.value })
    }
  }
  return list
})
/** 打开对比配置面板：默认全选当前已配置模型 */
function openComparePicker() {
  if (compareMode.value) {
    // 已开启 → 直接关闭
    compareMode.value = false
    return
  }
  compareModels.value = compareModelOptions.value.map((o) => o.value)
  comparePickerOpen.value = true
}

/** 从 localStorage 收集所有已配置模型的完整信息（provider 配置权威来源；含 key 的才收） */
function collectProviderConfigs(): Array<{ model: string; label: string; baseUrl: string; apiKey: string }> {
  const out: Array<{ model: string; label: string; baseUrl: string; apiKey: string }> = []
  const LS_PREFIX = 'supercrzy:provider:'
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(LS_PREFIX)) continue
    try {
      const cfg = JSON.parse(localStorage.getItem(key)!)
      const apiKey = cfg.apiKey || ''
      const baseUrl = cfg.baseUrl || ''
      if (!apiKey || !baseUrl) continue
      const list = Array.isArray(cfg.models) && cfg.models.length > 0
        ? cfg.models
        : (cfg.defaultModel ? [cfg.defaultModel] : [])
      for (const m of list) {
        if (!m) continue
        const short = getModelShortName(m)
        out.push({ model: m, label: short !== m ? short : m, baseUrl, apiKey })
      }
    } catch { /* 忽略坏配置 */ }
  }
  return out
}
/** 确认开启对比：最多 5 个并行（独立链路，不影响 Agent 模式） */
function confirmCompare() {
  if (compareModels.value.length === 0) {
    nMessage.warning(t('chat.comparePickOne'))
    return
  }
  if (compareModels.value.length > 5) {
    compareModels.value = compareModels.value.slice(0, 5)
    nMessage.info(t('chat.compareMax5'))
  }
  compareMode.value = true
  comparePickerOpen.value = false
}
/** 对比结果暂存（渲染检测用）：compare 消息的 content 是 JSON 字符串 */
function isCompareContent(content: any): boolean {
  if (typeof content !== 'string' || !content.startsWith('{')) return false
  try {
    const d = JSON.parse(content)
    return Array.isArray(d?.results)
  } catch { return false }
}
function parseCompareContent(content: any): any {
  try { return JSON.parse(content) } catch { return { results: [] } }
}
const uploadedFiles = ref<Attachment[]>([])
/** 当前会话已绑定的工作目录（欢迎页"工作文件夹"显示与弹窗初始定位用） */
const currentWorkspaceDir = computed(() => chatStore.currentSession?.workspaceDir || wsCurrent.value)

// 切换会话时同步输入框/权限/产物
function syncSessionUI() {
  welcomePerm.value = chatStore.currentSession?.permissionLevel || 'sandbox'
  loadArtifacts()
  // 任务胶囊严格绑定当前会话：切会话清空（当前 plan 只由本会话的 plan_update 事件驱动）
  // 任务胶囊严格绑定当前会话：切会话清空（当前 plan 只由本会话的 plan_update 事件驱动）
  planStore.clearPlan()
}
watch(() => chatStore.currentSessionId, syncSessionUI)

// ============ 会话产物（AI 生成的文件）→ composables/useArtifacts.ts ============
// sessionArtifacts 仍以同一 ref 暴露：handleAgentEvent 的 file_write 分支会 unshift 进去。
const {
  sessionArtifacts, artifactsPopoverOpen, previewArtifact, previewFail,
  loadArtifacts, previewArtifactFile, openArtifactFile, openArtifactFolder,
} = useArtifacts({
  sessionId: () => chatStore.currentSessionId,
  t: (k: string) => t(k),
  onWarning: (msg: string) => nMessage.warning(msg),
})

// ---- P1-05 任务交付页辅助 ----
/** 是否渲染交付页：有产物 / 有改动 / 有结论，三者任一即渲染（此前只看产物） */
/** 交付状态文案（走 i18n，避免后端中文标签串到英文界面）；状态→key 判定在 utils/artifact-kind */
function deliveryStatusText(msg: ChatMessage): string {
  return t(deliveryStatusKey(msg.deliverySummary?.status))
}

/** 在新标签打开/预览产物（工作区文件接口按 mime 返回；浏览器可显示的图片/MD/PDF 直接看） */
function openDeliveryArtifact(a: { path?: string; name?: string }) {
  const p = a.path || ''
  if (!p) return
  window.open(`/api/workspace/file?path=${encodeURIComponent(p)}`, '_blank')
}

// ===== 交付摘要折叠 / 产物类型判定 =====
// isArtifactImage/Sheet/Doc、deliverySummaryArtifacts/Expanded、toggleDeliverySummary
// 已下沉到 utils/artifact-kind（P1-04，2026-09-18），此处直接使用导入版本。

/** 产物时间（SQLite UTC → 本地 HH:mm，跟随界面语言；en 自动 12 小时制） */
function formatArtifactTime(s: string) {
  return formatArtifactTimeRaw(s, locale.value)
}

/** 按扩展名取文件图标类型 */

// ============ 欢迎页面板 → composables/useWelcomePanel.ts ============
// currentSession 传 getter：其声明在本块之后，直接传 ref 会撞 TDZ。
const {
  welcomeInputRef, onTemplatePick,
  welcomePlusOpen, skillPickerOpen, welcomeSkills, skillList,
  welcomePerm, welcomeSettingsOpen, permShortLabel, imageInputRef,
  fsPickerOpen, openFsPicker, selectWorkspace,
  pickFile, pickImage, openSkillPicker, toggleSkill, removeSkill,
  isListening, toggleVoice, applyWelcomePerm,
} = useWelcomePanel({
  inputText,
  t: (k: string, params?: Record<string, unknown>) => (params ? t(k, params) : t(k)),
  locale: () => locale.value,
  currentSession: () => chatStore.currentSession,
  setSessionWorkspace: (id: string, path: string) => chatStore.setSessionWorkspace(id, path),
  setSessionPermission: (id: string, tier: 'workspace-only' | 'sandbox' | 'full') => chatStore.setSessionPermission(id, tier),
  fileInputEl: () => fileInputRef.value,
  onInfo: (msg: string) => nMessage.info(msg),
  onError: (msg: string) => nMessage.error(msg),
  onSuccess: (msg: string) => nMessage.success(msg),
})

/** 待发送队列：AI 回复中发送的内容先排队，回复完成后自动发布 */
interface PendingQueueItem { id: string; text: string }
const pendingQueue = ref<PendingQueueItem[]>([])

// ===== 输入触发管线（/ 与 @）→ composables/useInputTrigger.ts =====
// currentSessionId 传 getter：currentSession 的声明在本块之后（L2047），直接传 ref 会撞 TDZ。
const {
  triggerState, triggerCandidates, triggerSel, triggerSearch, displayedCandidates,
  onInputTrigger, onTriggerKeydown, onInputEnter, applyTrigger,
  closeTrigger, openTriggerFromMenu,
} = useInputTrigger({
  inputText,
  inputRef,
  t: (k: string, params?: Record<string, unknown>) => (params ? t(k, params) : t(k)),
  sessions: () => chatStore.sessions,
  currentSessionId: () => currentSession.value?.id,
  currentWorkspaceDir: () => currentWorkspaceDir.value,
  welcomePlusOpen,
  onNewChat: () => handleNewChat(),
  onSend: () => handleSend(),
  onInfo: (msg: string) => nMessage.info(msg),
})

// ===== 对话内一键引用（抽到 composables/useQuote）=====
// messages 以 getter 传入：它的声明在本块之后，直接传 ref 会在 setup 阶段撞 TDZ。
const {
  quoteRef, selQuoteMsgId, selQuoteVisible, selQuotePos,
  quoteMessage, handleQuoteMouseUp, quoteSelection, focusInput, injectQuote,
} = useQuote({ messages: () => messages.value, inputRef, t: (k: string) => t(k) })

/** 编辑队列条目：内容回填输入框并出队（可修改后重新发送） */
function editQueued(id: string) {
  const item = pendingQueue.value.find((q) => q.id === id)
  if (!item) return
  inputText.value = item.text
  pendingQueue.value = pendingQueue.value.filter((q) => q.id !== id)
  setTimeout(() => { inputRef.value?.focus?.() }, 0)
}

/** 删除队列条目 */
function deleteQueued(id: string) {
  pendingQueue.value = pendingQueue.value.filter((q) => q.id !== id)
}

/** 停止当前 AI 回复（停止后若有队列会自动发布） */
function stopGeneration() {
  // P0-6：把当前轮未完成的工具节点标记为 cancelled（WorkBuddy ToolState.cancelled 同款）
  const msgs = messages.value
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'assistant' || !m.flow) continue
    let touched = false
    for (const n of m.flow) {
      if (n.kind === 'tool' && ['running', 'stream_executing', 'pending', 'approved'].includes(n.tool.status)) {
        n.tool.status = 'cancelled'
        touched = true
      }
    }
    if (touched) break
  }
  // 2026-08-27 修复：任务中止后清除挂起的提问（否则 ask_user/ask_question 的询问窗残留不消失）
  for (const m of msgs) {
    if (m.pendingQuestion) m.pendingQuestion = undefined
  }
  // 2026-08-28：通知后端真正终止 Agent 循环。
  // 此前只 abort 前端 fetch —— 后端 while 循环完全收不到信号，会一路跑到 maxTurns
  //（复杂任务 200 轮），用户点了"停止"却看到任务仍在后台烧 token。
  // 注意：这里**不能**紧接着调 /api/chat/stop/clear —— 会在后端循环读到标记前就清掉，
  // 停止指令直接失效。停止标记的清除由后端 runAgentLoop 入口统一处理（clearStop）。
  const sid = chatStore.currentSessionId
  if (sid) {
    fetch('/api/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    }).catch(() => { /* 停止指令尽力而为，失败也不影响前端 UI 收尾 */ })
  }
  abortController.value?.abort()
}

// =================================================================
// 暂停（阶段二-②）：与"停止"的关键区别
//   停止 = 终态（cancelled），前端 abort fetch，进度只能靠检查点续跑；
//   暂停 = 非终态（paused），后端在轮次边界优雅收尾，保留 checkpoint 与
//          任务状态，可回到 running。
// **此处绝不能 abort fetch** —— abort 会让前端收不到 checkpoint_available
// 与 delivery_summary，暂停就退化成"停止"（用户看不到"继续"入口）。
// =================================================================
const isPausing = ref(false)
async function pauseGeneration() {
  if (isPausing.value) return
  const sid = chatStore.currentSessionId
  if (!sid) return
  isPausing.value = true
  aiStatus.value = 'chat.statusPausing'
  try {
    const res = await fetch('/api/chat/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    })
    if (!res.ok) {
      // 后端拒绝（任务已是终态/不存在）→ 复位，不静默卡住 UI
      isPausing.value = false
      aiStatus.value = null
    }
  } catch {
    isPausing.value = false
    aiStatus.value = null
  }
}
// 流结束后复位暂停按钮态（后端落 paused 会关闭 SSE，isLoading 随之转 false）
watch(() => chatStore.isLoading, (loading) => {
  if (!loading) isPausing.value = false
})

// =================================================================
// 流式处理核心（stores/chat-stream.ts）：打字机引擎 + flow 更新从 ChatView 抽出
// SSE 数据可能一次性到达（本地回环/代理合并），统一 tick 按非对称 EMA 平滑揭示
// （40ms / 1-4 字符 ≈ 25-100 字符/秒 匀速），正文与思考共用；可多实例（幽灵模式复用）。
// =================================================================
import { createChatStream, type ChatStream } from '@/stores/chat-stream'
import { DEFAULT_TYPING_CONFIG, advanceReveal, createTypewriterState } from '@/utils/typewriter'
import { reconcileAnswerText } from '@/utils/flow-reconcile'
let stream: ChatStream | null = null
let streamTarget: ChatMessage | null = null
/** 2026-08-29 超级协作平台：config 事件下发的发言人标识，等待应用到当前 assistant 消息 */
let pendingActor: string | undefined

function lastFlowNodeOf<T extends ChatFlowNode['kind']>(
  msg: ChatMessage,
  kind: T,
): Extract<ChatFlowNode, { kind: T }> | undefined {
  if (!msg.flow) return undefined
  for (let i = msg.flow.length - 1; i >= 0; i--) {
    if (msg.flow[i].kind === kind) return msg.flow[i] as Extract<ChatFlowNode, { kind: T }>
  }
  return undefined
}

/** 消息是否有过程节点（TurnFoldAvatar 显示/可折叠判定，对齐 WorkBuddy turnFoldActive） */
function hasProcess(msg: ChatMessage): boolean {
  if (!msg.flow || msg.flow.length === 0) return false
  return msg.flow.some((n) => n.kind === 'tool' || n.kind === 'thinking')
}

/** 点击头像切换整轮折叠（WorkBuddy TurnFoldAvatar 同款：collapsed 切换，用户操作后不被自动折叠覆盖） */
function toggleMsgFold(msg: ChatMessage) {
  // 2026-08-25 状态机版：记录用户覆盖（最高优先），由 applyCollapse 统一写回
  if (msg._userFoldState === 'expanded') msg._userFoldState = 'folded'
  else if (msg._userFoldState === 'folded') msg._userFoldState = 'expanded'
  else msg._userFoldState = msg.processCollapsed === true ? 'expanded' : 'folded'
  applyCollapse(msg)
}

/** 绑定流实例（sendAgentMessage 创建 assistantMsg 后调用） */
function bindStream(msg: ChatMessage) {
  stream?.finish()
  stream = createChatStream(msg, { thinkingMessage: t('chat.thinking') })
  streamTarget = msg
}

/** 流结束/内容收尾时强制清空残留 pending（不等限速，保证内容完整）。
 *  返回 Promise：在打字机把缓冲真正写进 flow 之后 resolve —— 调用方若随后要基于 flow
 *  写 `msg.content`（如失败分支），必须等它，否则会拿到半截文本。 */
function flushAllPending(): Promise<void> {
  const p = stream ? stream.finish() : Promise.resolve()
  stream = null
  streamTarget = null
  return p
}

/** flow 中最后一段正文文本（= 答案所在节点；无则空串） */
function lastAnswerText(flow?: ChatFlowNode[]): string {
  if (!flow) return ''
  for (let i = flow.length - 1; i >= 0; i--) {
    const n = flow[i]
    if (n.kind === 'text') return String((n as Extract<ChatFlowNode, { kind: 'text' }>).text || '')
  }
  return ''
}

// =================================================================
// 折叠状态机（2026-08-25 重构，收敛此前 7 处分散写入 + 5 轮补丁）
// 原则：事件只更新「信号」，折叠态由 deriveCollapseState 纯函数推导，applyCollapse 统一写回。
// 信号：textStarted（正文开始）/ _foldElapsed（800ms 延迟确认触发）/ _hasEnd（流结束）/
//       _userFoldState（用户手动覆盖，最高优先）
// 修复过的坑（均由状态机语义兜住）：
//  ① 并行工具 result 丢失 → 节点卡 running → 旧 hasRunningTool 判定恒 true → 只看信号不看工具状态
//  ② 正文打字机持续 content_chunk → 定时器"已调度则不重置"，不会被持续流刷新永不触发
//  ③ 工具间说明 800ms 内被新 tool_call 打断 → markToolSignal 取消定时器，不误折叠
// =================================================================
import { deriveCollapseState, collapseStateToField } from '../utils/fold-state'

const foldTimers = new Map<string, ReturnType<typeof setTimeout>>()
function msgFoldKey(msg: ChatMessage): string {
  return (msg as any).id || (msg as any).session_id || 'anon'
}

/** 统一入口：读消息信号 → 状态机推导 → 写回 processCollapsed */
function applyCollapse(msg: ChatMessage) {
  const state = deriveCollapseState({
    textStarted: (msg as any)._textStarted === true,
    hasEnd: msg._hasEnd === true,
    foldTimerElapsed: msg._foldElapsed === true,
    userOverride: msg._userFoldState,
  })
  msg.processCollapsed = collapseStateToField(state)
}

/** 正文（content_chunk）到达：标记正文开始 + 调度 800ms 延迟确认折叠 */
function markTextStarted(msg: ChatMessage) {
  ;(msg as any)._textStarted = true
  const key = msgFoldKey(msg)
  if (foldTimers.has(key)) return // 已调度则不重置——正文持续流不能刷新 timer（坑②）
  foldTimers.set(key, setTimeout(() => {
    foldTimers.delete(key)
    msg._foldElapsed = true
    applyCollapse(msg)
  }, 800))
}


/**
 * 2026-09-04: AI 调"要观画面"的工具时自动拉起右栏对应 tab。
 * 规矩: 右栏未展开才展开;已展开则仅当当前是默认 tab("deliverables") 才切到目标,
 * 用户正手动盯 preview/timeline/browser 等不抢(尊重断点)。
 */
const AUTO_REVEAL_MAP: Record<string, 'browser' | 'preview' | 'files'> = {
  browser: 'browser', computer_use: 'browser',
  generate_image: 'preview', draw_diagram: 'preview', web_fetch_frame: 'preview',
  file_write: 'files', file_edit: 'files', create_artifact: 'files',
}
function autoRevealPanelForTool(toolName: string) {
  const tab = AUTO_REVEAL_MAP[toolName] || AUTO_REVEAL_MAP[toolName.split('_')[0]]
  if (!tab) return
  if (!appStore.detailPanelVisible) {
    appStore.detailPanelVisible = true
    appStore.detailPanelTab = tab
    return
  }
  // 已展开 & 还在默认 tab → 切; 若用户在自定义 tab 观察则不打断
  if (appStore.detailPanelTab === 'deliverables' || appStore.detailPanelTab === 'files') appStore.detailPanelTab = tab
}

/** 新工具信号（tool_call / tool_args_chunk）：取消延迟确认 + 回到流式平铺（坑③） */
function markToolSignal(msg: ChatMessage) {
  const key = msgFoldKey(msg)
  const old = foldTimers.get(key)
  if (old) {
    clearTimeout(old)
    foldTimers.delete(key)
  }
  msg._foldElapsed = false
  applyCollapse(msg)
}

/** 流结束（done / finally）：取消定时器 + 标记结束 → 折叠 */
function markEnd(msg: ChatMessage) {
  const key = msgFoldKey(msg)
  const old = foldTimers.get(key)
  if (old) {
    clearTimeout(old)
    foldTimers.delete(key)
  }
  msg._hasEnd = true
  applyCollapse(msg)
}

/** 标记该消息所有 thinking 节点为完成（思考结束 → 工具/正文/收尾） */
function markAllThinkingDone(msg: ChatMessage) {
  if (stream && stream.target === msg) stream.markThinkingDone()
  else if (msg.flow) for (const n of msg.flow) if (n.kind === 'thinking') n.completed = true
}

// =================================================================
// thinking 聚合显示：连续的"已完成"思考合并为一条"已思考 N 轮"，
// 无推理内容的空思考轮直接隐藏（结果出来之后过程整体收缩，只留结果）
// =================================================================


const currentSession = computed(() => chatStore.currentSession)
const messages = computed(() => chatStore.currentMessages)

// 🔴 2026-10-14（#13）：原先这里有一份手写名单 SENSITIVE_TOOLS_SET = 3 项，
// 而服务端 I2 之后 = 7 项（由 ToolDef.requiresApproval 派生）。两份名单不一致
// ⇒ 服务端已挂起等授权的工具，界面上**两个入口都不渲染** → 只能等 120s 超时。
// 唯一真相是服务端下发的 `status`（agent.ts:1695），故已删除本地名单。

/** 待授权工具（授权浮层数据源）：当前消息流中第一个 pending 的工具（处理完自动切下一个/消失） */
const pendingApprovalTool = computed<ToolCallEvent | null>(() => {
  for (const m of messages.value) {
    for (const n of m.flow || []) {
      if (n.kind === 'tool' && n.tool.status === 'pending') {
        return n.tool
      }
    }
  }
  return null
})

/** 待回答问题（提问浮层数据源）：消息流中第一个 pendingQuestion（对齐 WorkBuddy QuestionFloating 顶部浮层，醒目） */
const pendingQuestion = computed(() => {
  for (const m of messages.value) {
    if (m.pendingQuestion) return m.pendingQuestion
  }
  return null
})
const canSend = computed(() => inputText.value.trim() || uploadedFiles.value.length > 0)

// ---- 错误横幅 / 输入横幅（对齐 WorkBuddy ErrorBanner / InputBanner：顶部横幅替代一闪而过的小弹条） ----
const errorBanner = ref<{ title: string; message?: string; details?: Record<string, string>; canRetry?: boolean } | null>(null)
/** 横幅重试：重新执行最后一条用户消息（调 handleSend 前需有内容可重发——记录最后发送文本） */
let lastFailedText = ''
function dismissErrorBanner() { errorBanner.value = null }
function retryErrorBanner() {
  errorBanner.value = null
  if (lastFailedText) {
    inputText.value = lastFailedText
    void handleSend()
  }
}
/** 输入横幅（未配置 API Key 时提示，点击跳转模型配置） */
const noKeyBannerDismissed = ref(false)
const showNoKeyBanner = computed(() => !appStore.hasApiKey && !noKeyBannerDismissed.value)

// ---- 文件上传处理（抽到 composables/useAttachments；uploadedFiles 本体仍留组件内，发送管线要读它）----
const { handleFileSelect, removeFile, openAttachment } = useAttachments({
  uploadedFiles,
  sessionId: () => chatStore.currentSession?.id,
  fileInputRef,
  t: (k: string, params?: Record<string, unknown>) => (params ? t(k, params) : t(k)),
  onError: (msg: string) => nMessage.error(msg),
})

// ---- 图卡片 / 代码块 ----
// 提取逻辑（纯函数）走 utils/svg-extract；代码块复制按钮注入（带 DOM 副作用）走 useCodeBlocks。
const { enhanceCodeBlocks } = useCodeBlocks({ messagesRef, t: (k: string) => t(k) })

/** 点击图卡片 → 右侧面板全尺寸预览 + 可下载/复制（复用 setPreview 机制） */
function openDiagram(d: { title?: string; svg: string }) {
  const name = `diagram-${(d.title || 'svg').replace(/[\s\/\\:*?"<>|]+/g, '-').slice(0, 30)}.svg`
  appStore.previewFiles = { ...appStore.previewFiles, [name]: d.svg }
  appStore.previewPath = name
  appStore.previewContent = d.svg
  appStore.previewTs = Date.now()
  appStore.detailPanelVisible = true
  appStore.setDetailPanelTab('preview')
}

/** 统一 content 取值：兼容 string（流式）与 ContentBlock[]（历史消息） */

// =================================================================
// 消息操作工具栏：复制 / 编辑 / 重发 / 反馈 / 更多菜单
// =================================================================
/** 复制成功提示的 msg.id（2s 后还原） */
const copiedMsgId = ref<string | null>(null)
/** 展开的"更多"菜单所属 msg.id */
const openMsgMenuId = ref<string | null>(null)
let copyResetTimer: ReturnType<typeof setTimeout> | null = null

/** 复制消息（纯文本：AI 回复剥 markdown，用户消息原文） */
/** 富文本复制用 markdown 渲染（轻量实例：无语法高亮，粘贴到富文本编辑器保留结构） */
const copyMd = new MarkdownIt({ html: false, linkify: true, typographer: true })

async function copyMessage(msg: ChatMessage) {
  const raw = textOf(msg.content)
  const text = msg.role === 'assistant' ? stripMarkdown(raw) : raw
  // 富文本复制：text/plain + text/html（对齐 WorkBuddy；不支持 ClipboardItem 自动降级纯文本）
  const ok = await copyRichText(text, `<div>${copyMd.render(raw)}</div>`)
  if (ok) {
    copiedMsgId.value = msg.id
    if (copyResetTimer) clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => { copiedMsgId.value = null }, 2000)
  } else {
    nMessage.error(t('chat.copyFailed'))
  }
}

/** 更多菜单：复制原始 markdown */
async function copyMessageRaw(msg: ChatMessage) {
  openMsgMenuId.value = null
  const ok = await copyToClipboard(textOf(msg.content))
  if (ok) {
    copiedMsgId.value = msg.id
    if (copyResetTimer) clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => { copiedMsgId.value = null }, 2000)
  } else {
    nMessage.error(t('chat.copyFailed'))
  }
}

/** 更多菜单：复制请求 ID */
async function copyRequestId(msg: ChatMessage) {
  openMsgMenuId.value = null
  const ok = await copyToClipboard(msg.id)
  if (ok) nMessage.success(t('chat.requestIdCopied'))
  else nMessage.error(t('chat.copyFailed'))
}

/** 更多菜单：删除消息 */
async function deleteMessage(msg: ChatMessage) {
  openMsgMenuId.value = null
  const session = chatStore.currentSession
  if (!session) return
  try {
    const res = await fetch(`/api/sessions/${session.id}/messages/${msg.id}`, { method: 'DELETE' })
    if (!res.ok) throw new Error('delete failed')
    chatStore.removeMessage(session.id, msg.id)
  } catch (err: any) {
    nMessage.error(t('chat.deleteFail') + ': ' + err.message)
  }
}

/** 点赞/点踩已删除（2026-09-26：messages.feedback 字段全后端零读取，dead data；
 *  后端接口保留不删以兼容已有库，类型 ChatMessage.feedback 字段保留供历史消息渲染不报错） */

// ---- AI 回复朗读 → composables/useChatSpeech.ts（判定逻辑全在里面，可单测）----
const {
  supported: speechSupported,
  speakingId: speakingMsgId,
  paused: speechPaused,
  proDegraded: speechProDegraded,
  synthesizing: speechSynthesizing,
  toggleSpeak,
  feedStream: feedSpeechStream,
  turnEnd: speechTurnEnd,
  stop: stopSpeech,
  toggle: toggleSpeech,
} = useChatSpeech({
  // 音色/语速读设置（设置页可改）：rate 串的格式化与设置页试听共用一处（formatTtsRate）
  voice: () => appStore.ttsVoice,
  rate: () => formatTtsRate(appStore.ttsRate),
  mode: () => appStore.autoReadMode,
  streamRead: () => appStore.streamRead,
})

/** 「本轮结束」的唯一出口 —— 完成提示音 + 自动朗读都走这里。
 *  三条结束路径（Agent 流式 / 简单流式 / 非流式）必须收敛成一处，否则早晚有第四条漏掉，
 *  或三处判定渐渐分叉（"某些情况下不响"这类 bug 最难查）。
 *  只有 ok === true（本轮真正成功结束）才出声：手动停止 / SSE 失败时念半截内容是负价值。 */
function finishTurn(msg: ChatMessage, ok: boolean) {
  speechTurnEnd(msg, ok)
  if (ok && appStore.completionSound) playCompletionTone(appStore.completionSoundTone, appStore.completionSoundVolume)
}

// 朗读生命周期：切换会话 / 新一轮开始（回复流式中）→ 立即停，避免串音
watch(() => chatStore.currentSessionId, () => stopSpeech())
watch(() => chatStore.isLoading, (loading) => {
  if (loading) stopSpeech()
})

// ---- Agent 结构化提问（ask_question 工具）→ composables/useAskQuestion.ts ----
// messages 传 getter：其声明在本块之后，直接传 ref 会撞 TDZ。
const { answerQuestionFromFloating, skipQuestion } = useAskQuestion({
  messages: () => messages.value,
})

/** 编辑：回填输入框，替换原消息重发 */
function startEditMessage(msg: ChatMessage) {
  editingMessageId.value = msg.id
  inputText.value = textOf(msg.content)
  inputRef.value?.focus()
}

/** 重发：原消息内容直接重发（复用 doSend 链路） */
function resendMessage(msg: ChatMessage) {
  const text = textOf(msg.content)
  if (!text.trim()) return
  void doSend(text.trim(), [])
}

/** 作废分支：删除指定消息及其之后所有消息（编辑/重生成时旧分支作废，对齐 GPT regenerate 分支语义） */
async function truncateMessages(fromMsgId: string) {
  const session = chatStore.currentSession
  if (!session) return
  try {
    await fetch(`/api/sessions/${session.id}/messages?after=${encodeURIComponent(fromMsgId)}`, { method: 'DELETE' })
  } catch { /* 忽略 */ }
  // 前端同步：移除该消息及其后的全部消息
  const msgs = chatStore.currentMessages
  const idx = msgs.findIndex((m) => m.id === fromMsgId)
  if (idx !== -1) {
    for (const m of msgs.slice(idx)) {
      chatStore.removeMessage(session.id, m.id)
    }
  }
}

/** AI 消息重新生成：定位其前置用户消息 → 作废旧分支 → 重发该用户消息 */
async function regenerateMessage(aiMsg: ChatMessage) {
  if (chatStore.isLoading) return
  const session = chatStore.currentSession
  if (!session) return
  const msgs = chatStore.currentMessages
  const idx = msgs.findIndex((m) => m.id === aiMsg.id)
  if (idx < 0) return
  // 向前找最近的用户消息（重生成 = 基于该用户消息重跑）
  let userMsg: ChatMessage | null = null
  for (let i = idx - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') { userMsg = msgs[i]; break }
  }
  if (!userMsg) return
  const text = textOf(userMsg.content)
  if (!text.trim()) return
  // 附件重放（图片/文档）
  const atts = attachmentList(userMsg)
  await truncateMessages(userMsg.id)
  await doSend(text.trim(), atts)
}

/** 编辑完成后提交：作废旧分支（原消息及之后全部删除）+ 发新内容 */
async function submitEdit() {
  const id = editingMessageId.value
  editingMessageId.value = null
  if (!id) return
  const session = chatStore.currentSession
  if (!session) return
  const text = inputText.value.trim()
  if (!text) return
  await truncateMessages(id)
  inputText.value = ''
  await doSend(text, [])
}

/** 更多菜单开关 */
function toggleMsgMenu(id: string) {
  openMsgMenuId.value = openMsgMenuId.value === id ? null : id
}

/** 点击消息区其他位置关闭更多菜单 */
function closeMsgMenu() {
  openMsgMenuId.value = null
}

// 消息文本格式化（发言人外观 / 时间 / 货币 / 按天分隔线）抽到 utils/chat-text：
// locale 与 visibleMessages 都以 getter 注入 —— 不把组件级响应式源塞进模块级变量（"抽出来就坏"的头号来源）。
const {
  messageRoleLabel, formatTime, formatCurrency, msgDayKey, showDayDivider, dayLabel,
} = createChatText({
  isZh: () => locale.value === 'zh-CN',
  visibleMessages: () => visibleMessages.value as any[],
  t: (k: string) => t(k),
})

// 任务完成耗时格式化统一走 utils/tool-summary 的 formatDurationMs（与折叠条同一函数），
// 原先这里的本地 formatElapsed 会输出 "1m 3s" 而折叠条输出 "1m3s"，同一条回复两处显示不一致。
/** Routine 推荐：保存为例程（AI 主动建议，学 Grok"演示一次就学会"） */
const savingRoutine = ref(false)
async function saveRoutineSuggestion(msg: { routineSuggestion?: { sessionId: string; title: string } }) {
  const sugg = msg.routineSuggestion
  if (!sugg || !sugg.sessionId) return
  savingRoutine.value = true
  try {
    const r = await fetch('/api/routines/from-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sugg.sessionId, name: sugg.title }),
    })
    const d = await r.json()
    if (d.success) {
      nMessage.success(`已保存例程：${d.name}，可在侧边栏「例程」一键复用`)
      dismissRoutineSuggestion(msg)
    } else {
      nMessage.error(d.error || '保存失败')
    }
  } catch (e: any) {
    nMessage.error(e.message)
  } finally {
    savingRoutine.value = false
  }
}
function dismissRoutineSuggestion(msg: any) {
  msg.routineSuggestion = undefined
}

// ============ 消息区滚动跟随 + 消息级渐进渲染（抽到 composables/useMessageWindow）============
// 两块逻辑本是一件事（onScroll 同时驱动"吸附底部"与"加载更早"），拆开要互相回指，故整体下沉。
const {
  renderStart, visibleMessages, stickToBottom, canScroll, activeQuestionIndex,
  nextIsAssistant, updateCanScroll, updateActiveQuestion, scrollToBottom, onScroll,
  resetRenderWindow, loadEarlier,
} = useMessageWindow({ messages: () => messages.value, messagesRef })

// 消息数量变化（新消息 / 切换会话）→ 重置渲染窗口（尾部优先）+ 强制滚到底部
watch(() => messages.value.length, () => {
  stickToBottom.value = true
  resetRenderWindow()
  scrollToBottom(true)
  updateCanScroll()
})

// AI 画图兜底：消息流式更新时自动提取 SVG 代码块为图表卡片
watch(
  () => messages.value.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\u0001'),
  () => {
    for (const m of messages.value) {
      if (m.role === 'assistant') autoExtractDiagrams(m)
    }
  },
)
// 正文流式 → 跟随滚动
watch(() => messages.value[messages.value.length - 1]?.content, () => scrollToBottom())
// 内容渲染 → 注入代码块复制按钮
watch(() => messages.value[messages.value.length - 1]?.content, () => enhanceCodeBlocks())
// flow 打字机更新（正文由 flow text 节点渲染）→ 也注入复制按钮（防 flow 渲染的代码块无按钮）
watch(
  () => (messages.value[messages.value.length - 1]?.flow?.length || 0),
  () => enhanceCodeBlocks(),
)
// 历史消息/新消息：渲染期外预提取 SVG 图卡片——渲染函数内调用 autoExtractDiagrams 修改
// reactive 不会触发本轮更新（diagram-list v-if 仍看到空），这里在 nextTick 后统一提取
watch(messages, (list) => {
  if (!list || !list.length) return
  nextTick(() => {
    for (const m of list) autoExtractDiagrams(m)
  })
})
// 时序流变化（思考推理/工具状态/文本逐字）→ 跟随滚动
watch(() => messages.value[messages.value.length - 1]?.flow, () => scrollToBottom(), { deep: true })
// 产物↔消息联动：DetailPanel 产物卡片/时间线定位 → 长会话渐进渲染窗口调整（DOM 定位由 store.focusMessage 完成）
watch(() => appStore.focusMessageTs, (ts) => {
  if (!ts) return
  const id = appStore.focusMessageId
  if (!id) return
  const idx = messages.value.findIndex((m) => m.id === id)
  if (idx < 0) return
  // 渐进渲染窗口：确保目标消息可见（保留其后 8 条上下文）；DOM 定位由 store.focusMessage 完成
  const minStart = Math.max(0, idx - 8)
  if (renderStart.value > minStart) renderStart.value = minStart
})
// 切换会话 → 强制滚到底部 + 注入代码块复制按钮
watch(() => chatStore.currentSessionId, () => {
  stickToBottom.value = true
  scrollToBottom(true)
  enhanceCodeBlocks()
})
// 分支续跑信号（来自 TimelinePanel）→ 从 checkpoint 继续执行
watch(() => chatStore.pendingResume, (ckptId) => {
  if (!ckptId) return
  chatStore.pendingResume = null
  resumeFromCheckpoint(ckptId)
})
// 幽灵建议信号（来自 GhostPanel）→ 作为用户消息自动发送
watch(() => chatStore.pendingMessage, (msg) => {
  if (!msg) return
  chatStore.pendingMessage = null
  sendGhostMessage(msg)
})

/** 幽灵建议自动发送：建议作为用户消息发起 Agent 执行 */
async function sendGhostMessage(suggestion: string) {
  if (chatStore.isLoading) {
    chatStore.pendingMessage = suggestion
    return
  }
  let session = chatStore.currentSession
  if (!session) {
    session = await chatStore.createSession(suggestion.slice(0, 40), currentWorkspaceDir.value)
  }
  const userMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: suggestion,
    createdAt: new Date().toISOString(),
  }
  await chatStore.addMessage(session.id, userMsg)

  const assistantMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    flow: [],
  }
  chatStore.addMessage(session.id, assistantMsg)
  chatStore.setLoading(true)
  abortController.value = new AbortController()
  try {
    await sendAgentMessage(assistantMsg, [{ role: 'user', content: suggestion }], undefined, session?.id)
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      const cur = messages.value.find((m) => m.id === assistantMsg.id)
      if (cur) cur.content = `❌ ${t('chat.execFail', { msg: err.message || t('chat.unknownError') })}`
    }
  } finally {
    chatStore.setLoading(false)
    abortController.value = null
    if (session) {
      if (!assistantMsg.tokenCount) {
        assistantMsg.tokenCount = Math.ceil(textOf(assistantMsg.content).length * 0.6)
      }
      chatStore.persistLastMessage(session.id)
    }
  }
}

/** 从停止原因横幅的"继续"按钮触发续跑（2026-08-26：检查点续跑一键入口） */
async function continueFromCheckpoint(stopReason: any) {
  const ckptId = stopReason?.checkpointId
  if (!ckptId) { nMessage.warning(t('chat.resumeNoCheckpoint')); return }
  await resumeFromCheckpoint(ckptId)
}

/** 从指定 checkpoint 继续 Agent 执行（分支续跑） */
async function resumeFromCheckpoint(ckptId: string) {
  if (chatStore.isLoading) {
    chatStore.pendingResume = ckptId
    return
  }
  let session = chatStore.currentSession
  if (!session) {
    session = await chatStore.createSession(t('chat.resumeTitle', { id: ckptId.slice(0, 8) }), currentWorkspaceDir.value)
  }
  const assistantMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    flow: [],
  }
  chatStore.addMessage(session.id, assistantMsg)
  chatStore.setLoading(true)
  abortController.value = new AbortController()
  try {
    await sendAgentMessage(assistantMsg, [], ckptId, session?.id)
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      const cur = messages.value.find((m) => m.id === assistantMsg.id)
      if (cur) cur.content = `❌ ${t('chat.resumeFail', { msg: err.message || t('chat.unknownError') })}`
    }
  } finally {
    chatStore.setLoading(false)
    abortController.value = null
    if (session) {
      if (!assistantMsg.tokenCount) {
        assistantMsg.tokenCount = Math.ceil(textOf(assistantMsg.content).length * 0.6)
      }
      chatStore.persistLastMessage(session.id)
    }
  }
}

function handleNewChat() {
  // 不立即创建会话：回到欢迎页草稿态，发送第一条消息时才真正建会话（避免空"新对话"堆积）
  chatStore.resetToWelcome()
  inputText.value = ''
  uploadedFiles.value = []
}

/**
 * 兼容取消息附件数组（flow 持久化复用 attachments 字段后，可能是 3 种形态）：
 * 1. 纯数组（旧数据）2. { attachments: [...], flow }（新格式）3. { 0: att1, ..., flow }（历史 bug 格式：数组被展开成对象）
 */
function attachmentList(m: ChatMessage): any[] {
  const a = (m as any).attachments
  if (Array.isArray(a)) return a
  if (a && typeof a === 'object') {
    if (Array.isArray(a.attachments)) return a.attachments
    // 历史 bug 格式：数字键还原成数组
    const vals = Object.keys(a)
      .filter((k) => /^\d+$/.test(k))
      .map((k) => a[k])
    return vals
  }
  return []
}

/**
 * 构造 API 消息
 * DeepSeek API 仅支持纯文本，不支持 image_url 多模态
 * 图片附件作为文本引用附在消息中
 */
function buildAPIMessage(m: ChatMessage) {
  const atts = attachmentList(m)
  const images = atts.filter(a => a.type.startsWith('image/'))
  const docs = atts.filter(a => !a.type.startsWith('image/'))

  if (images.length === 0 && docs.length === 0) {
    return { role: m.role, content: textOf(m.content) }
  }

  let content = textOf(m.content)
  if (images.length > 0) {
    const imgNames = images.map(i => i.name).join(', ')
    content += `\n\n[${t('chat.imagesUploaded', { n: images.length, names: imgNames })}]`
    for (const img of images) {
      content += `\n[${t('chat.imgUrl')}: ${img.url}]`
      // 本地 OCR 识别文字（RapidOCR）：让纯文本模型也能"读到"图片内容
      if (img.ocrTexts && img.ocrTexts.length > 0) {
        content += `\n[图片内容识别（OCR）]:\n${img.ocrTexts.join('\n')}`
      }
    }
  }
  if (docs.length > 0) {
    const docNames = docs.map(d => d.name).join(', ')
    content += `\n\n[${t('chat.docsUploaded', { n: docs.length, names: docNames })}]`
  }

  return { role: m.role, content }
}

// 消息历史滑动窗口：只发最近 N 条给模型（WorkBuddy contextWindow 同思路，控制长会话 prompt 膨胀）
const HISTORY_WINDOW = 40

/** 未配置 API Key 时拦截发送：跳转模型页 + 轻提示（发送按钮 title 也提示"先配置模型"） */
function ensureApiKey(): boolean {
  if (appStore.hasApiKey) return true
  nMessage.warning(t('chat.sendConfigFirst'))
  router.push('/models')
  return false
}

async function handleSend() {
  // 未配置模型 → 引导去模型页（不继续发送）
  if (!ensureApiKey()) return
  // 新消息发送 → 重置全局执行状态条（任务胶囊由 doSend 统一重置）
  aiStatus.value = 'chat.statusThinking'
  // 编辑态：回车提交编辑（替换原消息重发）
  if (editingMessageId.value) {
    await submitEdit()
    return
  }
  const text = inputText.value.trim()
  const files = [...uploadedFiles.value]

  if (!text && files.length === 0) return

  // 发送有效内容 → 记录输入历史（↑ 可找回）
  if (text) pushInputHistory(text)

  // 未选择模型 → 引导去模型页配置（不预置默认模型，用户自主选择）
  if (!appStore.currentModel) {
    nMessage.warning(t('chat.noModelHint'))
    return
  }

  // AI 正在回复 → 文本进入待发送队列（回复完成后自动发布）；附件暂不支持排队
  if (chatStore.isLoading) {
    if (files.length > 0) {
      nMessage.warning(t('chat.queueFileBusy'))
      return
    }
    pendingQueue.value.push({ id: crypto.randomUUID(), text })
    inputText.value = ''
    return
  }

  await doSend(text, files)
}

/** 真正发起一次发送（单条用户消息） */
async function doSend(text: string, files: Attachment[]) {
  // 新消息发送 → 重置横栏任务胶囊（旧计划"完成"态不再悬挂，等新 plan_update；history 保留在弹窗）
  planStore.resetProgress()
  let session = chatStore.currentSession
  if (!session) {
    // 欢迎页草稿态发送 → 此刻才真正创建会话（标题交给下方自动命名生成摘要）
    session = await chatStore.createSession(undefined, currentWorkspaceDir.value)
  }

  // 欢迎页显式选择的技能 → 注入消息开头（AI 优先使用这些技能）
  let content = text || t('chat.filePlaceholder')
  if (welcomeSkills.value.length > 0) {
    const skillNames = welcomeSkills.value.map((s) => s.name).join(', ')
    content = `${t('chat.explicitSkills', { names: skillNames })}\n\n${content}`
  }
  // 对话内引用 → 拼进用户消息（后端据此注入"引用最高优先级"上下文）
  if (quoteRef.value) {
    content = injectQuote(content)
  }

  const userMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    attachments: files.length > 0 ? files : undefined,
  }
  await chatStore.addMessage(session.id, userMsg)
  // 自动命名：新会话（标题仍是默认值）用首条消息摘要做标题，侧边栏可读
  if (isDefaultTitle(session.title)) {
    const title = (text || t('chat.filePlaceholder')).replace(/\s+/g, ' ').trim().slice(0, 24)
    if (title) chatStore.setSessionTitle(session.id, title)
  }
  // 发送完成：清空欢迎页显式技能
  welcomeSkills.value = []
  skillPickerOpen.value = false
  welcomePlusOpen.value = false

  const assistantMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    toolCalls: [],
    thinking: [],
    startedAt: Date.now(),
  }
  chatStore.addMessage(session.id, assistantMsg)
  chatStore.setLoading(true)
  inputText.value = ''
  uploadedFiles.value = []
  quoteRef.value = null
  abortController.value = new AbortController()

  // 计时起点：也写入 store 里的响应式副本（flow 渲染基于它）
  const reactiveAssistantMsg = messages.value.find((m) => m.id === assistantMsg.id)
  if (reactiveAssistantMsg) reactiveAssistantMsg.startedAt = Date.now()

  try {
    // 滑动窗口：只发最近 40 条历史（解决长会话 prompt 膨胀越聊越慢；后端 compressContext 超限兜底）
    const apiMessages = messages.value
      .filter((m) => m.id !== assistantMsg.id)
      .slice(-HISTORY_WINDOW)
      .map((m) => buildAPIMessage(m))

    if (compareMode.value) {
      await sendCompare(assistantMsg, apiMessages, session?.id)
    } else if (agentMode.value) {
      // 视觉多模态：图片附件 → 传给后端注入 vision 模型（2026-08-23）
      const imgList = files.filter((f) => f.type.startsWith('image/')).map((f) => ({ name: f.name, url: f.url }))
      await sendAgentMessage(assistantMsg, apiMessages, undefined, session?.id, imgList)
    } else {
      await sendSimpleStream(assistantMsg, apiMessages)
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      const cur = messages.value.find((m) => m.id === assistantMsg.id)
      if (cur) cur.content = `❌ ${t('chat.requestFail', { msg: err.message || t('chat.apiKeyHint') })}`
      // 错误横幅（对齐 WorkBuddy ErrorBanner）：可复制错误报告 + 重试（doSend 主路径）
      lastFailedText = text
      errorBanner.value = {
        title: t('chat.errorBannerExecTitle'),
        message: err.message || t('chat.unknownError'),
        details: { timestamp: new Date().toISOString() },
        canRetry: true,
      }
    }
  } finally {
    chatStore.setLoading(false)
    // 兜底保险：流完全结束后，最后一条有过程的助手消息确保默认折叠（对齐 WorkBuddy turnFold）
    // 即使 done 事件异常未触发，也通过状态机 markEnd 强制折叠，避免过程平铺残留
    const lastMsg = messages.value[messages.value.length - 1]
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.flow && lastMsg.flow.length > 0 && lastMsg.processCollapsed === undefined) {
      markEnd(lastMsg)
    }
    abortController.value = null
    if (session) {
      // 估算 token 数兜底（usage 事件未提供真实值时）：中英混合粗略 0.6 token/字符
      if (!assistantMsg.tokenCount) {
        assistantMsg.tokenCount = Math.ceil(textOf(assistantMsg.content).length * 0.6)
      }
      chatStore.persistLastMessage(session.id)
    }
    // AI 回复完成 → 自动发布队列中的内容（一次请求，多条用户消息）
    if (pendingQueue.value.length > 0) {
      const queued = pendingQueue.value.splice(0)
      void sendQueued(queued.map((q) => q.text))
    }
  }
}

/** 自动发布队列：多条用户消息一次请求发给 AI，回复完成后继续处理剩余队列 */
async function sendQueued(texts: string[]) {
  // 队列发布同样是"新任务开始"：重置横栏任务胶囊（旧计划"完成"态不再悬挂）
  planStore.resetProgress()
  let session = chatStore.currentSession
  if (!session) {
    session = await chatStore.createSession(texts[0].slice(0, 50))
  }

  for (const text of texts) {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    }
    await chatStore.addMessage(session.id, userMsg)
  }

  const assistantMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    toolCalls: [],
    thinking: [],
  }
  chatStore.addMessage(session.id, assistantMsg)
  chatStore.setLoading(true)
  abortController.value = new AbortController()

  try {
    // 滑动窗口：只发最近 40 条历史（解决长会话 prompt 膨胀越聊越慢；后端 compressContext 超限兜底）
    const apiMessages = messages.value
      .filter((m) => m.id !== assistantMsg.id)
      .slice(-HISTORY_WINDOW)
      .map((m) => buildAPIMessage(m))
    if (agentMode.value) {
      await sendAgentMessage(assistantMsg, apiMessages, undefined, session?.id)
    } else {
      await sendSimpleStream(assistantMsg, apiMessages)
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      const cur = messages.value.find((m) => m.id === assistantMsg.id)
      if (cur) cur.content = `❌ ${t('chat.requestFail', { msg: err.message || t('chat.apiKeyHint') })}`
    }
  } finally {
    chatStore.setLoading(false)
    abortController.value = null
    if (session) {
      // 真实 usage 已由 usage 事件写入则不覆盖；否则用估算值兜底
      if (!assistantMsg.tokenCount) {
        assistantMsg.tokenCount = Math.ceil(textOf(assistantMsg.content).length * 0.6)
      }
      chatStore.persistLastMessage(session.id)
    }
    // 若用户在自动发布期间又排队了内容 → 继续自动发布，直到队列清空
    if (pendingQueue.value.length > 0) {
      const queued = pendingQueue.value.splice(0)
      void sendQueued(queued.map((q) => q.text))
    }
  }
}

/**
 * 多模型对比模式 — 流式版 /api/chat/compare-stream：多列同时打字机输出
 * 完成后结果 JSON 存 content（历史消息重新渲染为静态多列）
 */
async function sendCompare(assistantMsg: ChatMessage, apiMessages: Array<{ role: string; content: string }>, sessionId?: string) {
  const configs = collectProviderConfigs()
  // 初始化打字列（按用户选择顺序；label 来自配置）
  const chosen = compareModels.value.length > 0 ? compareModels.value : configs.map((c) => c.model)
  compareLive.value = chosen
    .map((m) => ({ id: 'ls-' + m, label: configs.find((c) => c.model === m)?.label || m, text: '', done: false }))
  compareLiveReco.value = ''
  compareLiveFinished.value = false
  compareActiveId.value = assistantMsg.id

  const resp = await fetch('/api/chat/compare-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: abortController.value?.signal,
    body: JSON.stringify({
      messages: apiMessages,
      models: compareModels.value.length > 0 ? compareModels.value : undefined,
      providerConfigs: configs,
    }),
  })
  if (!resp.ok) {
    const d = await resp.json().catch(() => ({}))
    throw new Error(d?.error || `HTTP ${resp.status}`)
  }
  if (!resp.body) throw new Error('no body')

  // 解析 SSE 流，逐列增量打字
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const upsert = (id: string, text: string) => {
    const col = compareLive.value.find((c) => c.id === id)
    if (col) col.text += text
    else compareLive.value.push({ id, label: id.replace(/^ls-/, ''), text, done: false })
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const d = JSON.parse(line.slice(6))
        if (d.t === 'd') upsert(d.id, d.text)
        else if (d.t === 'done') {
          const col = compareLive.value.find((c) => c.id === d.id)
          if (col) col.done = true
          else compareLive.value.push({ id: d.id, label: d.label || d.id, text: '', done: true })
        } else if (d.t === 'reco') {
          compareLiveReco.value = d.text
        } else if (d.t === 'end') {
          compareLiveFinished.value = true
        }
      } catch { /* 跳过坏行 */ }
    }
  }

  // 组装完整结果 → 存消息（历史加载时静态渲染）
  const data = {
    results: compareLive.value.map((c) => ({
      id: c.id,
      model: c.id.replace(/^ls-/, ''),
      label: c.label,
      content: c.text,
      error: c.done ? '' : 'stream failed',
    })),
    recommendation: compareLiveReco.value,
  }
  const cur = messages.value.find((m) => m.id === assistantMsg.id)
  if (cur) {
    cur.content = JSON.stringify(data)
    cur.status = 'complete'
    const totalLen = data.results.reduce((s: number, r: any) => s + (r.content || '').length, 0)
    cur.tokenCount = Math.ceil(totalLen * 0.6)
    if (sessionId) chatStore.persistLastMessage(sessionId)
  }
  // 清理打字状态
  compareLive.value = []
  compareLiveReco.value = ''
  compareLiveFinished.value = false
  compareActiveId.value = ''
}

/**
 * Agent 模式 — 使用 /api/chat/agent，处理 named SSE 事件
 */
async function sendAgentMessage(assistantMsg: ChatMessage, apiMessages: Array<{ role: string; content: string }>, resumeCheckpoint?: string, sessionId?: string, images?: Array<{ name?: string; url?: string }>) {
  // 关键：用 store 里的响应式对象作为流式更新目标。
  // assistantMsg 是原始对象，直接改它的 flow/text 不会触发 Vue 渲染
  // （Vue3 reactive 只追踪 proxy），导致所有更新合并到一次渲染 → 一次性出结果。
  const reactiveMsg = messages.value.find((m) => m.id === assistantMsg.id) || assistantMsg
  // 绑定流实例：打字机 + flow 更新集中到 stores/chat-stream.ts（SSE 直写，可多实例）
  bindStream(reactiveMsg)

  // ---- SSE 流式读取：带事件 id 解析 + 按 seq 去重 + 断线安全重试（P1-4，对齐 WorkBuddy accumulator） ----
  // 事件 id 由后端 emitSSE 自增写入（agent.ts）；重试从头重跑，前端靠 seq 过滤旧事件实现"无感续播"。
  // 副作用保护：已收到 tool_call/tool_result（工具已执行）后断线 → 不自动重试（避免重复执行），改为提示。
  const decoder = new TextDecoder()
  let receivedDone = false
  // 函数级 lastSeq：重试时保留（P1-4 修正）——后端每次请求 seq 从头计数，
  // 重跑事件 seq ≤ lastSeq 被去重过滤，UI 不重复渲染；副作用保护见 toolExecuted
  let lastSeq = 0

  async function attemptStream(retryLeft: number): Promise<boolean> {
    const res = await fetch('/api/chat/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: apiMessages, model: appStore.currentModel, resumeCheckpoint, sessionId, language: locale.value, images: images && images.length > 0 ? images : undefined }),
      signal: abortController.value!.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body')

    let buffer = ''
    let currentEvent = ''
    let currentId = ''
    let toolExecuted = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('id: ')) {
            currentId = line.slice(4).trim()
          } else if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            // 按函数级 lastSeq 去重：重连后重跑的事件 seq 从头开始，≤ lastSeq 的旧事件直接丢弃
            const seq = currentId ? parseInt(currentId, 10) : 0
            if (seq > lastSeq) {
              lastSeq = seq
              const dataStr = line.slice(6).trim()
              try {
                const data = JSON.parse(dataStr)
                if (currentEvent === 'done') receivedDone = true
                if (currentEvent === 'tool_call' || currentEvent === 'tool_result' || currentEvent === 'tool_args_chunk') toolExecuted = true
                handleAgentEvent(currentEvent, data, reactiveMsg, sessionId)
              } catch {}
            }
            currentId = ''
            currentEvent = ''
          }
        }
      }
    } catch (err) {
      // 读流异常（网络抖动/服务端断开）→ 落入下方中断判定
    }

    if (receivedDone) return true
    // 流中断：未执行工具（无副作用）才自动重试；已执行过工具 → 提示用户，避免重复执行副作用
    if (retryLeft > 0 && !toolExecuted && !abortController.value!.signal.aborted) {
      await new Promise((r) => setTimeout(r, 800))
      return attemptStream(retryLeft - 1)
    }
    if (!toolExecuted && !abortController.value!.signal.aborted) {
      nMessage.warning(t('chat.streamReconnectFailed'))
    } else if (toolExecuted && !receivedDone && !abortController.value!.signal.aborted) {
      nMessage.warning(t('chat.streamInterrupted'))
    }
    return false
  }

  const streamOk = await attemptStream(2)
  // 注意：此处不强制 flushAllPending —— 让限速定时器自然播完剩余，
  // 保证打字机效果完整（done/content 事件也不会打断）。
  // 流自然结束（非用户手动停止）→ 提示音 + 自动朗读（见 finishTurn）
  finishTurn(assistantMsg, streamOk)
}

/**
 * 以 content 为准收敛 flow 的结果正文（唯一实现见 utils/flow-reconcile.ts）。
 *
 * 判据**不是**长度，而是「最后一个 text 段是不是 content 的前缀」——
 * 过程旁白不在 content 里，旧实现用「全部 text 段拼接长度」当偏移，
 * 把旁白长度也算进去，`content.slice()` 起点越界 → 答案被静默挖洞。
 * 详见 flow-reconcile.ts 顶部不变量说明。
 *
 * 幂等：正常情况下 `finish(content)` 播完后末段已等于 content，这里退化为 noop（只兜底）。
 */
function syncTextToFlow(msg: ChatMessage) {
  if (!msg.flow || msg.flow.length === 0 || typeof msg.content !== 'string') return
  const res = reconcileAnswerText(msg.flow, msg.content)
  if (res.action !== 'noop') msg.flow = res.flow
}

function handleAgentEvent(event: string, data: any, msg: ChatMessage, sessionId?: string) {
  // 时序流：每个事件按到达顺序追加节点（思考/工具/文本交错）
  if (!msg.flow) msg.flow = []

  switch (event) {
    case 'thinking': {
      // 新一轮思考开始 → 之前的思考已完成
      markAllThinkingDone(msg)
      aiStatus.value = 'chat.statusThinking'
      aiStatusTarget.value = ''
      msg.flow.push({ id: nextNodeId(), kind: 'thinking', turn: data.turn, message: t('chat.thinking'), reasoning: '', completed: false })
      break
    }
    case 'model_requesting': {
      // 模型请求已发出、响应未到达（WorkBuddy model_requesting 同款：等待模型响应，消除"暂停几秒"空白感）
      aiStatus.value = 'chat.statusWaitingModel'
      aiStatusTarget.value = ''
      break
    }
    case 'thinking_chunk': {
      // 真实推理 → 累积 + 统一打字机 tick（与正文同引擎：不再全速喷射）
      aiStatus.value = 'chat.statusThinking'
      aiStatusTarget.value = ''
      streamTarget = msg
      stream?.pushReasoning(data.text || '')
      break
    }
    case 'tool_call': {
      // 思考结束 → 开始调工具，收起 thinking
      markAllThinkingDone(msg)
      // 2026-09-04: AI 调需要观看画面的工具 → 自动拉起右栏对应 tab（不打断主动在看别 tab 的用户）
      try { autoRevealPanelForTool(data.name) } catch {}
      // 新工具到达 → 取消延迟确认 + 回到流式平铺（状态机 markToolSignal，坑③）
      markToolSignal(msg)
      // 先刷完剩余正文（防止打字机限速导致正文被工具卡片从中间劈开：正文前半→工具→正文后半）
      stream?.flushTextNow()
      // 工具真的被调用 = 当前正文段到此为止（P0 2026-09-29）：**必须在 flushTextNow 之后**，
      // 否则剩余正文会被留到下一个段里。不加这一行，模型"工具后在续写同一句"的尾片
      // 会和下一段旁白粘成一个节点；加了这一行，参数增量阶段的尾片仍会回收到原段（见 chat-stream.ts）。
      stream?.closeTextSegment()
      aiStatus.value = toolStatusLabel(data.name)
      aiStatusTarget.value = extractToolTarget(data.name, data.arguments)
      // 增量参数占位节点已存在（tool_args_chunk 边生成边创建）→ 轮末完整参数覆盖更新；否则新建。
      // 注意：增量早期 toolCallId 可能为空（模型先出 name 后出 id）→ 占位节点 id 为空，
      // 按真实 id 找不到时回退匹配"同名的空 id 占位"（P1-5 修正，防重复节点）
      const existingTool =
        msg.flow.find(
          (n): n is Extract<ChatFlowNode, { kind: 'tool' }> => n.kind === 'tool' && n.tool.id === data.id,
        ) ||
        msg.flow.find(
          (n): n is Extract<ChatFlowNode, { kind: 'tool' }> => n.kind === 'tool' && !n.tool.id && n.tool.name === data.name,
        )
      if (existingTool) {
        existingTool.tool.id = data.id  // 空 id 占位 → 补真实 id
        existingTool.tool.name = data.name
        existingTool.tool.arguments = data.arguments
        existingTool.tool.status = data.status === 'pending' ? 'pending' : 'running'
      } else {
        msg.flow.push({
          kind: 'tool',
          tool: {
            id: data.id,
            name: data.name,
            arguments: data.arguments,
            status: data.status === 'pending' ? 'pending' : 'running',
            startedAt: Date.now(),
            createTime: data.createTime || Date.now(),  // P0-7：工具真实执行时刻（持久化供历史订正）
          },
        })
      }
      break
    }
    case 'tool_args_chunk': {
      // 工具参数增量流（WorkBuddy 流式参数解析同款）：纯 flow 操作（utils/agent-flow），节点未建 → 占位。
      // 时序修复：增量参数先于 tool_call 到达 → 参数开始出现 = 思考阶段结束，
      // 必须同 tool_call 一样收起 thinking（markAllThinkingDone 刷完推理 + 折叠），
      // 否则出现"上面还在正在思考、下面工具卡片已渲染"的错位（老板 2026-08-21 反馈）
      markAllThinkingDone(msg)
      markToolSignal(msg)
      stream?.flushTextNow()
      applyToolArgsChunk(msg, data)
      break
    }
    case 'tool_output': {
      // 工具流式输出：按 toolCallId 找到对应卡片，实时追加（边跑边显示）
      applyToolOutput(msg, data)
      break
    }
    case 'tool_progress': {
      // 结构化进度（数值型）：file_write 的 ±行数 / multi_edit 的处数，驱动状态行实时数字
      applyToolProgress(msg, data)
      break
    }
    case 'tool_result': {
      // 更新对应 tool 节点：优先按 toolCallId 精确归属（并行同名工具不串卡，WorkBuddy toolCallId→index 同款），找不到回退按 name
      aiStatus.value = 'chat.statusThinking'
      aiStatusTarget.value = ''
      applyToolResult(msg, data)
      break
    }
    case 'tool_duration': {
      // 优先按 toolCallId 归属（后端已补发 tool_call_id），避免并行同名工具耗时串卡
      applyToolDuration(msg, data)
      break
    }
    case 'turn_limit_reached': {
      // 轮次超限（结构化停止原因，对齐 WorkBuddy MaxTurnsExceededError）：消息内提示 + 折叠条下方显示"可继续"
      msg.stopReason = { reason: 'max_turns', message: data.message || '', checkpointId: data.checkpointId || '', toolCalls: data.toolCallCount || 0 }
      aiStatus.value = null
      aiStatusTarget.value = ''
      break
    }
    case 'checkpoint_available': {
      // 2026-08-26：API 中断（费用耗尽等）→ 保存检查点，前端显示"继续"按钮触发续跑
      msg.stopReason = { reason: 'interrupted', message: data.message || '', checkpointId: data.checkpointId || '', toolCalls: data.toolCallCount || 0, turns: data.turns }
      aiStatus.value = null
      aiStatusTarget.value = ''
      break
    }
    case 'skill_matched': {
      if (!msg.skills) msg.skills = []
      if (!msg.skills.some((s) => s.name === data.name)) msg.skills.push({ name: data.name, name_en: data.name_en })
      break
    }
    case 'playbook_used': {
      if (!msg.playbookUsed) msg.playbookUsed = []
      if (!msg.playbookUsed.some((p) => p.taskType === data.taskType)) {
        msg.playbookUsed.push({ taskType: data.taskType, lesson: data.lesson })
      }
      break
    }
    case 'role_routed': {
      msg.roleRouted = { roleId: data.roleId, roleName: data.roleName, matchedKeyword: data.matchedKeyword || '' }
      break
    }
    case 'planner_start': {
      // 规划中反馈：显示"正在规划执行步骤"（替代三个点干跳）
      msg.plannerPending = true
      aiStatus.value = 'chat.statusPlanning'
      break
    }
    case 'planner_plan': {
      msg.plannerPending = false
      msg.planner = { steps: data.steps || [], raw: data.raw || '' }
      aiStatus.value = 'chat.statusThinking'
      aiStatusTarget.value = ''
      break
    }
    case 'content_chunk': {
      // 打字机：模型输出正文（可能是工具间简短说明，也可能是最终报告）
      const text = data.text || ''
      if (!text) break
      aiStatus.value = 'chat.statusGenerating'
      // 2026-08-29 超级协作平台：把待应用的 actor 落到这条 assistant 消息
      if (pendingActor && msg && msg.role === 'assistant') {
        msg.actor = pendingActor
        pendingActor = undefined
      }
      // 注意：执行中（含工具间简短说明）全程平铺，不折叠——折叠只在 done（轮次完成）时触发（WorkBuddy turnFold 逻辑）
      // 2026-08-25：不再 markAllThinkingDone——正文开始时思考可能还在前端打字机播（模型 reasoning 一次性到达），
      // 强制收起会让"思考没看完就被收掉"；思考保持展开，用户可滚动看完整推理，done 时统一标记完成。
      // 2026-08-25 14:5x 状态机：正文到达 → markTextStarted（800ms 延迟确认折叠）。
      // 不再用 hasRunningTool 判定——并行工具 result 丢失会让节点卡 running 恒 true、最终正文永不折叠（坑①）
      markTextStarted(msg)
      // 同步 msg.content（供 token 估算/持久化/历史兼容）
      if (typeof msg.content === 'string') msg.content += text
      else msg.content = text
      // 累积 + 统一打字机 tick，逐段呈现（防一次性出结果）
      streamTarget = msg
      stream?.pushText(text)
      // 边生成边朗读（设置项 streamRead）：攒够一块且"本轮本来就会读"时才真的出声，
      // 判定与收尾全在 useChatSpeech 里，这里只负责把增量递进去
      feedSpeechStream(msg, text)
      break
    }
    case 'content': {
      // 后端在流读完后的完整内容：同步 content（持久化/历史），
      // 但不打断打字机——让限速 flush 自然播完剩余（保证视觉流式）
      msg.content = data.content
      // 2026-08-25：与 content_chunk 一致，不在此收起思考（等 done 统一标记）
      break
    }
    case 'file_created': {
      // AI 生成文件 → 实时插入会话产物列表（去重）
      if (data && data.name) {
        const sid = chatStore.currentSessionId
        if (sid) {
          const exists = sessionArtifacts.value.some((a) => a.path === data.path)
          if (!exists) {
            sessionArtifacts.value.unshift({
              id: `live-${Date.now()}`,
              session_id: sid,
              name: data.name,
              path: data.path || '',
              mime: data.mime || 'text/plain',
              size: data.size || 0,
              action: 'created',
              created_at: new Date().toISOString(),
            })
          }
        }
      }
      break
    }
    case 'delivery_summary': {
      msg.deliverySummary = {
        artifactCount: data.artifactCount || 0,
        artifacts: data.artifacts || [],
        toolCallCount: data.toolCallCount || 0,
        turns: data.turns || 0,
      }
      break
    }
    case 'routine_suggest': {
      // 复杂任务完成 → AI 主动推荐保存为可复用流程（学 Grok"演示一次就学会"）
      msg.routineSuggestion = {
        sessionId: data.sessionId || '',
        title: data.title || '未命名任务',
        toolSummary: data.toolSummary || [],
        toolCount: data.toolCount || 0,
        turnCount: data.turnCount || 0,
      }
      break
    }
    case 'plan_update': {
      // 横栏任务胶囊：步骤状态推进（每轮 completed → 下一步 in_progress → 收尾全 completed）
      planStore.setPlanUpdate({
        planId: data.planId,
        title: data.title || '',
        steps: Array.isArray(data.steps) ? data.steps.map((s: any) => ({ id: s.id, subject: s.subject, status: s.status })) : [],
      })
      break
    }
    case 'usage': {
      // 真实 token 用量（DeepSeek 流式结束时的 usage 字段）——覆盖前端估算值
      msg.tokenCount = data.totalTokens || msg.tokenCount
      msg.promptTokens = data.promptTokens || 0
      msg.completionTokens = data.completionTokens || 0
      // 费用（后端按模型单价估算，¥）——随消息持久化
      if (typeof data.cost === 'number') msg.cost = data.cost
      // 上下文用量（顶部圆环数据源）：已用上下文 = prompt_tokens（会话累计上下文）
      if (typeof data.promptTokens === 'number') {
        appStore.setCtxUsage(data.promptTokens)
      }
      break
    }
    case 'config': {
      // 上下文窗口大小（后端按模型动态下发）→ 圆环分母
      if (typeof data.contextWindow === 'number') {
        appStore.setCtxWindow(data.contextWindow)
      }
      // 2026-08-29 超级协作平台：发言人标识，应用到当前 assistant 消息
      if (typeof data.actor === 'string' && data.actor) {
        pendingActor = data.actor
        if (msg && msg.role === 'assistant') msg.actor = data.actor
      }
      break
    }
    case 'compressed': {
      // 上下文被压缩 → 圆环标记跳回
      appStore.markCtxCompressed()
      break
    }
    case 'preview_update': {
      // 实时预览（L1）：AI 写入 html 文件 → 右侧边栏实时渲染
      if (typeof data.path === 'string' && typeof data.content === 'string') {
        appStore.setPreview(data.path, data.content)
        // 首次出现预览时自动打开右侧边栏的 preview tab
        if (!appStore.detailPanelVisible || appStore.detailPanelTab !== 'preview') {
          appStore.detailPanelVisible = true
          appStore.detailPanelTab = 'preview'
        }
      }
      break
    }
    case 'diagram_chunk': {
      // 流式画图（WorkBuddy 同款"先出画板再逐框绘制"）：SVG 块追加到进行中的图节点，
      // 元素闭合即被浏览器绘制 → 视觉上像实时画图；无进行中节点则先建空"画板"
      if (typeof data.chunk === 'string') {
        streamTarget = msg
        stream?.appendDiagramChunk(data.chunk)
      }
      break
    }
    case 'diagram': {
      // AI 画图（P0）：draw_diagram 工具 / 代码块兜底 / 后端自动补图
      // 图作为 flow 节点按位置渲染（WorkBuddy image-block 同款）——diagram 事件在总结文字之前到达，
      // push 到 flow 末尾即"产生位置"，后续正文 text 节点追加在它后面 → 图固定在工具与总结之间，不再被文字推走
      if (typeof data.svg === 'string' && data.svg.startsWith('<svg')) {
        const cur = streamTarget || [...messages.value].reverse().find((m) => m.role === 'assistant')
        if (cur) {
          if (stream && stream.target === cur) stream.completeDiagram(data.svg, String(data.title || ''))
          else {
            if (!cur.flow) cur.flow = []
            cur.flow.push({ id: nextNodeId(), kind: 'diagram', svg: data.svg, title: String(data.title || '').slice(0, 60) })
          }
          // 兼容保留 diagrams（历史消息/兜底渲染会过滤 flow 已有的图，见 flowDiagramSet）
          if (!cur.diagrams) cur.diagrams = []
          cur.diagrams.push({ title: String(data.title || '').slice(0, 60), svg: data.svg })
        }
      }
      break
    }
    case 'image_generated': {
      // AI 生成图片（generate_image 工具）：对话内 image 段 + 右侧 preview 展示
      if (typeof data.data === 'string') {
        const cur = streamTarget || [...messages.value].reverse().find((m) => m.role === 'assistant')
        if (cur) {
          if (!cur.flow) cur.flow = []
          cur.flow.push({ id: nextNodeId(), kind: 'image', data: data.data, isUrl: !!data.isUrl, title: String(data.title || '').slice(0, 60) })
          // 图节点是非正文块 ⇒ 封口当前正文段，图后的正文另起节点（顺序不乱）
          stream?.closeTextSegment()
        }
        appStore.setPreviewImage(String(data.data), !!data.isUrl, String(data.title || '').slice(0, 60))
      }
      break
    }
    case 'file_changed': {
      // 文件变更（变更 tab）：写入文件时记录改前/改后内容
      if (typeof data.path === 'string') {
        appStore.addFileChange(data.path, data.oldContent || '', data.newContent || '')
        // 工具卡片内嵌 diff（对齐 WorkBuddy WriteFileRenderer）：挂到最近一个 file_write 工具节点
        if (msg.flow) {
          for (let i = msg.flow.length - 1; i >= 0; i--) {
            const n = msg.flow[i]
            if (n.kind === 'tool' && n.tool.name === 'file_write' && !(n.tool as any).fileDiff) {
              ;(n.tool as any).fileDiff = { path: data.path, oldContent: data.oldContent || '', newContent: data.newContent || '' }
              break
            }
          }
        }
      }
      break
    }
    case 'question': {
      // Agent 结构化提问（ask_question / ask_user 工具）：展示交互面板，答复后继续
      // 2026-08-27 修复：options 可能被模型传成对象数组导致渲染 [object Object] → 归一化成字符串
      if (!msg.pendingQuestion) {
        const opts = (data.options || []).map((o: any) =>
          typeof o === 'string' ? o : (o?.text ?? o?.label ?? o?.value ?? JSON.stringify(o))
        ).filter(Boolean)
        msg.pendingQuestion = { id: data.id, question: data.question, options: opts }
      }
      break
    }
    case 'task_state': {
      // P0-03 统一任务状态机：后端唯一权威状态源。
      // 此前状态分散在 aiStatus / 工具卡 / Plan Capsule / 检查点 等处各自维护，
      // 导致"前端显示完成但后端还在跑"。现在统一从这里派生。
      msg.taskState = {
        taskId: data.task_id || '',
        status: data.status || '',
        step: data.current_step || '',
        checkpointId: data.checkpoint_id || '',
        cancelRequested: !!data.cancel_requested_at,
        failureCode: data.failure_code || '',
      }
      const keyMap: Record<string, string> = {
        created: 'chat.taskCreated',
        planning: 'chat.taskPlanning',
        awaiting_approval: 'chat.taskAwaitingApproval',
        running: 'chat.taskRunning',
        waiting_user: 'chat.taskWaitingUser',
        paused: 'chat.taskPaused',
        failed: 'chat.taskFailed',
        cancelled: 'chat.taskCancelled',
        completed: 'chat.taskCompleted',
      }
      const isTerminalState = ['completed', 'failed', 'cancelled'].includes(data.status)
      if (data.cancel_requested_at) {
        // 已请求取消但循环仍在跑 → 显示"正在停止…"（这正是 cancel_requested_at 的语义）
        aiStatus.value = 'chat.taskCancelling'
      } else if (!isTerminalState) {
        aiStatus.value = keyMap[data.status] || 'chat.statusThinking'
      }
      break
    }
    case 'done': {
      // 流结束：只标记状态（打字机收尾由 finish 处理）
      markEnd(msg)
      markAllThinkingDone(msg)  // 内部刷完 pendingReasoning 进 flow
      // 2026-08-27 保险：本轮 done 时若仍有未答提问，清掉（避免询问窗在任务结束后残留）
      if (msg.pendingQuestion) msg.pendingQuestion = undefined
      // 2026-08-25 修复"结果一次性出来"：done 时不再 flushTextNow 瞬间刷完正文，
      // 改为 finish() 加速收尾播完（24ms/16字符，保留打字机动感）。
      // 2026-09-24 定序修复：finish 现在是**异步到播完才 resolve**，并以 content 为基准重算待播；
      // 对账 + 落盘必须挂在它后面 —— 旧实现 `finish(); syncTextToFlow()` 是同步连写，
      // 此刻打字机还没把缓冲播进 flow，"已达偏移"用的是半截长度 → 答案被挖洞（实测 73.8% 命中）。
      const streamRef = stream
      const answerText = typeof msg.content === 'string' ? msg.content : undefined
      const finishing = streamRef ? streamRef.finish(answerText) : Promise.resolve()
      stream = null
      streamTarget = null
      void finishing.then(() => {
        // 兜底对账（正常路径 finish 已让末段 == content，此处退化为 noop）+ received 态落盘
        syncTextToFlow(msg)
        if (sessionId) void chatStore.persistLastMessage(sessionId)
      })
      aiStatus.value = null
      aiStatusTarget.value = ''
      // 轮次完成 → 折叠已由 markEnd 状态机处理（WorkBuddy turnFold 语义；用户手动展开过则 userOverride 优先不覆盖）
      // ①移除末尾"收尾确认"思考节点（纯思考轮收尾）
      // 注意：不做"text 统一置底"——交替式下中间说明文本保持原位（WorkBuddy 时序：说明→工具→说明→工具→最终报告）
      if (msg.flow && msg.flow.length > 1) {
        while (msg.flow.length > 1 && msg.flow[msg.flow.length - 1].kind === 'thinking') {
          msg.flow.pop()
        }
      }
      // 任务完成：当前 plan 归档进历史（弹窗时间线可见），胶囊保留全完成态
      // （markPlanFinished：区分"步骤全 completed 但 AI 还在收尾"——只有 done 才算真完成）
      if (planStore.planProgress && planStore.planProgress.steps.every((s) => s.status === 'completed')) {
        planStore.setPlanUpdate(planStore.planProgress)
      }
      if (planStore.planProgress) {
        planStore.markPlanFinished()
      }
      // 任务完成计时：发送时刻 → done 时刻
      if (msg.startedAt) {
        msg.elapsedMs = Date.now() - msg.startedAt
        msg.startedAt = undefined
      }
      break
    }
    case 'error': {
      // 出错：强制补全残留，避免内容缺失（状态机：取消延迟确认，保持当前折叠态不强制折叠）
      markToolSignal(msg)
      const flushed = flushAllPending()
      // 2026-08-27 保险：出错也清未答提问，避免询问窗残留
      if (msg.pendingQuestion) msg.pendingQuestion = undefined
      if (data.paused) {
        // 阶段二-②：暂停走 error 通道传"正在保存进度"的即时反馈，但它**不是失败**——
        // 后端随后会发 checkpoint_available 让前端渲染"继续"。此处不写 ❌ 文案。
        aiStatus.value = 'chat.statusPausing'
        aiStatusTarget.value = ''
        break
      }
      if (data.retrying) {
        msg.retrying = data.message || t('chat.retrying')
        aiStatus.value = 'chat.statusRetrying'
      } else {
        // 2026-09-24 修复：**不再用错误文本覆盖 content**。
        // content 是对外唯一真相（复制/导出/搜索/重载对账都读它），覆盖成 `❌ …` 会把
        // "本轮已经产出的答案"在重载时整体顶掉（永久数据丢失）。有正文时错误改挂 stopReason 横幅。
        const hadText = !!lastAnswerText(msg.flow).trim()
        markAllThinkingDone(msg)
        aiStatus.value = null
        aiStatusTarget.value = ''
        if (!hadText) {
          msg.content = `❌ ${data.message}`
        } else {
          msg.stopReason = { reason: 'error', message: data.message || t('chat.stopReasonDefault') }
          void flushed.then(() => {
            // 等打字机刷完再取：保持 content == flow 末段（对账不变量）
            const tail = lastAnswerText(msg.flow)
            msg.content = tail.trim() ? tail : `❌ ${data.message}`
          })
        }
      }
      break
    }
  }
}

/** 将最后一个 thinking 节点标记为完成（内容产出或结束时） */

/** 工具确认：提交 allow/deny 决策到后端（后端 waitForToolConfirmation 真实拦截，超时自动拒绝） */
function onToolAllow(tc: ToolCallEvent) {
  tc.status = 'running'
  fetch('/api/chat/tool-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolCallId: tc.id, decision: 'allow', sessionId: chatStore.currentSession?.id }),
  }).catch(() => {})
}
function onToolDeny(tc: ToolCallEvent) {
  tc.status = 'error'
  tc.result = t('chat.userDenied')
  fetch('/api/chat/tool-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolCallId: tc.id, decision: 'deny', sessionId: chatStore.currentSession?.id }),
  }).catch(() => {})
}
/** 本会话全部允许：记录会话级授权并放行当前工具，之后本对话内敏感工具不再询问 */
function onToolAllowSession(tc: ToolCallEvent) {
  tc.status = 'running'
  fetch('/api/chat/tool-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolCallId: tc.id, decision: 'allow-session', sessionId: chatStore.currentSession?.id, toolName: tc.name }),
  }).catch(() => {})
}

/**
 * 简单聊天模式 — 默认 /api/chat/stream 原始 SSE 流式；设置关闭"流式响应"时走非流式 /api/chat
 */
async function sendSimpleStream(assistantMsg: ChatMessage, apiMessages: Array<{ role: string; content: string }>) {
  // 关闭流式：一次性拿完整回复（无打字机）
  if (!appStore.streamingEnabled) {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: apiMessages, model: appStore.currentModel }),
      signal: abortController.value!.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    const data = await res.json()
    const cur = messages.value.find((m) => m.id === assistantMsg.id)
    if (cur && data.content) cur.content = data.content
    // 非流式拿到完整回复 → 提示音 + 自动朗读（走到这里即 HTTP 2xx，视为成功）
    finishTurn(assistantMsg, true)
    return
  }

  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: apiMessages, model: appStore.currentModel }),
    signal: abortController.value!.signal,
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  // 简单模式同样用统一打字机引擎（防一次性出结果；content 直拼不走 flow）
  let pendingSimple = ''
  let simpleTw = createTypewriterState()
  let simpleTimer: ReturnType<typeof setTimeout> | null = null
  const flushSimple = () => {
    simpleTimer = null
    if (!pendingSimple) { simpleTw = createTypewriterState(); return }
    const next = advanceReveal(simpleTw, pendingSimple.length, pendingSimple, DEFAULT_TYPING_CONFIG)
    const take = Math.max(0, next.displayLength - simpleTw.displayLength)
    simpleTw = { displayLength: 0, emaLag: next.emaLag }
    if (take > 0) {
      const text = pendingSimple.slice(0, take)
      pendingSimple = pendingSimple.slice(take)
      const cur = messages.value.find((m) => m.id === assistantMsg.id)
      if (cur) cur.content += text
    }
    if (pendingSimple) simpleTimer = setTimeout(flushSimple, DEFAULT_TYPING_CONFIG.targetIntervalMs)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data)
          // 真实 token 用量（流式结束时的 usage 字段）
          if (chunk.usage?.total_tokens) {
            assistantMsg.tokenCount = chunk.usage.total_tokens
            assistantMsg.promptTokens = chunk.usage.prompt_tokens || 0
            assistantMsg.completionTokens = chunk.usage.completion_tokens || 0
          }
          const content = chunk.choices?.[0]?.delta?.content
          if (content) {
            pendingSimple += content
            if (!simpleTimer) simpleTimer = setTimeout(flushSimple, DEFAULT_TYPING_CONFIG.targetIntervalMs)
          }
        } catch {}
      }
    }
  }
  if (simpleTimer) { clearTimeout(simpleTimer); simpleTimer = null }
  // 收尾：强制一次性清空（内容完整性优先）
  if (pendingSimple) {
    const cur = messages.value.find((m) => m.id === assistantMsg.id)
    if (cur) cur.content += pendingSimple
    pendingSimple = ''
  }
  // 流读完（未抛异常即未中断）→ 提示音 + 自动朗读
  finishTurn(assistantMsg, true)
}

onMounted(async () => {
  await chatStore.loadSessions()
  // 刷新后 currentSessionId 从 localStorage 恢复（值未变化 → watch 不触发），
  // 需显式同步一次：恢复产物区/权限/工作目录，避免"消息有了但产物空"
  syncSessionUI()
  // 不自动创建会话：保持欢迎页草稿态（resetToWelcome 置 null），
  // 用户发送第一条消息时 doSend 里才真正 createSession，避免空"新对话"堆积

  // ---- Deep Links 深链接（学 Grok）：URL 参数 / postMessage 唤起 ----
  const applyDeepLink = (action: { q?: string; session?: string; workspace?: string }) => {
    if (action.workspace) {
      localStorage.setItem('supercrzy:workspace', action.workspace)
      chatStore.notifyWorkspaceChanged()
    }
    if (action.session) {
      const s = chatStore.sessions.find((x) => x.id === action.session)
      if (s) chatStore.selectSession(s.id)
    }
    if (action.q) {
      inputText.value = action.q
      nextTick(() => inputRef.value?.focus())
    }
    // 清除 URL 参数，避免刷新重复触发
    if (window.location.search) {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }
  applyDeepLink(parseDeepLinkFromURL())
  registerDeepLinkListener(applyDeepLink)
})
</script>

<style scoped>
/* ---- Agent 过程展示（技能/Planner/重试/交付摘要） ---- */
.skill-match-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0;
}

.role-routed-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}
.role-tag {
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.12);
  color: #0d9488;
  border: 1px solid rgba(16, 185, 129, 0.3);
  font-weight: 500;
}
.role-keyword {
  font-size: 11px;
  color: var(--text-muted);
}

.skill-tag {
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--accent-muted, rgba(129, 140, 248, 0.12));
  color: var(--accent);
  border: 1px solid var(--border-color);
}

.playbook-row {
  padding: 2px 0;
}
.playbook-tip {
  font-size: 11px;
  color: var(--success, #22c55e);
  background: rgba(34, 197, 94, 0.08);
  border-left: 2px solid var(--success, #22c55e);
  padding: 4px 8px;
  margin: 2px 0;
  border-radius: 0 6px 6px 0;
}

.planner-card {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-tertiary);
}

/* 过程折叠条：总结开始后思考/工具收拢成一行摘要，点击展开/收起 */
.process-collapse-bar {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0 6px;
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11.5px;
  cursor: pointer;
  user-select: none;
  transition: border-color var(--duration-fast), color var(--duration-fast), background var(--duration-fast);
}
.process-collapse-bar:hover {
  border-color: var(--accent);
  color: var(--text-primary);
  background: var(--bg-hover);
}
.process-collapse-bar svg { flex-shrink: 0; }
.process-collapse-bar .pc-label { font-weight: 500; }
.process-collapse-bar .pc-summary { color: var(--text-secondary); font-weight: 500; }
.process-collapse-bar .pc-duration { color: var(--text-muted); }
.process-collapse-bar .pc-duration::before { content: '·'; margin-right: 6px; }

/* 结构化停止原因横幅（轮次超限等：明确告知为什么停） */
.stop-reason-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0 8px;
  padding: 6px 10px;
  border: 1px solid var(--warning-border, var(--border-color));
  border-radius: 6px;
  background: var(--bg-warning, var(--bg-tertiary));
  color: var(--text-warning, var(--text-secondary));
  font-size: 12px;
  line-height: 1.5;
}
.stop-reason-banner svg { flex-shrink: 0; color: var(--warning); }
.sr-text { flex: 1; min-width: 0; }
.sr-checkpoint {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg-secondary);
  border: 0.5px solid var(--border-color);
  border-radius: 4px;
  padding: 1px 6px;
  flex-shrink: 0;
}
.process-collapse-bar .pc-arrow {
  transition: transform var(--duration-fast);
}
.process-collapse-bar.open .pc-arrow {
  transform: rotate(180deg);
}

/* Routine 推荐卡片（AI 主动建议保存为可复用流程） */
.routine-suggest {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px dashed var(--accent);
  border-radius: 10px;
  background: var(--accent-muted, color-mix(in srgb, var(--accent) 6%, transparent));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.rs-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rs-title { font-size: 13px; font-weight: 600; color: var(--accent); }
.rs-desc { font-size: 11.5px; color: var(--text-secondary); }
.rs-actions { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }

.planner-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--text-secondary);
}

.planner-step {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
  padding-left: 4px;
}

.retry-hint {
  font-size: 12px;
  color: var(--warning, #eab308);
  padding: 4px 0;
}

/* ---- P1-05 任务交付页 ---- */
.ds-head {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; line-height: 1.5;
  padding: 6px 8px; margin-bottom: 8px;
  border-radius: 7px;
  background: var(--bg-secondary, rgba(127,127,127,.07));
}
.ds-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; background: #2fa36b; }
.ds-head--cancelled .ds-dot { background: #9aa0ab; }
.ds-head--failed .ds-dot { background: #d9534f; }
.ds-status { font-weight: 600; color: var(--text-primary); flex: 0 0 auto; }
.ds-summary-text { color: var(--text-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ds-changes {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
  margin-top: 8px; font-size: 11px;
}
.ds-changes-label { color: var(--text-secondary); }
.ds-change {
  padding: 1px 6px; border-radius: 5px;
  background: var(--bg-secondary, rgba(127,127,127,.1));
  color: var(--text-primary);
  font-family: var(--font-mono, ui-monospace, monospace);
  max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ds-change-more { color: var(--text-secondary); }
.ds-stats {
  display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
  margin-top: 8px; font-size: 11px; color: var(--text-tertiary, var(--text-secondary));
}
.ds-next {
  display: flex; align-items: center; gap: 6px;
  margin-top: 8px; font-size: 11px; color: var(--text-secondary);
}
.ds-ckpt {
  font-family: var(--font-mono, ui-monospace, monospace);
  padding: 1px 5px; border-radius: 4px;
  background: var(--bg-secondary, rgba(127,127,127,.1));
  font-size: 10px;
}
.delivery-summary {
  margin: 10px 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-tertiary);
}

.ds-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-primary);
}
.ds-title svg { color: var(--accent); }
.ds-title-toggle { cursor: pointer; user-select: none; }
.ds-title-toggle:hover { color: var(--accent); }
.ds-toggle-arrow { transition: transform var(--duration-fast, 0.15s); }
.ds-toggle-arrow.open { transform: rotate(180deg); }
/* 折叠态"展开全部"入口 */
.ds-more {
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
  padding: 4px 2px;
  user-select: none;
}
.ds-more:hover { text-decoration: underline; }

/* 产物卡片行（对标 WorkBuddy artifact-slot） */
.ds-cards {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ds-card {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 9px;
  border: 0.5px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-primary);
  transition: border-color var(--duration-fast);
}
.ds-card:hover {
  border-color: var(--accent);
}
.ds-card-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--bg-secondary);
  color: var(--accent);
}
.ds-card-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ds-card-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-card-path {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-card-open {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.ds-card-open:hover {
  background: var(--bg-hover);
  color: var(--accent);
}

/* AI 画图卡片（P0）：白底内联 SVG，适配深浅主题 */
.diagram-list { margin: 10px 0; display: flex; flex-direction: column; gap: 8px; }
.diagram-card {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}
.diagram-card:hover {
  border-color: var(--accent);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}
.diagram-card .diagram-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.dt-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dt-zoom {
  display: inline-flex;
  align-items: center;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.diagram-card:hover .dt-zoom {
  opacity: 1;
  color: var(--accent);
}
.diagram-title {
  font-size: 12px;
  font-weight: 500;
  padding: 6px 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
  background: #fafafa;
}
.diagram-body { padding: 10px; overflow-x: auto; }
.diagram-body svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
.diagram-body text { fill: #333; }
.diagram-body text,
.diagram-body .t,
.diagram-body .ts,
.diagram-body .th { font-family: inherit; }

.chat-container {
  display: flex;
  flex-direction: column;
  height: 100%; /* 不能用 100vh：桌面端顶部 56px 横栏会把它挤出可视区，底部输入框被裁 */
  position: relative; /* 任务进度胶囊 absolute 定位基准（Web 落在 header 右上、App 顶部右上，两端都可见） */
}

/* ===== Header ===== */
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;          /* 与侧边栏 header（14+28+14）对称 */
  min-height: 56px;
  box-sizing: border-box;
  padding: 0 20px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-primary);
  flex-shrink: 0;
}

.chat-title-area {
  display: flex;
  align-items: center;
  gap: 10px;
}

.chat-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 右侧面板开关（分享后）：active 高亮与侧边栏 theme-toggle 一致 */
.header-panel-btn.active {
  color: var(--accent);
}

/* 产物文件夹按钮 + 数量角标 */
.header-artifacts-btn {
  position: relative;
}
.artifact-count {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  box-sizing: border-box;
}

/* 产物弹层 */
.artifacts-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
}

/* ===== 对话分享菜单（fixed 右上角，Web header / App 横栏共用） ===== */
.share-overlay {
  position: fixed;
  inset: 0;
  z-index: 910;
}
.share-menu {
  position: absolute;
  top: 64px;
  right: 16px;
  width: 208px;
  background: var(--bg-primary);
  border: 0.5px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.14);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.share-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: background var(--duration-fast);
}
.share-item:hover {
  background: var(--bg-hover);
}
.share-item svg {
  color: var(--text-secondary);
  flex-shrink: 0;
}
.artifacts-pop {
  position: absolute;
  top: 64px;
  right: 16px;
  width: min(440px, 92vw);
  max-height: 60vh;
  background: var(--bg-primary);
  border: 0.5px solid var(--border-color);
  border-radius: 14px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.14);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.ap-pop-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 14px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
  border-bottom: 0.5px solid var(--border-color);
  background: var(--bg-secondary);
}
.ap-pop-list {
  overflow-y: auto;
  max-height: 50vh;
  min-height: 0; /* flex column 子项（.sa-list）：允许压缩，产物多时内部滚动才生效（否则被外层 overflow:hidden 裁剪） */
}
.ap-pop-empty {
  padding: 26px 0;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-muted);
}

/* ===== Messages ===== */
.messages-area {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  position: relative;
}

/* 快速回底按钮：右下角浮动，离开底部出现、贴底自动隐藏 */
.scroll-bottom-btn {
  /* sticky 悬浮在消息区（滚动容器）视口右下角：float 靠右 + bottom 吸底，不随内容滚动 */
  position: sticky;
  bottom: 20px;
  float: right;
  margin: 4px 20px 4px 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.14);
  z-index: 30;
  padding: 0;
}
.scroll-bottom-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--bg-hover);
}
/* 贴底弱化：已到底时半透明提示（按钮仍固定可见），离开底部恢复高亮 */
.scroll-bottom-btn.atBottom {
  opacity: 0.5;
}
.scroll-bottom-btn.atBottom:hover {
  opacity: 1;
}
.scroll-fade-enter-active,
.scroll-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.scroll-fade-enter-from,
.scroll-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.welcome-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  gap: 16px;
}

.welcome-logo {
  width: 72px;
  height: 72px;
  border-radius: 20px;
  object-fit: contain;
  padding: 8px;
  background: #ffffff; /* 浅色模式纯白底 */
  box-shadow: 0 8px 24px rgba(224, 32, 32, 0.25);
}

.dark .welcome-logo {
  background: #000000; /* 深色模式纯黑底 */
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

.welcome-title {
  font-size: 24px;
  font-weight: 700;
  margin: 0;
}

/* 品牌行：前缀 + SUPERCRZY + BOT 徽章 垂直居中 */
.welcome-brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  line-height: 1.4;
}

/* SUPERCRZY 品牌字与侧边栏一致（Saira Stencil One 显示字体） */
.welcome-brand .brand-name {
  font-family: 'Saira Stencil One', sans-serif;
  letter-spacing: 1px;
}

.welcome-key-hint {
  margin-top: 16px;
  font-size: 13px;
  position: relative;
  background: var(--bg-secondary, #f7f7f8);
  border: 1px solid var(--border, #e3e3e6);
  border-radius: 12px;
  padding: 14px 18px 16px;
  max-width: 420px;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.key-guide-close {
  position: absolute; top: 8px; right: 8px;
  background: transparent; border: none; color: var(--text-muted, #999);
  cursor: pointer; padding: 4px; display: flex;
}
.key-guide-close:hover { color: var(--text-primary, #222); }
.key-guide-title { font-size: 14px; font-weight: 500; color: var(--text-primary, #222); }
.key-guide-steps { display: flex; flex-direction: column; gap: 5px; }
.key-guide-step { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary, #555); }
.kg-n {
  width: 18px; height: 18px; border-radius: 9px; flex-shrink: 0;
  background: var(--accent, #4f7cff); color: #fff; font-size: 11px;
  display: inline-flex; align-items: center; justify-content: center;
}
.key-guide-btn {
  margin-top: 4px; align-self: flex-start;
  color: #fff; text-decoration: none;
  background: var(--accent, #4f7cff);
  border-radius: 20px;
  padding: 6px 18px;
  font-size: 13px;
}
.key-guide-btn:hover { opacity: 0.92; }
.welcome-subtitle {
  font-size: 14px;
  color: var(--text-secondary);
  max-width: 420px;
  line-height: 1.6;
  margin: 0;
}

/* 工作目录输入行（输入区侧边展开，会话级） */

/* ============ 欢迎页中央输入框 ============ */
.welcome-composer {
  width: min(640px, 92%);
  margin: 26px auto 0;
}
.wc-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}
.wc-plus-wrap {
  position: relative;
  flex-shrink: 0;
  margin-bottom: 2px;
}
.wc-plus {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 0.5px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--duration-fast);
}
.wc-plus:hover,
.wc-plus.open {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-muted, color-mix(in srgb, var(--accent) 10%, transparent));
}
.wc-popover {
  position: absolute;
  left: 0;
  bottom: 46px;
  width: 172px;
  background: var(--bg-primary);
  border: 0.5px solid var(--border-color);
  border-radius: 12px;
  padding: 6px;
  z-index: 50;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
}
.wc-pop-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--duration-fast);
}
.wc-pop-item:hover {
  background: var(--bg-hover);
}
.wc-input-box {
  flex: 1;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--bg-primary);
  transition: border-color var(--duration-fast);
}
/* 聚焦不改变边框颜色（老板 2026-08-21：聚焦边框变化不需要，保持常态一致） */
.wc-input {
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font-family: inherit;
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--text-primary);
  padding: 14px 16px;
  min-height: 68px;
  max-height: 168px;
  box-sizing: border-box;
}
.wc-input::placeholder {
  color: var(--text-muted);
}
.wc-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px 10px;
  justify-content: flex-end;
}
.wc-model {
  max-width: 180px;
}
.wc-icon-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--duration-fast);
}
.wc-icon-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
/* 录音中：红色脉冲提示 */
.wc-icon-btn.listening {
  color: #fff;
  background: var(--error, #ef4444);
  animation: voice-pulse 1.2s ease-in-out infinite;
}
@keyframes voice-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.45); }
  50% { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
}
/* 暂停按钮（阶段二-②）：常态为中性图标；已请求暂停时转为等待态并禁用重复点击 */
.pause-btn.is-pausing {
  color: var(--warning, #f59e0b);
  background: var(--bg-hover);
  cursor: default;
  opacity: 0.7;
}
.pause-btn:disabled { pointer-events: none; }
.wc-send {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: var(--accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity var(--duration-fast);
}
.wc-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.wc-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.wc-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  padding: 4px 8px 4px 9px;
  border-radius: 999px;
  border: 0.5px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.wc-chip-x {
  display: inline-flex;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 1px;
}
.wc-chip-x:hover {
  color: var(--error);
}
.wc-config-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 14px;
  flex-wrap: wrap;
  /* 居中基准对齐输入框：wc-row 左侧是 ➕(38px)+gap(10px)=48px，输入框中心比页面中心偏右 24px；
     配置行加同宽左内边距后，内容居中于输入框区域，与输入框中心对齐 */
  padding-left: 48px;
}
/* 任务设置折叠（欢迎页密度优化：工作文件夹+权限收进抽屉，默认收起） */
.wc-settings {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.wc-settings-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--duration-fast), color var(--duration-fast);
}
.wc-settings-toggle:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}
.wc-settings-label {
  font-weight: 500;
}
.wc-settings-summary {
  font-size: 11px;
  color: var(--text-muted);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wc-settings-arrow {
  transition: transform var(--duration-fast) var(--ease-out);
}
.wc-settings-arrow.open {
  transform: rotate(180deg);
}
.wc-config {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 13px;
  border-radius: 10px;
  border: 0.5px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color var(--duration-fast);
}
.wc-config:hover {
  border-color: var(--border-color-strong, var(--accent));
}
.wc-config.set {
  border-color: var(--accent);
  color: var(--accent);
}
.wc-config-label {
  color: var(--text-muted);
}
.wc-config-val {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12px;
}
.wc-caret {
  transition: transform var(--duration-fast);
}
.wc-caret.up {
  transform: rotate(180deg);
}
.wc-perm {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 10px 0 13px;
  border-radius: 10px;
  border: 0.5px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12.5px;
}
.wc-perm-select {
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12.5px;
  cursor: pointer;
  max-width: 150px;
}
.wc-workspace-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 7px 10px;
  border: 0.5px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
}
.wc-skill-panel {
  margin-top: 12px;
  border: 0.5px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-primary);
  padding: 12px;
  max-height: 240px;
  overflow-y: auto;
}
.wc-skill-head {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 10px;
}
.wc-skill-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}
.wc-skill-item {
  border: 0.5px solid var(--border-color);
  border-radius: 10px;
  padding: 9px 11px;
  cursor: pointer;
  transition: all var(--duration-fast);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.wc-skill-item:hover {
  border-color: var(--accent);
}
.wc-skill-item.picked {
  border-color: var(--accent);
  background: var(--accent-muted, color-mix(in srgb, var(--accent) 8%, transparent));
}
.wc-skill-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
}
.wc-skill-desc {
  font-size: 11.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wc-skill-empty {
  font-size: 12.5px;
  color: var(--text-muted);
  padding: 14px 0;
  text-align: center;
  grid-column: 1 / -1;
}

.workspace-browse:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* ============ 会话产物（横栏弹出层） ============ */
.sa-list {
  display: flex;
  flex-direction: column;
}
.sa-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  font-size: 12.5px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--duration-fast);
}
.sa-item:hover {
  background: var(--bg-hover);
}
.sa-file-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}
.sa-name {
  font-family: var(--font-mono);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
}
.sa-badge {
  flex-shrink: 0;
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
}
.sa-badge.created {
  background: var(--accent-muted, color-mix(in srgb, var(--accent) 12%, transparent));
  color: var(--accent);
}
.sa-badge.updated {
  background: var(--warning-muted, color-mix(in srgb, var(--warning) 12%, transparent));
  color: var(--warning);
}
.sa-size {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.sa-time {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
  width: 42px;
  text-align: right;
}
.sa-open {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sa-open:hover {
  color: var(--accent);
  background: var(--accent-muted, color-mix(in srgb, var(--accent) 10%, transparent));
}
.ap-modal {
  width: min(680px, 92vw);
  max-height: 75vh;
}
.ap-name {
  font-family: var(--font-mono);
  font-size: 13px;
}
.ap-path {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  word-break: break-all;
}
.ap-content {
  margin: 0;
  overflow: auto;
  max-height: 58vh;
  padding: 12px;
  border-radius: 10px;
  background: var(--bg-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
}
.ap-fail {
  padding: 30px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
}

.message-wrapper {
  margin-bottom: 12px;
}
/* 按天分隔线（2026-08-27 加：历史消息按日期分组） */
.day-divider {
  display: flex;
  align-items: center;
  margin: 4px 0 10px;
  font-size: 11px;
  color: var(--text-muted, var(--text-secondary));
}
.day-divider::before,
.day-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-color);
  opacity: 0.5;
}
.day-divider span {
  padding: 0 12px;
  background: var(--bg-tertiary, transparent);
}
/* 产物联动高亮：定位到目标消息时短暂闪光 */
.message-wrapper.msg-focused {
  animation: msg-focus-flash 2.2s ease;
}
@keyframes msg-focus-flash {
  0% { background: color-mix(in srgb, var(--accent, #4f7cff) 22%, transparent); border-radius: 10px; }
  60% { background: color-mix(in srgb, var(--accent, #4f7cff) 12%, transparent); border-radius: 10px; }
  100% { background: transparent; }
}
/* 紧凑模式：压缩消息间距 */
.message-wrapper.compact {
  margin-bottom: 4px;
}
.message-wrapper.compact .message-body {
  margin-top: 2px;
}

.message {
  max-width: 800px;
  margin: 0 auto;
}

/* ===== 气泡聊天布局：用户右侧 / AI 左侧 ===== */
.message.user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.message.assistant {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
  padding: 0 6px;
}
/* 消息引用按钮（hover 显示） */
.message-quote-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.message-header:hover .message-quote-btn { opacity: 1; }
.message-quote-btn:hover { background: var(--bg-hover, rgba(127,127,127,0.12)); color: var(--accent, #4f7cff); }

/* 用户消息：头像与标题在右侧（镜像排列） */
.message.user .message-header {
  flex-direction: row-reverse;
}

.message.user .message-meta {
  justify-content: flex-end;
}

.message-avatar {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
}

/* TurnFoldAvatar（WorkBuddy 同款）：AI 轮次头像可点击切换折叠，耗时独立显示在头像下方 */
.avatar-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.message-avatar.turn-foldable {
  cursor: pointer;
}
.message-avatar.turn-foldable:hover {
  outline: 2px solid var(--accent, #6366f1);
  outline-offset: 2px;
}
.avatar-logo {
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 3px;
  background: #ffffff; /* 浅色模式纯白底 */
  border-radius: 7px;
}

.dark .avatar-logo {
  background: #000000; /* 深色模式纯黑底 */
}

.avatar-user {
  font-size: 11px;
  font-weight: 700;
}

.message.user .message-avatar {
  background: linear-gradient(135deg, #4F46E5, #6366F1);
  color: white;
}

/* 2026-08-29 超级协作平台：多 AI 角色的图标头像（执行/质检/议院等） */
.actor-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

/* assistant 头像由 LOGO 图片自带主题背景（纯白/纯黑），无需渐变底色 */
.message.assistant .message-avatar {
  background: transparent;
  color: white;
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.message-role {
  font-size: 13px;
  font-weight: 600;
}

.message-time {
  font-size: 11px;
  color: var(--text-muted);
}

.message-body {
  max-width: 92%;
  padding: 10px 14px;
  border-radius: 14px;
  line-height: 1.7;
}

/* 用户消息：品牌色气泡 + 白字 */
.message.user .message-body {
  background: linear-gradient(135deg, #4F46E5, #6366F1);
  color: #ffffff;
  border-bottom-right-radius: 4px;
}
.message.user .message-content {
  color: #ffffff;
}

.message.user .message-content :deep(p code) {
  background: rgba(255, 255, 255, 0.2);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.25);
}

.message.user .message-content :deep(blockquote) {
  border-left-color: rgba(255, 255, 255, 0.6);
  color: rgba(255, 255, 255, 0.9);
}

.message.user .message-content :deep(th), .message.user .message-content :deep(td) {
  border-color: rgba(255, 255, 255, 0.3);
}

/* AI 消息：改无边框平铺（2026-08-26 老板要求"去掉灰色线框"——原为 浅灰气泡+灰边框+圆角，
   高度随内容伸缩；改为无背景无边框的平铺正文，从根上消除"灰框随内容伸缩"的视觉） */
.message.assistant .message-body {
  padding: 2px 6px;              /* 平铺：仅保留极窄水平留白，无气泡底/无边框/无圆角 */
  max-width: 100%;
  /* 2026-09-25 修：父 .message.assistant 是 flex column + align-items:flex-start ⇒ 子项 shrink-to-fit，
     流式开始时正文还没内容，第一个框（骨架屏/过程状态条）被收缩成内容宽（实测 78~92px），
     视觉上"思考框只显示一半"（老板报障）。AI 平铺消息本就该全宽 → 显式撑满。 */
  width: 100%;
  background: transparent;
  border: none;
  border-radius: 0;
}

/* 用户消息的卡片类子组件（技能/经验/思考等）保持可读 */
.message.user .skill-tag,
.message.user .playbook-tip,
.message.user .role-tag {
  color: #fff;
  border-color: rgba(255, 255, 255, 0.35);
}

/* ===== Attachments in messages ===== */
.message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.attachment-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
  max-width: 180px;
  background: var(--bg-secondary);
}

.attachment-card:hover {
  border-color: var(--accent);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.attachment-preview {
  width: 180px;
  height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
  overflow: hidden;
}

.attachment-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.attachment-file-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.attachment-info {
  padding: 6px 10px 8px;
  text-align: center;
  width: 100%;
}

.attachment-name {
  font-size: 11px;
  font-weight: 500;
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}

.attachment-size {
  font-size: 10px;
  color: var(--text-muted);
}
.ocr-badge {
  font-size: 10px;
  color: #22c55e;
  border: 1px solid rgba(34, 197, 94, 0.4);
  border-radius: 10px;
  padding: 1px 8px;
  cursor: help;
  white-space: nowrap;
}

/* ===== File preview in input ===== */
/* 引用块（输入框上方） */
.quote-block {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 12px;
  border: 1px solid var(--border-color);
  border-left: 3px solid var(--accent, #4f7cff);
  border-radius: 12px;
  background: var(--bg-tertiary, rgba(127,127,127,0.05));
  margin-bottom: 6px;
}
.quote-block-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
}
.quote-block-label { color: var(--accent, #4f7cff); font-weight: 500; }
.quote-block-remove {
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.quote-block-remove:hover { background: var(--bg-hover, rgba(127,127,127,0.12)); color: var(--danger, #ef4444); }
.quote-block-text {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  /* 老板要求：引用内容只显示 1 行，超出省略号 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 选中文本引用浮动按钮 */
.sel-quote-btn {
  position: fixed;
  z-index: 300;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-color);
  background: var(--bg-input, rgba(127,127,127,0.12));
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}
.sel-quote-btn:hover { color: var(--accent, #4f7cff); border-color: var(--accent, #4f7cff); }
/* 输入触发菜单（/ 与 @ 统一选择器） */
.trigger-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  z-index: 120;
  width: min(420px, 100%);
  background: var(--bg-input, #fff);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14);
  padding: 4px;
  margin-bottom: 6px;
}
/* 候选搜索框（固定在顶部，列表独立滚动） */
.trigger-search-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  margin-bottom: 4px;
  border: 1px solid var(--border-input);
  border-radius: 7px;
  color: var(--text-muted);
  background: var(--bg-tertiary, rgba(127,127,127,0.05));
}
.trigger-search-row:focus-within { border-color: var(--accent, #4f7cff); }
.trigger-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-color);
  font-size: 12px;
}
.trigger-list {
  max-height: 240px;
  overflow-y: auto;
}
.trigger-empty {
  padding: 14px 9px;
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
}
/* 引用产物选择面板（复用 trigger-menu 定位/样式） */
.artifact-picker { width: min(360px, 100%); }
.artifact-picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
}
.artifact-picker-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  border-radius: 4px;
}
.artifact-picker-close:hover { color: var(--text-color); background: var(--bg-hover, rgba(127,127,127,0.1)); }
.trigger-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border-radius: 7px;
  cursor: pointer;
}
.trigger-item.active { background: color-mix(in srgb, var(--accent, #4f7cff) 14%, transparent); }
.trigger-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-color);
  font-family: var(--font-mono);
  white-space: nowrap;
}
.trigger-desc {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trigger-section {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-hover, rgba(127,127,127,0.1));
  border-radius: 8px;
  padding: 1px 7px;
  white-space: nowrap;
}
.file-preview-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  padding: 6px;
  border-radius: 8px;
  background: var(--bg-secondary);
}

.file-preview-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  font-size: 12px;
}

.file-preview-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
}
/* 图片缩略图（老板要求：上传图片显示实际缩略图而非图标） */
.file-preview-thumb {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}

.file-preview-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.file-preview-size {
  color: var(--text-muted);
  font-size: 10px;
  flex-shrink: 0;
}

.file-preview-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-muted);
  transition: background 0.15s, color 0.15s;
  flex-shrink: 0;
  padding: 0;
}

.file-preview-remove:hover {
  background: #fee2e2;
  color: #ef4444;
}

/* ===== Upload Button ===== */
.upload-button {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  flex-shrink: 0;
  color: var(--text-secondary);
}

.upload-button:hover {
  background: var(--bg-primary);
  border-color: var(--accent);
  color: var(--accent);
}
/* 录音中：红色脉冲提示（与欢迎页语音按钮一致） */
.upload-button.listening {
  color: #fff;
  background: var(--error, #ef4444);
  border-color: var(--error, #ef4444);
  animation: voice-pulse 1.2s ease-in-out infinite;
}

.upload-button.disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

/* ===== 已删除：55 行 `.message-content*` 死样式（2026-09-24）=====
   组件化后正文由 MessageFlowRenderer 渲染，`class="message-content"` 全仓只出现在该组件模板里
   （MessageFlowRenderer.vue:33 / :114），**不在 ChatView 模板中** → 选择器 `.message-content[data-v-<ChatView>]`
   永不匹配，故这 55 行为死代码（Vue scoped 样式不会作用到子组件内部元素；子组件只有**根元素**会继承父 scope id，
   而根元素是 `.msg-flow-renderer`）。
   正文样式（pre / code / table / blockquote / 列表）一律改 MessageFlowRenderer.vue 的**全局** style 块。
   教训：留死样式 = 改一处不生效。本次"长 token 撑破气泡"正是这个结构的产物 ——
   生效的 pre 规则漏了 `overflow-x`，而带 `overflow-x: auto` 的那份（原此处 :4794）是死的。 */

.message-tokens {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 8px;
}
/* 任务完成耗时徽标样式已随组件迁入 ElapsedBadge.vue（scoped） */

/* 多步骤计划卡片 */
/* 消息操作工具栏 */
.message-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 6px;
  opacity: 0;
  transition: opacity .15s ease;
  min-height: 22px;
}
.message:hover .message-actions { opacity: 1; }
/* AI 消息操作条常显（2026-09-26 老板要求 + WB 取证对齐：lib-chat-ui.css:21701
   ._assistantFeedback_ { visibility: visible }——AI 侧复制/点赞/更多全显不藏，
   用户消息侧 WB 实测仍是 hover 显，保持一致） */
.message.assistant .message-actions { opacity: 1; }
.msg-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: background .15s, color .15s;
}
.msg-action:hover { background: var(--bg-hover, rgba(128,128,128,.1)); color: var(--text-primary); }
.msg-action.active { color: #6366f1; }
.msg-action span { line-height: 1; }
.msg-more-wrap { position: relative; }
.msg-menu {
  position: absolute;
  bottom: 100%;
  right: 0;
  z-index: 20;
  min-width: 140px;
  padding: 4px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,.12);
}
.msg-menu-item {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.msg-menu-item:hover { background: var(--bg-hover, rgba(128,128,128,.1)); }
.msg-menu-item.danger { color: var(--danger, #ef4444); }
.msg-menu-item.danger:hover { background: rgba(239,68,68,.1); }

/* 代码块复制按钮样式已移至 MessageFlowRenderer 全局样式块（动态注入 DOM 无 scope，scoped 匹配不到） */

/* ===== Typing indicator ===== */
.typing-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
}
.typing-indicator .typing-text {
  font-size: 12px;
  color: var(--text-muted);
  margin-left: 2px;
}

.typing-indicator .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: typing 1.4s infinite ease-in-out;
}

.typing-indicator .dot:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator .dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes typing {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-8px); opacity: 1; }
}

/* ===== Input ===== */
.input-area {
  /* v4：去掉顶部分割线（输入卡直接浮在页面上，对齐 WorkBuddy） */
  background: var(--bg-primary);
  flex-shrink: 0;
}

/* 输入高度记忆（对齐 WorkBuddy resize-handle）：自定义高度时固定 textarea 高度（仅 chat-input-fixed 生效，不破坏 autosize；textarea 是 n-input 深层元素需 :deep） */
.chat-input-fixed :deep(textarea) {
  height: var(--chat-input-h) !important;
}
/* 拖拽手柄：输入区最底部一条明显的横杠把手（常驻深色可见，鼠标变上下箭头提示可拖） */
.chat-resize-handle {
  height: 14px;
  cursor: ns-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: background 0.15s;
}
.chat-resize-handle::after {
  content: '';
  width: 64px;
  height: 5px;
  border-radius: 3px;
  background: rgba(128, 128, 128, 0.55);
  transition: background 0.15s;
}
.chat-resize-handle:hover {
  background: rgba(128, 128, 128, 0.08);
}
.chat-resize-handle:hover::after {
  background: var(--accent, #4f8cff);
}

.composer-card {
  max-width: 800px;
  margin: 0 auto;
  padding: 8px 10px;
  position: relative;
  background: var(--bg-primary);
  border: 1px solid var(--border-input);
  border-radius: 22px;
  box-shadow: 0 1px 2px rgba(20,30,60,0.04), 0 6px 24px rgba(20,30,60,0.05);
  transition: border-color 0.2s, box-shadow 0.2s;
}
/* 聚焦光晕（Perplexity 同款：:focus-within 无需 JS，输入卡聚焦时外圈 accent 光圈） */
.composer-card:focus-within {
  border-color: var(--accent, #4f8cff);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent, #4f8cff) 14%, transparent), 0 8px 32px rgba(20,30,60,0.08);
}

/* 宠物：踩在输入区顶部边缘"分割线"上散步（身体主体在对话区侧、脚贴线；位置/朝向由组件 JS 驱动） */
.composer-pet {
  position: absolute;
  top: -24px;
  z-index: 4;
  pointer-events: auto;
}

.input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}

.chat-input {
  flex: 1;
  /* v4 输入卡：.chat-input 就是 n-input 本身，naive-ui 灰底(244,244,245)由 --n-color 控制 → 透明 */
  --n-color: transparent !important;
  background: transparent !important;
}
/* 兜底：textArea 包装层也透明 */
.chat-input :deep(.n-input__textarea) { background: transparent !important; }
/* 光标左距：naive-ui .n-input-wrapper 自带 12px 左 padding → 归零（老板：太宽） */
.chat-input :deep(.n-input-wrapper) { padding-left: 0 !important; }
/* 聊天页输入框视觉统一（欢迎页 wc-input-box 同款 16px 圆角大框；纯样式覆盖 n-input，不改布局） */
.chat-input :deep(.n-input__textarea) {
  /* v4 输入卡：输入区透明融入卡片（无灰底无边框，卡片即边界，最干净） */
  border-radius: 0;
  border: none;
  background: transparent;
}
.chat-input :deep(textarea) {
  border-radius: 16px;
}
/* 输入框文字亮白（对齐 WorkBuddy --cb-text-primary：覆盖 NaiveUI 默认灰字）+ 光标色 */
.chat-input :deep(textarea) {
  color: var(--text-primary) !important;
  caret-color: var(--text-primary);
}
.chat-input :deep(.n-input) {
  --n-text-color: var(--text-primary);
  --n-placeholder-color: var(--text-tertiary);
}
.chat-input :deep(textarea::placeholder) {
  color: var(--text-tertiary) !important;
}

/* ===== 朗读浮条（2026-09-27）===== 与"待发送队列"同一套视觉语言，不引入新视觉元素 */
.speak-bar {
  margin-bottom: 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 6px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.speak-bar-text {
  color: var(--text-secondary);
}
/* Pro 音色降级提示：不是错误，但必须让用户知道"现在听到的是系统音色" */
.speak-bar-hint { color: var(--warning, #d97706); white-space: nowrap; }
.speak-bar-spacer {
  flex: 1;
}
.speak-bar-btn {
  background: none;
  border: none;
  padding: 2px 4px;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 6px;
}
.speak-bar-btn:hover {
  color: var(--text-primary);
  background: var(--bg-primary);
}
.speak-bar-stop {
  color: var(--accent);
}
/* 合成期（还没出声）暂停无意义 —— 灰掉它，避免"点了没反应"被误读成坏掉 */
.speak-bar-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.speak-bar-btn:disabled:hover {
  color: var(--text-muted);
  background: none;
}

/* ===== 待发送队列 ===== */
.pending-queue {
  margin-bottom: 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pending-queue-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.pending-queue-title {
  font-weight: 600;
  color: var(--accent);
}
.pending-queue-hint {
  color: var(--text-muted);
}
.pending-queue-item {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 5px 8px;
}
.pending-queue-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition: color var(--duration-fast), background var(--duration-fast);
}
.queue-action:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.queue-action.queue-delete:hover {
  color: var(--error);
  background: var(--error-muted);
}

/* 停止/发送：上下垂直排列（停止在上、发送在下） */
.send-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

/* 停止生成按钮 */
.stop-button {
  flex-shrink: 0;
  width: 40px;
  height: 32px;
  padding: 0;
  border-radius: 10px;
  color: var(--error);
}
.stop-button:hover {
  color: var(--error);
  background: var(--error-muted);
}

.send-button {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
}

.input-hint-model {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.input-hint-icon { opacity: 0.85; }
.input-model-select {
  background: transparent;
  border: none;
  color: inherit;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 1px 2px;
  border-radius: 4px;
  max-width: 180px;
  outline: none;
}
.input-model-select:hover { background: var(--bg-hover, rgba(127,127,127,.12)); }
.input-model-select option { background: var(--bg-secondary, #1e1e2e); color: var(--text-primary, #fff); }

.input-hint {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-height: 26px;
}
/* v4 控制行：上传/语音胶囊化（1px 描边 ghost，统一 26px 高度对齐） */
.input-hint .upload-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 11px;
  border: 1px solid var(--border-input);
  border-radius: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  font-size: 11px;
}
.input-hint .upload-button:hover { background: var(--bg-hover, rgba(127,127,127,0.08)); color: var(--accent, #4f8cff); }
.input-hint .upload-button.disabled { opacity: 0.5; cursor: not-allowed; }
.input-hint .wc-icon-btn {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1px solid var(--border-input);
  background: transparent;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.input-hint .wc-icon-btn:hover { background: var(--bg-hover, rgba(127,127,127,0.08)); color: var(--accent, #4f8cff); }
.input-hint .wc-icon-btn.listening { color: var(--error, #e24b4a); border-color: var(--error, #e24b4a); animation: voice-pulse 1.2s ease-in-out infinite; }
/* 权限/模型 select 与胶囊同高对齐 */
.input-hint .input-hint-perm,
.input-hint .input-hint-model {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  margin-top: 2px; /* 老板微调：权限/模型带文字控件整体下移一点 */
}
/* 权限整体右移 10px（老板微调：与 ➕ 拉开间距；position 位移不推模型） */
.input-hint .input-hint-perm { position: relative; left: 10px; }
.input-hint .input-perm-select,
.input-hint .input-model-select {
  height: 22px;
  line-height: 22px;
  padding: 0 2px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-secondary);
  /* 紧凑：去原生外观 + 自定义小箭头（icon 与下拉更紧凑） */
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  background-image: url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjYiIHZpZXdCb3g9IjAgMCA4IDYiPjxwYXRoIGQ9Ik0xIDFsMyAzIDMtMyIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjOTk5IiBzdHJva2Utd2lkdGg9IjEuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+");
  background-repeat: no-repeat;
  background-position: right 2px center;
  padding-right: 11px;
  font-size: 11px;
  cursor: pointer;
  max-width: 140px;
}
.input-hint .compare-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 13px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}
.input-hint .compare-toggle:hover { background: var(--bg-hover, rgba(127,127,127,0.08)); }
.input-hint .compare-toggle.active { border-color: var(--accent, #4f8cff); color: var(--accent, #4f8cff); background: color-mix(in srgb, var(--accent, #4f8cff) 10%, transparent); }
.input-hint-spacer { flex: 1; }
.input-hint-shortcut { display: inline-flex; align-items: center; gap: 5px; color: var(--text-tertiary); font-size: 11px; height: 26px; }
.input-hint-shortcut .chip {
  font-family: var(--font-mono);
  background: var(--bg-hover, rgba(127,127,127,0.1));
  border: 1px solid var(--border-input);
  padding: 1px 5px;
  border-radius: 6px;
  font-size: 10px;
  color: var(--text-secondary);
}
.input-hint-count { color: var(--text-tertiary); }
/* ＋ 菜单按钮（对齐 WorkBuddy：控制行首个元素，胶囊描边） */
.input-plus-btn {
  width: 26px; height: 26px;
  border-radius: 50%;
  border: 1px solid var(--border-input);
  background: transparent;
  color: var(--text-secondary);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; transition: all 0.15s; flex-shrink: 0;
}
.input-plus-btn:hover { background: var(--bg-hover, rgba(127,127,127,0.08)); color: var(--accent, #4f8cff); }
/* 权限与用量之间的间距（对齐 WorkBuddy） */
.input-hint-gap { width: 14px; flex-shrink: 0; }
/* 增强提示词按钮（对齐 WorkBuddy） */
/* 发送/停止一体（对齐 WorkBuddy：回复中发送变停止方块） */
.send-button.is-stop { border-radius: 50% !important; }
/* 输入框下方权限选择器（常驻）：位于模型选择器前面，行内靠左排列 */
.input-hint-perm {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 12px;
}
.input-perm-select {
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  max-width: 130px;
  /* 紧凑：去原生外观，自定义小箭头贴文本（icon 与下拉更紧凑） */
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  padding: 0 12px 0 0;
  background-image: url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjYiIHZpZXdCb3g9IjAgMCA4IDYiPjxwYXRoIGQ9Ik0xIDFsMyAzIDMtMyIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjOTk5IiBzdHJva2Utd2lkdGg9IjEuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+");
  background-repeat: no-repeat;
  background-position: right 2px center;
}
/* 多模型对比开关（输入区下方，active 高亮） */
.compare-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 12px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
  transition: color var(--duration-fast), background var(--duration-fast);
}
.compare-toggle:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.compare-toggle.active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
/* 对比模型选择面板 */
.compare-pick-hint {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin: 0 0 10px;
}
.compare-model-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 300px;
  overflow-y: auto;
}
.compare-model-item {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  transition: background var(--duration-fast);
}
.compare-model-item:hover {
  background: var(--bg-hover);
}
.compare-pick-empty {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 20px 0;
}

/* 搜索/历史提问弹窗（DeepSeek 式：默认列出历史提问，当前会话高亮，点击进入） */
.search-modal { display: flex; flex-direction: column; gap: 12px; height: min(60vh, 480px); }
.question-history-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 -6px;
  padding: 0 6px;
}
.question-history-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  background: transparent;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-primary);
  transition: background .12s;
}
.question-history-item:hover { background: var(--bg-hover); }
.question-history-item.active { background: var(--bg-active); }
.qhi-text {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.qhi-meta { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
.qhi-time { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
.qhi-session {
  font-size: 11px; color: var(--text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.search-empty { padding: 20px 0; }
</style>
