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

          <!-- Tab 2: 显示 -->
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
                <span class="setting-label">{{ $t('settings.showCost') }}</span>
                <span class="setting-desc">{{ $t('settings.showCostDesc') }}</span>
                <n-switch v-model:value="form.showCost" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.completionSound') }}</span>
                <span class="setting-desc">{{ $t('settings.completionSoundDesc') }}</span>
                <n-switch v-model:value="form.completionSound" size="small" />
              </div>
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.busyInputMode') }}</span>
                <span class="setting-desc">{{ $t('settings.busyInputModeDesc') }}</span>
                <n-switch v-model:value="form.busyInputMode" size="small" />
              </div>
            </div>
          </n-tab-pane>

          <!-- Tab 3: 代理 -->
          <n-tab-pane name="agent" :tab="$t('settings.tabAgent')">
            <div class="tab-content">
              <div class="form-group">
                <label>{{ $t('settings.maxTurns') }}</label>
                <p class="input-desc">{{ $t('settings.maxTurnsDesc') }}</p>
                <n-input-number v-model:value="form.maxTurns" :min="1" :max="200" size="large" style="width:200px" />
              </div>
              <div class="form-group">
                <label>{{ $t('settings.gatewayTimeout') }}</label>
                <p class="input-desc">{{ $t('settings.gatewayTimeoutDesc') }}</p>
                <n-input-number v-model:value="form.gatewayTimeout" :min="30" :max="600" size="large" style="width:200px" />
              </div>
              <div class="form-group">
                <label>{{ $t('settings.toolApproval') }}</label>
                <p class="input-desc">{{ $t('settings.toolApprovalDesc') }}</p>
                <n-radio-group v-model:value="form.toolApprovalMode" size="large">
                  <n-space wrap>
                    <n-radio value="auto" :title="$t('settings.toolApprovalAutoDesc')">
                      {{ $t('settings.toolApprovalAuto') }}
                    </n-radio>
                    <n-radio value="accept-edits" :title="$t('settings.toolApprovalAcceptEditsDesc')">
                      {{ $t('settings.toolApprovalAcceptEdits') }}
                    </n-radio>
                    <n-radio value="prompt" :title="$t('settings.toolApprovalPromptDesc')">
                      {{ $t('settings.toolApprovalPrompt') }}
                    </n-radio>
                    <n-radio value="deny" :title="$t('settings.toolApprovalDenyDesc')">
                      {{ $t('settings.toolApprovalDeny') }}
                    </n-radio>
                  </n-space>
                </n-radio-group>
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
            </div>
          </n-tab-pane>

          <!-- Tab 4: 记忆管理已合并到「管理 → 记忆管理」（/memory，含记忆开关+列表+导入+删除，避免双入口） -->

          <!-- Tab 5: 隐私 -->
          <n-tab-pane name="privacy" :tab="$t('settings.tabPrivacy')">
            <div class="tab-content">
              <div class="setting-row">
                <span class="setting-label">{{ $t('settings.piiMaskingEnabled') }}</span>
                <span class="setting-desc">{{ $t('settings.piiMaskingEnabledDesc') }}</span>
                <n-switch v-model:value="form.piiMaskingEnabled" size="small" />
              </div>
            </div>
          </n-tab-pane>

          <!-- Tab 6: MCP 连接器 -->
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
          <div class="manage-grid">
            <button v-for="m in manageEntries" :key="m.path" class="manage-card" @click="router.push(m.path)">
              <SvgIcon :name="m.icon" :size="16" />
              <span class="manage-label">{{ m.label }}</span>
              <span class="manage-arrow">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
              </span>
            </button>
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
import { reactive, ref, onMounted, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { detectLocale } from '@/utils/locale'
import { useAppStore } from '@/stores/app'
import { getModelSelectOptions } from '@/data/models'
import ProfileAvatar from '@/components/ui/ProfileAvatar.vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'
import UpdatePanel from '@/components/settings/UpdatePanel.vue'

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

/** 管理入口：收编自侧边栏的配置/数据/诊断页面 */
const manageEntries = computed(() => [
  { path: '/models', icon: 'monitor', label: t('settings.manageModels') },
  { path: '/gateway', icon: 'globe', label: t('settings.manageGateway') },
  { path: '/memory', icon: 'brain', label: t('settings.manageMemory') },
  { path: '/logs', icon: 'file-text', label: t('settings.manageLogs') },
  { path: '/usage', icon: 'activity', label: t('settings.manageUsage') },
  { path: '/images', icon: 'image', label: t('settings.manageImages') },
])

const hasAccessToken = ref(false)
const accessTokenMasked = ref('')
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
  busyInputMode: boolean
  // Agent
  maxTurns: number
  gatewayTimeout: number
  // 工具授权模式
  toolApprovalMode: string
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
  completionSound: false,
  busyInputMode: true,
  maxTurns: 10,
  gatewayTimeout: 120,
  toolApprovalMode: 'prompt',
  toolAutoApproveSeconds: 0,
  imageProvider: 'pollinations',
  imageApiKey: '',
  doubaoModel: 'doubao-seedream-5-0-260128',
  geminiImageModel: 'gemini-2.5-flash-image',
  reasoningLevel: 'balanced',
  memoryEnabled: true,
  memoryCharLimit: 50000,
  piiMaskingEnabled: false,
  userName: '',
  userAvatar: '',
})

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
    loaded = true
  } catch (err) {
    console.error('[SettingsView] Failed to load settings:', err)
    loaded = true
  }
  loadMcp()
  loadPresets()
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

/* 管理入口网格 */
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
