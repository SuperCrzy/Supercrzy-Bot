<template>
  <div class="settings-page">
    <header class="settings-header">
      <h2>{{ $t('settings.title') }}</h2>
    </header>

    <div class="settings-body">
      <!-- ======== 主列：设置标签页 ======== -->
      <div class="settings-main">
        <n-card size="small" class="tabs-card" content-style="padding:0">
          <n-tabs v-model:value="activeTab" type="line" animated>
          <!-- Tab 1: 账户 -->
          <n-tab-pane name="account" :tab="$t('settings.tabAccount')">
            <div class="tab-content">
              <!-- 个人资料：昵称 + 头像 -->
              <div class="profile-section">
                <div class="profile-head">
                  <ProfileAvatar :avatar="form.userAvatar" :name="form.userName" :size="56" :radius="16" />
                  <div class="profile-fields">
                    <label>{{ $t('settings.profileName') }}</label>
                    <n-input v-model:value="form.userName" :placeholder="$t('settings.profileNamePlaceholder')" size="large" style="max-width:240px" />
                  </div>
                </div>
                <div class="profile-avatars">
                  <button
                    v-for="pid in PRESET_AVATARS" :key="pid"
                    class="avatar-option" :class="{ active: form.userAvatar === pid }"
                    @click="form.userAvatar = pid"
                  >
                    <ProfileAvatar :avatar="pid" :size="36" :radius="9" />
                  </button>
                  <label class="avatar-option avatar-upload" :class="{ active: isUploadAvatar }">
                    <ProfileAvatar :avatar="form.userAvatar" :size="36" :radius="9" v-if="isUploadAvatar" />
                    <span v-else class="upload-plus">+</span>
                    <input type="file" accept="image/*" class="hidden-file" @change="onAvatarUpload" />
                  </label>
                </div>
                <p class="form-hint">{{ $t('settings.avatarHint') }}</p>
              </div>

              <p class="tab-desc">{{ $t('settings.accountDesc') }}</p>
              <div class="form-group">
                <label>{{ $t('settings.accessToken') }}</label>
                <div class="token-row">
                  <n-input :value="tokenDisplay" readonly size="large" style="flex:1" />
                  <n-button size="large" type="primary" ghost @click="regenerateToken" :loading="regenerating">
                    {{ hasAccessToken ? $t('settings.regenerateToken') : $t('settings.generateToken') }}
                  </n-button>
                </div>
                <p class="form-hint">{{ $t('settings.tokenHint') }}</p>
              </div>
            </div>
          </n-tab-pane>

          <!-- Tab 2: 界面（2026-09-27 更名：原「显示」，只留界面/呈现类；音频类已拆到「语音与声音」） -->
          <n-tab-pane name="display" :tab="$t('settings.tabDisplay')">
            <div class="tab-content">
              <!-- 主题已移除：由侧边栏底部"黑白切换"按钮统一管理（已持久化到 settings 表） -->
              <div class="setting-row">
                <div class="setting-info">
                  <span class="setting-label">{{ $t('settings.language') }}</span>
                </div>
                <div class="lang-toggle">
                  <button
                    type="button"
                    class="lang-btn"
                    :class="{ active: form.language === 'en-US' }"
                    @click="setLanguage('en-US')"
                  >EN</button>
                  <button
                    type="button"
                    class="lang-btn"
                    :class="{ active: form.language === 'zh-CN' }"
                    @click="setLanguage('zh-CN')"
                  >中文简体</button>
                </div>
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.streamingEnabled') }}</span>
                <span class="setting-desc">{{ $t('settings.streamingDesc') }}</span>
                <n-switch v-model:value="form.streamingEnabled" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.compactMode') }}</span>
                <span class="setting-desc">{{ $t('settings.compactModeDesc') }}</span>
                <n-switch v-model:value="form.compactMode" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.showReasoning') }}</span>
                <span class="setting-desc">{{ $t('settings.showReasoningDesc') }}</span>
                <n-switch v-model:value="form.showReasoning" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.reasoningLive') }}</span>
                <span class="setting-desc">{{ $t('settings.reasoningLiveDesc') }}</span>
                <!-- 思考折叠偏好：本地偏好（localStorage），改完即时生效无需保存（阶段三-⑤） -->
                <n-switch :value="reasoningLiveExpanded" size="small" @update:value="setReasoningLive" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.showCost') }}</span>
                <span class="setting-desc">{{ $t('settings.showCostDesc') }}</span>
                <n-switch v-model:value="form.showCost" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.busyInputMode') }}</span>
                <span class="setting-desc">{{ $t('settings.busyInputModeDesc') }}</span>
                <n-switch v-model:value="form.busyInputMode" size="small" />
              </div>
            </div>
          </n-tab-pane>

          <!-- Tab: 语音与声音（2026-09-27 从「显示」拆出：完成提示音 + 朗读音色/语速归一处，
               原来音频类设置与显示类混在同一个 tab 里） -->
          <n-tab-pane name="speech" :tab="$t('settings.tabSpeech')">
            <div class="tab-content">
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.completionSound') }}</span>
                <span class="setting-desc">{{ $t('settings.completionSoundDesc') }}</span>
                <n-switch v-model:value="form.completionSound" size="small" />
              </div>
              <!-- 提示音音色（2026-09-27：提示音由写死双音改为内置音效可选）。
                   试听按钮**内嵌在下拉每项右侧**（点喇叭只试听、点名字才确认），选中即自动试听。
                   关闭提示音时收起下面两行，避免塞满无效设置项 -->
              <div v-if="form.completionSound" class="setting-row">
                <span class="setting-label">{{ $t('settings.completionSoundTone') }}</span>
                <span class="setting-desc">{{ $t('settings.completionSoundToneDesc') }}</span>
                <n-select
                  v-model:value="form.completionSoundTone"
                  :options="soundToneOptions"
                  :render-option="renderToneOption"
                  :consistent-menu-width="false"
                  size="small"
                  style="width: 170px"
                  @update:value="onTonePicked"
                />
              </div>
              <div v-if="form.completionSound" class="setting-row">
                <span class="setting-label">{{ $t('settings.completionSoundVolume') }}</span>
                <span class="setting-desc">{{ $t('settings.completionSoundVolumeDesc') }}</span>
                <div class="setting-range">
                  <n-slider
                    v-model:value="form.completionSoundVolume"
                    :min="MIN_SOUND_VOLUME"
                    :max="MAX_SOUND_VOLUME"
                    :step="0.05"
                    style="width: 130px"
                  />
                  <span class="setting-range-val">{{ soundVolumeLabel }}</span>
                </div>
              </div>
              <!-- 朗读音色 + 语速。改完即时生效（watch 同步 appStore）；
                   音色下拉每项内嵌试听按钮：点喇叭听该音色的自我介绍（不改变选择），点名字确认选择并自动试听 -->
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.ttsVoice') }}</span>
                <span class="setting-desc">{{ $t('settings.ttsVoiceDesc') }}</span>
                <n-select
                  v-model:value="form.ttsVoice"
                  :options="ttsVoiceOptions"
                  :render-option="renderVoiceOption"
                  :consistent-menu-width="false"
                  size="small"
                  style="width: 190px"
                  @update:value="onVoicePicked"
                />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.ttsRate') }}</span>
                <span class="setting-desc">{{ $t('settings.ttsRateDesc') }}</span>
                <div class="setting-range">
                  <n-slider
                    v-model:value="form.ttsRate"
                    :min="-50"
                    :max="50"
                    :step="10"
                    style="width: 130px"
                  />
                  <span class="setting-range-val">{{ ttsRateLabel }}</span>
                </div>
              </div>
              <!-- 自动朗读档位（2026-09-27）：回复完成 → 按档位自动读出来。
                   默认「仅窗口不在前台时」—— 老板盯着屏幕时不出声（他已经在读了），
                   Agent 长任务切走去干活时自动念，是真正省心的档位。 -->
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.autoRead') }}</span>
                <span class="setting-desc">{{ $t('settings.autoReadDesc') }}</span>
                <n-select
                  v-model:value="form.autoReadMode"
                  :options="autoReadOptions"
                  size="small"
                  style="width: 190px"
                />
              </div>
              <!-- 边生成边朗读（2026-09-28）：与上方档位**正交** —— 档位管"这轮读不读"，
                   它管"什么时候开始读"。拆成两个控件而不是加第 4 个档位，
                   是为了不改掉 09-27 拍板的档位语义。 -->
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.streamRead') }}</span>
                <span class="setting-desc">{{ $t('settings.streamReadDesc') }}</span>
                <n-switch v-model:value="form.streamRead" size="small" />
              </div>
            </div>
          </n-tab-pane>

          <!-- Tab 3: AI 与安全（2026-09-27 更名：原「权限管理」名实不符——一半是权限、一半是思考深度/轮次；
               同时并入原「隐私」tab 的 PII 脱敏，两者同属"AI 的行为边界"） -->
          <n-tab-pane name="agent" :tab="$t('settings.tabAgent')">
            <div class="tab-content">
              <div class="form-group">
                <label>{{ $t('settings.maxTurns') }}</label>
                <p class="input-desc">{{ $t('settings.maxTurnsDesc') }}</p>
                <n-input-number v-model:value="form.maxTurns" :min="1" :max="200" size="large" style="width:200px" />
              </div>
              <div class="form-group">
                <label>{{ $t('settings.permTier') }}</label>
                <p class="input-desc">{{ $t('settings.permTierDesc') }}</p>
                <!-- P0-04：收敛为用户能理解的三档（内部映射回历史 4 档，行为不变） -->
                <n-radio-group v-model:value="form.permissionTier" size="large">
                  <n-space wrap>
                    <n-radio v-for="t in PERMISSION_TIERS" :key="t" :value="t" :title="$t(TIER_I18N[t].desc)">
                      {{ $t(TIER_I18N[t].label) }}
                    </n-radio>
                  </n-space>
                </n-radio-group>
              </div>
              <div class="form-group">
                <label>{{ $t('settings.reasoningLevel') }}</label>
                <p class="input-desc">{{ $t('settings.reasoningLevelDesc') }}</p>
                <n-radio-group v-model:value="form.reasoningLevel" size="small">
                  <n-space wrap>
                    <n-radio value="briefest">{{ $t('settings.reasoningBriefest') }}</n-radio>
                    <n-radio value="light">{{ $t('settings.reasoningLight') }}</n-radio>
                    <n-radio value="balanced">{{ $t('settings.reasoningBalanced') }}</n-radio>
                    <n-radio value="deep">{{ $t('settings.reasoningDeep') }}</n-radio>
                    <n-radio value="very-deep">{{ $t('settings.reasoningVeryDeep') }}</n-radio>
                  </n-space>
                </n-radio-group>
              </div>

              <!-- 隐私：PII 脱敏（2026-09-27 从「隐私」tab 并入——与权限同属 AI 行为边界） -->
              <div class="form-group">
                <label>{{ $t('settings.piiMaskingEnabled') }}</label>
                <p class="input-desc">{{ $t('settings.piiMaskingEnabledDesc') }}</p>
                <n-switch v-model:value="form.piiMaskingEnabled" size="small" />
              </div>

              <!-- P2-01 高级入口分区：网关超时 / 自动放行秒数这类"平时不碰"的参数默认收起，
                   避免新手在常用项里被迫面对不理解的配置（此前与常用项平铺） -->
              <n-collapse class="settings-advanced" :default-expanded-names="[]">
                <n-collapse-item :title="$t('settings.advancedTitle')" name="advanced">
                  <div class="form-group">
                    <label>{{ $t('settings.gatewayTimeout') }}</label>
                    <p class="input-desc">{{ $t('settings.gatewayTimeoutDesc') }}</p>
                    <n-input-number v-model:value="form.gatewayTimeout" :min="30" :max="600" size="large" style="width:200px" />
                  </div>
                  <div class="form-group">
                    <label>{{ $t('settings.toolAutoApproveSeconds') }}</label>
                    <p class="input-desc">{{ $t('settings.toolAutoApproveSecondsDesc') }}</p>
                    <n-radio-group v-model:value="form.toolAutoApproveSeconds" size="small">
                      <n-space wrap>
                        <n-radio :value="0">{{ $t('settings.toolAutoApproveOff') }}</n-radio>
                        <n-radio :value="3">3{{ $t('settings.secondsUnit') }}</n-radio>
                        <n-radio :value="5">5{{ $t('settings.secondsUnit') }}</n-radio>
                        <n-radio :value="10">10{{ $t('settings.secondsUnit') }}</n-radio>
                      </n-space>
                    </n-radio-group>
                  </div>
                </n-collapse-item>
              </n-collapse>
            </div>
          </n-tab-pane>

          <!-- Tab 4: 记忆管理已合并到「管理 → 记忆管理」（/memory，含记忆开关+列表+导入+删除，避免双入口） -->

          <!-- 隐私已并入「AI 与安全」（2026-09-27：原隐私 tab 只有 PII 脱敏 1 项，与权限同属"AI 行为边界"） -->

          <!-- Tab: MCP 连接器 -->
          <n-tab-pane name="mcp" :tab="$t('settings.tabMcp')">
            <div class="tab-content">
              <p class="tab-desc">{{ $t('settings.mcpDesc') }}</p>

              <!-- ① 推荐连接器（官方精选预设） -->
              <div class="mcp-presets" v-if="presets.length">
                <div class="mcp-section-title">{{ $t('settings.mcpPresets') }}</div>
                <div class="mcp-preset-grid">
                  <div v-for="p in presets" :key="p.id" class="mcp-preset-card">
                    <div class="mcp-preset-name">
                      {{ p.name }}
                      <n-tag size="tiny" :bordered="false" type="success" v-if="p.official">{{ $t('settings.mcpOfficial') }}</n-tag>
                    </div>
                    <div class="mcp-preset-desc">{{ p.desc }}</div>
                    <n-button size="tiny" type="primary" quaternary @click="p.needsDir ? confirmAddPresetNeedsDir(p) : openAddConfirm(p)">
                      {{ p.needsDir ? $t('settings.mcpPickDir') : $t('settings.mcpOneClick') }}
                    </n-button>
                  </div>
                </div>
              </div>

              <!-- ② 搜索官方注册表（23,700+ 服务器） -->
              <div class="mcp-registry">
                <div class="mcp-section-title">{{ $t('settings.mcpRegistryTitle') }}</div>
                <div class="mcp-search-row">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="mcp-search-icon"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
                  <n-input
                    v-model:value="registryQ"
                    size="small"
                    :placeholder="$t('settings.mcpRegistryPh')"
                    clearable
                    @input="onRegistrySearch"
                    @clear="registryItems = []"
                  />
                </div>
                <div v-if="registryLoading" class="mcp-registry-empty">{{ $t('settings.mcpSearching') }}</div>
                <div v-else-if="registrySearched && registryQ && registryItems.length === 0" class="mcp-registry-empty">{{ $t('settings.mcpNoResult') }}</div>
                <div v-else class="mcp-registry-list">
                  <div v-for="(item, i) in registryItems" :key="i" class="mcp-registry-item">
                    <div class="mcp-registry-info">
                      <div class="mcp-registry-name">
                        {{ item.title }}
                        <n-tag size="tiny" :bordered="false" :type="item.official ? 'success' : 'warning'" v-if="item.official">{{ $t('settings.mcpOfficial') }}</n-tag>
                        <n-tag size="tiny" :bordered="false" type="warning" v-else>{{ $t('settings.mcpCommunity') }}</n-tag>
                      </div>
                      <div class="mcp-registry-desc">{{ item.desc }}</div>
                    </div>
                    <n-button size="tiny" type="primary" quaternary @click="openAddRegistry(item)">{{ $t('settings.mcpOneClick') }}</n-button>
                  </div>
                </div>
              </div>

              <!-- ③ 已安装服务器 -->
              <div class="mcp-section-title">{{ $t('settings.mcpInstalled') }}</div>
              <div v-for="s in mcpServers" :key="s.id" class="mcp-row">
                <div class="mcp-info">
                  <span class="mcp-name">{{ s.name }}</span>
                  <n-tag size="tiny" :bordered="false" :type="s.enabled ? 'success' : 'default'">{{ s.type }}</n-tag>
                  <span class="mcp-cmd">{{ s.type === 'sse' ? s.url : `${s.command} ${(s.args || []).join(' ')}` }}</span>
                </div>
                <div class="mcp-actions">
                  <span v-if="s.toolCount !== undefined" class="mcp-tools">{{ s.toolCount }} {{ $t('settings.mcpTools') }}</span>
                  <n-button size="tiny" quaternary @click="testMcp(s)">{{ $t('settings.mcpTest') }}</n-button>
                  <n-switch :value="!!s.enabled" size="small" @update:value="(v: boolean) => toggleMcp(s, v)" />
                  <n-popconfirm @positive-click="deleteMcp(s.id)">
                    <template #trigger>
                      <n-button size="tiny" quaternary type="error">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </n-button>
                    </template>
                    {{ $t('settings.mcpDeleteConfirm') }}
                  </n-popconfirm>
                </div>
              </div>
              <div v-if="mcpServers.length === 0" class="mcp-empty">{{ $t('settings.mcpEmpty') }}</div>

              <n-divider style="margin:14px 0 10px" />
              <div class="form-group">
                <label>{{ $t('settings.mcpAdd') }}</label>
                <n-input v-model:value="mcpForm.name" size="small" :placeholder="$t('settings.mcpNamePh')" style="margin-bottom:8px" />
                <n-radio-group v-model:value="mcpForm.type" size="small" style="margin-bottom:8px">
                  <n-radio value="stdio">stdio</n-radio>
                  <n-radio value="sse">sse / http</n-radio>
                </n-radio-group>
                <n-input v-if="mcpForm.type === 'stdio'" v-model:value="mcpForm.command" size="small" placeholder="npx" style="margin-bottom:8px" />
                <n-input v-if="mcpForm.type === 'stdio'" v-model:value="mcpForm.argsText" size="small" placeholder="-y, @some/mcp-server" style="margin-bottom:8px" />
                <n-input v-if="mcpForm.type === 'sse'" v-model:value="mcpForm.url" size="small" placeholder="https://host/mcp" style="margin-bottom:8px" />
                <n-button type="primary" size="small" :loading="mcpSaving" @click="saveMcp">{{ $t('settings.mcpSave') }}</n-button>
              </div>
              <div v-if="mcpMsg" class="mcp-msg" :style="{ color: mcpMsgOk ? 'var(--success)' : 'var(--error)' }">{{ mcpMsg }}</div>

              <!-- 添加确认弹窗：显示命令/URL + 风险标注，确认/取消 -->
              <n-modal
                v-model:show="addTargetShow"
                preset="card"
                :title="addTarget?.official ? $t('settings.mcpAddTitle') : $t('settings.mcpAddTitleCommunity')"
                style="width: 460px"
              >
                <template v-if="addTarget">
                  <div class="mcp-confirm-name">{{ addTarget.name }}</div>
                  <div class="mcp-confirm-desc">{{ addTarget.desc }}</div>
                  <div class="mcp-confirm-cmd">
                    <template v-if="addTarget.type === 'sse'">
                      <span class="mcp-confirm-label">{{ $t('settings.mcpUrlLabel') }}</span>
                      <code>{{ addTarget.url }}</code>
                    </template>
                    <template v-else>
                      <span class="mcp-confirm-label">{{ $t('settings.mcpCmdLabel') }}</span>
                      <code>{{ addTarget.command }} {{ addTarget.args.join(' ') }}</code>
                    </template>
                  </div>
                  <div v-if="!addTarget.official" class="mcp-confirm-warn">{{ $t('settings.mcpCommunityWarn') }}</div>
                </template>
                <template #footer>
                  <div style="display: flex; justify-content: flex-end; gap: 8px">
                    <n-button size="small" @click="cancelAdd">{{ $t('common.cancel') }}</n-button>
                    <n-button size="small" type="primary" :loading="mcpSaving" @click="confirmAdd">{{ $t('settings.mcpConfirmAdd') }}</n-button>
                  </div>
                </template>
              </n-modal>
            </div>
          </n-tab-pane>
        </n-tabs>
      </n-card>

      <!-- 自动保存：所有选项改动即时生效，无需手动保存 -->
      <div class="settings-actions">
        <span class="auto-save-hint">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
          {{ $t('settings.autoSaveHint') }}
        </span>
      </div>
      </div>

      <!-- ======== 右侧栏：管理入口 + 关于 ======== -->
      <aside class="settings-aside">
        <div class="settings-card">
          <h3 class="section-title">{{ $t('settings.manageTitle') }}</h3>
          <!-- P1-01：核心 / 高级分区（此前 6 项平铺，无从判断该先配哪个） -->
          <div v-for="g in manageGroups" :key="g.key" class="manage-group">
            <div class="manage-group-title">{{ g.title }}</div>
            <div class="manage-grid">
              <button v-for="m in g.items" :key="m.path" class="manage-card" @click="router.push(m.path)">
                <SvgIcon :name="m.icon" :size="16" />
                <span class="manage-label">{{ m.label }}</span>
                <span class="manage-arrow">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
                </span>
              </button>
            </div>
          </div>
        </div>

        <div class="settings-card">
          <h3 class="section-title">{{ $t('settings.aboutTitle') }}</h3>
          <UpdatePanel />
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted, computed, watch, h } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage, NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { detectLocale } from '@/utils/locale'
import { PERMISSION_TIERS, TIER_I18N, isPermissionTier, DEFAULT_PERMISSION_TIER } from '@/utils/permission'
import { useReasoningDisplay } from '@/utils/reasoning-display'
import { useAppStore } from '@/stores/app'
import { getModelSelectOptions } from '@/data/models'
import ProfileAvatar from '@/components/ui/ProfileAvatar.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import UpdatePanel from '@/components/settings/UpdatePanel.vue'
import {
  SOUND_TONES,
  MIN_VOLUME as MIN_SOUND_VOLUME,
  MAX_VOLUME as MAX_SOUND_VOLUME,
  normalizeTone as normalizeSoundTone,
  normalizeVolume as normalizeSoundVolume,
  previewCompletionTone,
} from '@/utils/sound'
import { useSpeechPreview, formatTtsRate } from '@/composables/useSpeechPreview'
import { DEFAULT_TTS_VOICES, fallbackVoiceSample, toVoiceOptions, type TtsVoiceEntry } from '@/utils/tts-voices'
import { AUTO_READ_MODES, DEFAULT_AUTO_READ_MODE, normalizeAutoReadMode } from '@/utils/auto-read'

const router = useRouter()
const appStore = useAppStore()
const nMessage = useMessage()
const { locale, t } = useI18n({ useScope: 'global' })

const activeTab = ref('account')

// ---- MCP 连接器管理 ----
interface McpServer {
  id: string; name: string; type: string; command: string; args: string[]; env: Record<string, string>
  url: string; enabled: number; toolCount?: number
}
const mcpServers = ref<McpServer[]>([])
const mcpForm = ref({ name: '', type: 'stdio', command: '', argsText: '', url: '' })
const mcpSaving = ref(false)
const mcpMsg = ref('')
const mcpMsgOk = ref(true)
async function loadMcp() {
  try {
    const r = await fetch('/api/mcp/servers')
    if (r.ok) mcpServers.value = await r.json()
  } catch { /* ignore */ }
}
async function testMcp(s: McpServer) {
  try {
    const r = await fetch('/api/mcp/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id }) })
    const d = await r.json()
    s.toolCount = d.success ? d.toolCount : 0
    mcpMsg.value = d.success ? `连接成功，${d.toolCount} 个工具` : `连接失败: ${d.error}`
    mcpMsgOk.value = !!d.success
  } catch (e: any) {
    mcpMsg.value = `连接失败: ${e.message}`
    mcpMsgOk.value = false
  }
}
async function toggleMcp(s: McpServer, v: boolean) {
  await fetch(`/api/mcp/servers/${s.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: v }) })
  s.enabled = v ? 1 : 0
}
async function deleteMcp(id: string) {
  await fetch(`/api/mcp/servers/${id}`, { method: 'DELETE' })
  mcpServers.value = mcpServers.value.filter((s) => s.id !== id)
}
async function saveMcp() {
  mcpSaving.value = true
  mcpMsg.value = ''
  try {
    const args = mcpForm.value.argsText.split(',').map((s) => s.trim()).filter(Boolean)
    const r = await fetch('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: mcpForm.value.name,
        type: mcpForm.value.type,
        command: mcpForm.value.command,
        args,
        url: mcpForm.value.url,
      }),
    })
    const d = await r.json()
    if (d.success) {
      mcpMsg.value = '已保存'
      mcpMsgOk.value = true
      mcpForm.value = { name: '', type: 'stdio', command: '', argsText: '', url: '' }
      await loadMcp()
    } else {
      mcpMsg.value = d.error || '保存失败'
      mcpMsgOk.value = false
    }
  } catch (e: any) {
    mcpMsg.value = e.message
    mcpMsgOk.value = false
  } finally {
    mcpSaving.value = false
  }
}

// ===== MCP 预设市场（官方精选 + 官方 registry 搜索）=====
interface McpPreset {
  id: string; name: string; desc: string; type: string; command: string; args: string[]; url: string
  official: boolean; needsDir?: boolean
}
interface RegistryItem {
  name: string; title: string; desc: string; version: string; official: boolean; remotes: string[]; packages: string[]
}
/** 待确认添加的目标（预设 or 搜索条目）→ 确认弹窗 */
const addTarget = ref<{ kind: 'preset' | 'registry'; name: string; desc: string; type: string; command: string; args: string[]; url: string; official: boolean } | null>(null)
const presets = ref<McpPreset[]>([])
const registryQ = ref('')
const registryItems = ref<RegistryItem[]>([])
const registryLoading = ref(false)
const registrySearched = ref(false)
let registryTimer: ReturnType<typeof setTimeout> | null = null

async function loadPresets() {
  try {
    const r = await fetch('/api/mcp/presets')
    if (r.ok) presets.value = await r.json()
  } catch { /* ignore */ }
}

/** 搜索官方 registry（防抖 500ms,1h 后端缓存） */
function onRegistrySearch() {
  if (registryTimer) clearTimeout(registryTimer)
  registryTimer = setTimeout(async () => {
    const q = registryQ.value.trim()
    registrySearched.value = true
    if (!q) { registryItems.value = []; return }
    registryLoading.value = true
    try {
      const r = await fetch(`/api/mcp/search?q=${encodeURIComponent(q)}`)
      const d = await r.json()
      registryItems.value = d.items || []
    } catch { registryItems.value = [] }
    registryLoading.value = false
  }, 500)
}

/** 点预设/搜索结果 → 打开确认弹窗 */
function openAddConfirm(p: McpPreset) {
  addTarget.value = {
    kind: 'preset', name: p.name, desc: p.desc, type: p.type, command: p.command,
    args: [...p.args], url: p.url || '', official: p.official,
  }
}
function openAddRegistry(item: RegistryItem) {
  // registry 条目：优先 remote(URL),否则用第一个包名(npx)
  const remote = item.remotes[0]
  const pkg = item.packages[0]
  addTarget.value = {
    kind: 'registry', name: item.title || item.name, desc: item.desc,
    type: remote ? 'sse' : 'stdio',
    command: remote ? '' : 'npx',
    args: remote ? [] : ['-y', `${pkg}@latest`],
    url: remote || '', official: item.official,
  }
}
/** 取消添加 */
function cancelAdd() { addTarget.value = null }
/** 弹窗显隐（v-model 需要成员表达式，用 computed 桥接） */
const addTargetShow = computed({
  get: () => addTarget.value !== null,
  set: (v: boolean) => { if (!v) addTarget.value = null },
})

/** 确认添加：填表单 → 保存 → 自动测试 → 工具数 */
async function confirmAdd() {
  const t = addTarget.value
  if (!t) return
  addTarget.value = null
  mcpForm.value = { name: t.name, type: t.type, command: t.command, argsText: t.args.join(', '), url: t.url }
  await saveMcp()
  // 保存成功后自动测试连接
  if (mcpMsgOk.value && mcpServers.value.length > 0) {
    const latest = mcpServers.value[mcpServers.value.length - 1]
    await testMcp(latest)
  }
}
/** 文件系统预设：确认前先选允许目录 */
async function confirmAddPresetNeedsDir(p: McpPreset) {
  const dir = await pickWorkspaceDir()
  if (!dir) return
  addTarget.value = {
    kind: 'preset', name: p.name, desc: p.desc, type: p.type, command: p.command,
    args: [...p.args.slice(0, -1), dir], url: '', official: p.official,
  }
}
/** 工作目录选择（复用简单 prompt 式：输入路径，Electron 下可换原生选择器） */
async function pickWorkspaceDir(): Promise<string | null> {
  const val = window.prompt('文件系统 MCP 允许访问的目录（绝对路径）：', '')
  return val?.trim() || null
}
const saving = ref(false)
/** 是否已完成初始加载（初始 Object.assign 不触发自动保存） */
let loaded = false
/** 自动保存防抖计时器 */
let saveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 思考过程折叠偏好（阶段三-⑤，2026-09-16）
 * 本地偏好（localStorage），不进 settings 表单——服务端 BOOL_KEYS 是白名单，
 * 且这是纯客户端渲染策略，塞进表单只会多一次无意义的 POST。
 * 改动即时生效并落盘，无需点保存。
 */
const { liveExpanded: reasoningLiveExpanded, setLiveExpanded: setReasoningLive } = useReasoningDisplay()

/**
 * 管理入口：收编自侧边栏的配置/数据/诊断页面（P1-01 分区，2026-09-17）
 * 分区依据：核心 = 用起来必须配的；高级 = 诊断与进阶集成，平时不碰。
 * 此前 6 项平铺，新手不知道先配哪个。
 */
const manageGroups = computed(() => [
  {
    key: 'core',
    title: t('settings.manageCore'),
    items: [
      { path: '/models', icon: 'monitor', label: t('settings.manageModels') },
      { path: '/memory', icon: 'brain', label: t('settings.manageMemory') },
      { path: '/images', icon: 'image', label: t('settings.manageImages') },
    ],
  },
  {
    key: 'advanced',
    title: t('settings.manageAdvanced'),
    items: [
      { path: '/gateway', icon: 'globe', label: t('settings.manageGateway') },
      { path: '/logs', icon: 'file-text', label: t('settings.manageLogs') },
      { path: '/usage', icon: 'activity', label: t('settings.manageUsage') },
    ],
  },
])

const hasAccessToken = ref(false)
const accessTokenMasked = ref('')

// ---- 朗读（Edge TTS）：音色清单从后端拉（单一来源），失败用内置兜底 ----
// 选项整形（含"sample 缺失时补试听台词"）在 utils/tts-voices.ts，有单测钉死"台词必提到自己名字"
const ttsVoices = ref<TtsVoiceEntry[]>([...DEFAULT_TTS_VOICES])
const ttsVoiceOptions = computed(() => toVoiceOptions(ttsVoices.value))
/** 音色试听状态（'loading' 与 'playing' 合并：都显示停止按钮，点了就取消） */
const { previewingId: previewingVoiceId, preview: previewVoice, stop: stopVoicePreview } = useSpeechPreview()
const regenerating = ref(false)

interface SettingsForm {
  apiKey: string
  apiKeyMasked: string
  temperature: number
  maxTokens: number
  systemPrompt: string
  language: string
  // Display
  streamingEnabled: boolean
  compactMode: boolean
  showReasoning: boolean
  showCost: boolean
  completionSound: boolean
  // 完成提示音音色（内置合成音效 id）+ 音量（峰值增益）
  completionSoundTone: string
  completionSoundVolume: number
  busyInputMode: boolean
  // Agent
  maxTurns: number
  gatewayTimeout: number
  // 工具授权模式（历史内部档位，保留兼容）
  toolApprovalMode: string
  // P0-04 用户面向三档权限：readonly 仅查看 / ask 执行前询问 / auto 自动执行
  permissionTier: string
  toolAutoApproveSeconds: number
  // 生图 Provider 配置
  imageProvider: string
  imageApiKey: string
  doubaoModel: string
  geminiImageModel: string
  reasoningLevel: string
  // Memory
  memoryEnabled: boolean
  memoryCharLimit: number
  // Privacy
  piiMaskingEnabled: boolean
  // 朗读（Edge TTS）
  ttsVoice: string
  ttsRate: number
  /** 自动朗读档位：off / background / always */
  autoReadMode: string
  /** 边生成边朗读（正交开关，非档位） */
  streamRead: boolean
  // Profile
  userName: string
  userAvatar: string
}

const form = reactive<SettingsForm>({
  apiKey: '',
  apiKeyMasked: '',
  temperature: 0.7,
  maxTokens: 8192,
  systemPrompt: '',
  language: detectLocale(localStorage.getItem('supercrzy-lang'), (() => { try { return navigator.language || '' } catch { return '' } })()),
  streamingEnabled: true,
  compactMode: false,
  showReasoning: true,
  showCost: false,
  // ⚠️ 初值必须是 true：appStore 的默认值就是 true（`stores/app.ts` 的 completionSound），
  // 这里写 false 会让设置页开关在"后端没有该键的老库"上显示"关"，而实际提示音会响
  // —— 用户看到的开关状态与真实行为不一致（2026-09-29 修正）。
  completionSound: true,
  completionSoundTone: 'classic',
  completionSoundVolume: 0.15,
  busyInputMode: true,
  maxTurns: 10,
  gatewayTimeout: 120,
  toolApprovalMode: 'prompt',
  permissionTier: 'ask',
  toolAutoApproveSeconds: 0,
  imageProvider: 'pollinations',
  imageApiKey: '',
  doubaoModel: 'doubao-seedream-5-0-260128',
  geminiImageModel: 'gemini-2.5-flash-image',
  reasoningLevel: 'balanced',
  memoryEnabled: true,
  memoryCharLimit: 50000,
  piiMaskingEnabled: false,
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  ttsRate: 0,
  autoReadMode: DEFAULT_AUTO_READ_MODE,
  streamRead: true,
  userName: '',
  userAvatar: '',
})

// 朗读语速显示 + 改动即时同步（依赖 form，必须在其定义之后 —— 放前面会 TDZ 白屏，vue-tsc 不报）
const ttsRateLabel = computed(() => {
  const v = Number(form.ttsRate) || 0
  return v === 0 ? t('settings.ttsRateNormal') : `${v > 0 ? '+' : ''}${v}%`
})
// 设置页改动即时同步到 appStore（朗读按钮读的是 appStore，无需刷新页面）
watch(() => form.ttsVoice, (v) => { if (v) appStore.ttsVoice = v })
watch(() => form.ttsRate, (v) => { appStore.ttsRate = Number(v) || 0 })

// ===== 自动朗读档位（2026-09-27）=====
/** 档位 id → i18n key（拼字符串 key 容易漏，显式映射） */
const AUTO_READ_I18N: Record<string, string> = {
  off: 'settings.autoReadOff',
  background: 'settings.autoReadBackground',
  always: 'settings.autoReadAlways',
}
const autoReadOptions = computed(() => AUTO_READ_MODES.map((m) => ({
  value: m,
  label: t(AUTO_READ_I18N[m] || m),
})))
watch(() => form.autoReadMode, (v) => { appStore.autoReadMode = normalizeAutoReadMode(v) })
// 边生成边朗读：改动即时同步（朗读链路读的是 appStore，不必等保存）
watch(() => form.streamRead, (v) => { appStore.streamRead = v !== false })

// ===== 完成提示音音色/音量（2026-09-27）=====
/** 音色 id → i18n key（与 permission 的 TIER_I18N 同风格，避免拼字符串 key） */
const SOUND_TONE_I18N: Record<string, string> = {
  classic: 'settings.toneClassic',
  single: 'settings.toneSingle',
  chord: 'settings.toneChord',
  down: 'settings.toneDown',
}
const soundToneOptions = computed(() => SOUND_TONES.map((tone) => ({
  value: tone.id,
  label: t(SOUND_TONE_I18N[tone.id] || tone.id),
})))
const soundVolumeLabel = computed(() => `${Math.round(normalizeSoundVolume(form.completionSoundVolume) * 100)}%`)
watch(() => form.completionSoundTone, (v) => { if (v) appStore.completionSoundTone = normalizeSoundTone(v) })
watch(() => form.completionSoundVolume, (v) => { appStore.completionSoundVolume = normalizeSoundVolume(v) })
// 完成提示音开关：与 tone/volume 同款实时同步。
// 原来只在 saveSettings 里写 localStorage、**从不更新 appStore**，而真正的开关判据是
// `ChatView.vue` 的 `if (ok && appStore.completionSound)` ⇒ 拨了开关要重载页面才生效
// （2026-09-29 修正：与音色/音量统一成"改了就生效"）。
watch(() => form.completionSound, (v) => { appStore.completionSound = v !== false })

// ===== 下拉选项内嵌「试听」按钮（2026-09-27）=====
// 为什么用 h() 现渲染：naive-ui 的下拉面板是 teleport 到 body 的，本组件的 scoped 样式打不到，
// 所以按钮用 naive 自己的 NButton（自带 hover/圆角），布局用内联 style，避免为它开全局样式。
// 「点喇叭 = 只试听不选中」依赖 stopPropagation 把事件拦在选项行之外（mousedown/up 也拦，防 naive 用它们选中）。

/** 播放图标（三角）/ 停止图标（方块）——内联 SVG，遵循"不用 emoji 当图标" */
const PlayGlyph = () => h('svg', { viewBox: '0 0 24 24', width: 13, height: 13, fill: 'currentColor' }, [
  h('path', { d: 'M8 5.2v13.6L19 12z' }),
])
const StopGlyph = () => h('svg', { viewBox: '0 0 24 24', width: 13, height: 13, fill: 'currentColor' }, [
  h('rect', { x: 7, y: 7, width: 10, height: 10, rx: 1.5 }),
])

/** 一行选项 = 默认标签节点 + 右侧试听按钮（width:100% 让整行都可点选）
 *
 * ⚠️ naive-ui 的 `render-option` 是**包裹**而不是**替换**：传进来的 `node` 就是那个
 * `.n-base-select-option` 元素，返回的节点会把它装在里面 —— 所以播放按钮是 `.n-base-select-option`
 * 的**兄弟**节点，不是它的子节点（写验收脚本的选择器时必须知道这一点，否则永远找不到按钮）。
 * `sc-sound-opt` 这个类就是给"整行"一个稳定标识用的。
 */
function optionWithPlay(label: unknown, playing: boolean, onPlay: () => void, onStop: () => void) {
  const btn = h(NButton, {
    size: 'tiny',
    quaternary: true,
    circle: true,
    title: t('settings.soundPreview'),
    onClick: (e: MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      playing ? onStop() : onPlay()
    },
    onMousedown: (e: MouseEvent) => e.stopPropagation(),
    onMouseup: (e: MouseEvent) => e.stopPropagation(),
  }, { icon: () => (playing ? StopGlyph() : PlayGlyph()) })
  return h('div', { class: 'sc-sound-opt', style: 'display:flex;align-items:center;gap:10px;width:100%' }, [
    h('span', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis' }, [label as any]),
    btn,
  ])
}

/** 提示音下拉的每项：喇叭 → 试听该音效（同步合成，无 loading 态，故恒显示播放图标） */
function renderToneOption({ node, option }: { node: unknown; option: any }) {
  return optionWithPlay(node, false, () => playTone(option.value), () => {})
}
/** 音色下拉的每项：喇叭 → 播该音色的自我介绍（异步合成，播放中显示停止） */
function renderVoiceOption({ node, option }: { node: unknown; option: any }) {
  return optionWithPlay(
    node,
    previewingVoiceId.value === option.value,
    () => { void previewVoiceById(option.value, option.sample) },
    () => stopVoicePreview(),
  )
}

/** 播放提示音效（试听与聊天里的完成提示音同一函数） */
function playTone(toneId: string) {
  previewCompletionTone(toneId, form.completionSoundVolume)
}

/** 试听某音色：优先用后端下发的 sample 台词（含"中英文读"），失败如实提示（不拿系统音色冒充） */
async function previewVoiceById(voiceId: string, sample?: string) {
  const text = sample || ttsVoiceOptions.value.find((v) => v.value === voiceId)?.sample
    || fallbackVoiceSample(ttsVoices.value.find((v) => v.id === voiceId)?.label || voiceId)
  const ok = await previewVoice(voiceId, text, { voice: voiceId, rate: formatTtsRate(form.ttsRate) })
  if (!ok) nMessage.warning(t('settings.previewFailed'))
}

/** 点名字确认选择 → 自动试听（老板要的"选中即听"；试听按钮仍可单独点） */
function onVoicePicked(id: string) {
  const sample = ttsVoiceOptions.value.find((v) => v.value === id)?.sample
  void previewVoiceById(id, sample)
}
function onTonePicked(id: string) {
  playTone(id)
}

const PRESET_AVATARS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']
/** 生图 Provider 选项（设置里供用户选择） */
const imageProviderOptions = [
  { label: 'Pollinations（免 Key，推荐）', value: 'pollinations' },
  { label: '豆包 · 火山方舟 Seedream', value: 'doubao' },
  { label: '谷歌 Gemini（Nano Banana）', value: 'gemini' },
]
const isUploadAvatar = computed(() => {
  return form.userAvatar.startsWith('/uploads/') || form.userAvatar.startsWith('http') || form.userAvatar.startsWith('data:image')
})

async function onAvatarUpload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  // 客户端压缩：>256px 缩小（头像小图，控制存储体积）
  try {
    const small = await compressImage(file, 256)
    const fd = new FormData()
    fd.append('file', small, 'avatar.png')
    const res = await fetch('/api/upload', { method: 'POST', body: fd })
    if (!res.ok) throw new Error('upload failed')
    const data = await res.json()
    form.userAvatar = data.files?.[0]?.url || data.url || data.path || ''
    if (!form.userAvatar) throw new Error('no url in response')
    nMessage.success(t('settings.avatarUploaded'))
  } catch (err: any) {
    nMessage.error(t('settings.avatarUploadFail') + ': ' + err.message)
  }
  input.value = ''
}

function compressImage(file: File, maxSize: number): Promise<File> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => {
          if (blob) resolve(new File([blob], 'avatar.png', { type: 'image/png' }))
          else reject(new Error('compress failed'))
        }, 'image/png', 0.85)
      }
      img.onerror = () => reject(new Error('decode failed'))
      img.src = String(reader.result)
    }
    reader.onerror = () => reject(new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

const tokenDisplay = computed(() => {
  if (!hasAccessToken.value) return t('settings.tokenNotConfigured')
  return accessTokenMasked.value || t('settings.tokenNotConfigured')
})

/** 生成新令牌：旧令牌立即失效（明文仅本次展示，自动复制到剪贴板） */
async function regenerateToken() {
  regenerating.value = true
  try {
    const res = await fetch('/api/settings/token', { method: 'POST' })
    if (!res.ok) throw new Error('generate failed')
    const data = await res.json()
    accessTokenMasked.value = data.masked
    hasAccessToken.value = true
    nMessage.success(t('settings.tokenGenerated'))
    // 明文复制到剪贴板（用户可粘贴到其他设备/客户端）
    try {
      await navigator.clipboard.writeText(data.token)
      nMessage.info(t('settings.tokenCopied'))
    } catch { /* 剪贴板不可用时忽略 */ }
  } catch (err: any) {
    nMessage.error(t('settings.tokenGenerateFail') + ': ' + err.message)
  } finally {
    regenerating.value = false
  }
}


onMounted(async () => {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) throw new Error('Failed to fetch')
    const data = await res.json()
    Object.assign(form, data)
    // P0-04 / D4：档位回显直接用服务端算好的生效值。
    // `GET /api/settings` 已把历史值（auto / accept-edits / prompt / deny / 空）投影成两档，
    // 这里**不再**本地推一遍（以前两边各写一份映射，漂移就会显示错档位而不自知）。
    form.permissionTier = isPermissionTier(data.permissionTier)
      ? data.permissionTier
      : DEFAULT_PERMISSION_TIER
    // 语言按钮高亮恢复为客户端实际语言（忽略后端历史值）
    form.language = detectLocale(localStorage.getItem('supercrzy-lang'), (() => { try { return navigator.language || '' } catch { return '' } })())
    // 访问令牌状态（后端只返回掩码，明文仅在生成时一次性展示）
    hasAccessToken.value = !!data.hasAccessToken
    accessTokenMasked.value = data.accessTokenMasked || ''
    // 语言不以后端为准：客户端 localStorage（用户显式选择）> 浏览器检测（i18n-first），
    // 避免历史自动保存的默认值（如 zh-CN）把海外用户强制拉回中文
    if (data.theme) {
      appStore.darkMode = data.theme === 'dark'
    }
    // 同步 completionSound 到 localStorage
    if (data.completionSound !== undefined) {
      localStorage.setItem('supercrzy:completionSound', String(data.completionSound))
    }
    // ⚠️ 回填开关本身（2026-09-29 修）：原来这里只写了 localStorage，**没回填 form**，
    // 于是设置页那个开关永远显示 form 初值，与 appStore/后端真相脱钩。后端无此键（老库）
    // 一律按 appStore 默认 true 处理。
    form.completionSound = data.completionSound === undefined ? true : !!data.completionSound
    // 提示音音色/音量归一（历史值或脏值一律夹到合法区间，避免开页就静音/过度吵）
    form.completionSoundTone = normalizeSoundTone(data.completionSoundTone)
    form.completionSoundVolume = normalizeSoundVolume(data.completionSoundVolume)
    // 自动朗读档位归一（老库无此键 → 默认「仅窗口不在前台时」；脏值不会意外变成 always）
    form.autoReadMode = normalizeAutoReadMode(data.autoReadMode)
    // 边生成边朗读：老库无此键 → 保持默认开（与 appStore 默认一致）
    if (data.streamRead !== undefined) form.streamRead = data.streamRead !== false && data.streamRead !== 'false'
    loaded = true
  } catch (err) {
    console.error('[SettingsView] Failed to load settings:', err)
    loaded = true
  }
  loadMcp()
  loadPresets()
  // 朗读音色清单（失败保持内置兜底）
  try {
    const vres = await fetch('/api/tts/voices')
    if (vres.ok) {
      const vdata = await vres.json()
      if (Array.isArray(vdata?.voices) && vdata.voices.length) ttsVoices.value = vdata.voices
    }
  } catch { /* ignore */ }
})

/** 语言切换：即时生效（无需点保存），同时写入 localStorage 保证刷新后一致；自动保存由 watch 统一触发 */
function setLanguage(v: string) {
  if (form.language === v) return
  form.language = v
  locale.value = v
  localStorage.setItem('supercrzy-lang', v)
}

/** 自动保存：表单任何字段变化 → 防抖 600ms 后静默保存（首次加载不触发） */
watch(
  form,
  () => {
    if (!loaded) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveSettings(), 600)
  },
  { deep: true }
)

/** 静默保存：不弹成功提示（自动保存场景），失败才提示 */
async function saveSettings() {
  saving.value = true
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form }),
    })
    if (!res.ok) throw new Error('Save failed')
    // 实时切换 i18n 语言
    locale.value = form.language
    localStorage.setItem('supercrzy-lang', form.language)
    // 同步个人资料（侧边栏/聊天头像即时生效）
    appStore.userName = form.userName
    appStore.userAvatar = form.userAvatar
    // 同步 completionSound 到 localStorage
    localStorage.setItem('supercrzy:completionSound', String(form.completionSound))
  } catch (err: any) {
    console.error('[SettingsView] Save error:', err)
    nMessage.error(t('settings.saveFail') + ': ' + err.message)
  } finally {
    saving.value = false
  }
}

// testConnection moved to ModelsView
</script>

<style scoped>
.settings-page { height: 100%; display: flex; flex-direction: column; background: var(--bg-secondary); }
.settings-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color); background: var(--bg-primary); flex-shrink: 0; }
.settings-header h2 { font-size: 16px; font-weight: 600; margin: 0; }
.settings-body { flex: 1; overflow-y: auto; padding: 24px; display: flex; gap: 20px; align-items: flex-start; }
/* 主列：设置标签页 + 保存 */
.settings-main { flex: 1; min-width: 0; }
/* 右侧栏：管理入口 + 关于（横向版面，消除右侧空白） */
.settings-aside {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
@media (max-width: 900px) {
  .settings-body { flex-direction: column; }
  .settings-aside { width: 100%; }
}
.settings-card { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px 24px; margin-bottom: 20px; }
.section-title { font-size: 14px; font-weight: 600; margin: 0 0 16px; color: var(--text-primary); }
/* P2-01 高级折叠组：与常用项在视觉上分层 */
.settings-advanced { margin-top: 4px; }
.settings-advanced :deep(.n-collapse-item__header-main) { font-size: 13px; color: var(--text-secondary); }

/* 管理入口网格 */
.manage-group + .manage-group { margin-top: 12px; }
.manage-group-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--text-tertiary, #8a8f9c);
  margin: 0 0 6px 2px;
}
.manage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}
.manage-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  cursor: pointer;
  color: var(--text-primary);
  text-align: left;
  transition: border-color .15s, background .15s;
}
.manage-card:hover {
  border-color: var(--accent, #4F46E5);
  background: var(--bg-hover);
}
.manage-label { flex: 1; font-size: 13px; font-weight: 500; }
.manage-arrow { color: var(--text-muted); display: inline-flex; }
.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: var(--text-primary); }
.form-hint { font-size: 12px; color: var(--text-muted); margin: 6px 0 0; }
.input-desc { font-size: 12px; color: var(--text-muted); margin: 0 0 8px; }
.input-row { display: flex; gap: 10px; }
.form-row-inline { display: flex; gap: 16px; }
.flex-1 { flex: 1; min-width: 0; }
.full-width { width: 100%; }

.tabs-card { border: 1px solid var(--border-color); border-radius: 12px; overflow: hidden; }
.tabs-card :deep(.n-tabs-nav) { padding: 0 16px; background: var(--bg-primary); }
.tab-content { padding: 20px 24px; }
/* MCP 连接器 */
.mcp-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 0; border-bottom:1px solid var(--border-color); }
/* MCP 预设市场 */
.mcp-section-title { font-size:12px; font-weight:600; color:var(--text-secondary); margin:14px 0 8px; }
.mcp-preset-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:8px; }
.mcp-preset-card { border:1px solid var(--border-color); border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:6px; background:var(--bg-primary); }
.mcp-preset-name { display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; }
.mcp-preset-desc { font-size:11px; color:var(--text-muted); line-height:1.5; min-height:30px; }
.mcp-search-row { display:flex; align-items:center; gap:6px; border:1px solid var(--border-color); border-radius:8px; padding:2px 8px; }
.mcp-search-icon { color:var(--text-muted); flex-shrink:0; }
.mcp-search-row :deep(.n-input) { border:none; box-shadow:none; background:transparent; }
.mcp-registry-list { display:flex; flex-direction:column; margin-top:6px; }
.mcp-registry-item { display:flex; align-items:center; gap:10px; padding:8px 4px; border-bottom:1px solid var(--border-color); }
.mcp-registry-info { flex:1; min-width:0; }
.mcp-registry-name { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:600; flex-wrap:wrap; }
.mcp-registry-desc { font-size:11px; color:var(--text-muted); margin-top:2px; line-height:1.5; }
.mcp-registry-empty { font-size:12px; color:var(--text-muted); padding:10px 4px; }
/* 添加确认弹窗 */
.mcp-confirm-name { font-size:14px; font-weight:600; margin-bottom:4px; }
.mcp-confirm-desc { font-size:12px; color:var(--text-secondary); margin-bottom:10px; line-height:1.6; }
.mcp-confirm-cmd { background:var(--bg-tertiary); border-radius:8px; padding:8px 10px; font-size:12px; margin-bottom:10px; }
.mcp-confirm-label { display:block; font-size:11px; color:var(--text-muted); margin-bottom:3px; }
.mcp-confirm-cmd code { font-family:var(--font-mono); font-size:12px; color:var(--text-primary); word-break:break-all; }
.mcp-confirm-warn { font-size:11px; color:var(--warning,#eab308); background:color-mix(in srgb, #eab308 10%, transparent); border-radius:8px; padding:7px 10px; line-height:1.5; }
.mcp-info { display:flex; align-items:center; gap:8px; min-width:0; }
.mcp-name { font-weight:600; font-size:13px; white-space:nowrap; }
.mcp-cmd { font-size:11px; color:var(--text-muted); font-family:var(--font-mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:260px; }
.mcp-actions { display:flex; align-items:center; gap:8px; flex-shrink:0; }
.mcp-tools { font-size:11px; color:var(--text-muted); }
.mcp-empty { font-size:12px; color:var(--text-muted); padding:10px 0; }
.mcp-msg { font-size:12px; margin-top:8px; }
.tab-desc { font-size: 13px; color: var(--text-secondary); margin: 0 0 20px; line-height: 1.6; }

/* Toggle rows */
.setting-row { display: flex; align-items: center; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid var(--border-color); gap: 16px; }
.setting-row:last-child { border-bottom: none; }
.setting-label { font-size: 13px; font-weight: 500; color: var(--text-primary); white-space: nowrap; }
.setting-desc { font-size: 12px; color: var(--text-muted); flex: 1; text-align: right; }
/* 朗读语速：滑块 + 数值（2026-09-27） */
/* 带数值回显的滑杆（朗读语速 / 提示音音量共用） */
.setting-range { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.setting-range-val { font-size: 12px; color: var(--text-muted); min-width: 42px; text-align: right; font-family: var(--font-mono, monospace); }
.setting-info { display: flex; align-items: center; gap: 8px; }

/* Token row */
.token-row { display: flex; gap: 10px; }
.status-row { display: flex; align-items: center; gap: 12px; }

/* 工具授权模式选项说明 */
.radio-hint {
  display: inline;
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 400;
  margin-left: 4px;
}

/* Actions */
.settings-actions { padding: 0 0 40px; display: flex; justify-content: center; }
.auto-save-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.auto-save-hint svg { color: var(--success, #22c55e); }

/* 语言切换：EN / 中文简体 双按钮 */
.lang-toggle {
  display: inline-flex;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 8px);
  overflow: hidden;
  flex-shrink: 0;
}
.lang-btn {
  padding: 5px 16px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background .15s, color .15s;
  white-space: nowrap;
}
.lang-btn + .lang-btn { border-left: 1px solid var(--border-color); }
.lang-btn:hover { background: var(--bg-hover, rgba(128,128,128,.08)); }
.lang-btn.active {
  background: var(--accent, #6366f1);
  color: #fff;
}

/* Profile section */
.profile-section { margin-bottom: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--border-color); }
.profile-head { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.profile-fields label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
.profile-avatars { display: flex; gap: 10px; flex-wrap: wrap; }
.avatar-option {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px; height: 40px; padding: 0; border: 2px solid var(--border-color);
  border-radius: 12px; background: transparent; cursor: pointer; overflow: hidden;
  transition: border-color .15s, transform .15s;
}
.avatar-option:hover { transform: scale(1.06); }
.avatar-option.active { border-color: var(--accent, #4F46E5); box-shadow: 0 0 0 2px rgba(79,70,229,.15); }
.avatar-upload { display: inline-flex; align-items: center; justify-content: center; }
.upload-plus { font-size: 18px; color: var(--text-muted); font-weight: 300; }
.hidden-file { display: none; }

</style>
