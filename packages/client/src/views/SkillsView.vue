<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h2>{{ $t('skills.title') }}</h2>
        <p class="page-desc">{{ $t('skills.desc') }}</p>
      </div>
      <div class="header-actions">
        <div class="search-wrap">
          <SvgIcon name="search" :size="14" class="search-icon-prefix" />
          <input v-model="searchQuery" :placeholder="$t('skills.searchPlaceholder')" class="search-input" />
        </div>
        <n-button size="small" quaternary @click="showInstallModal = true">
          <template #icon><SvgIcon name="download" :size="14" /></template>
          {{ $t('skills.market') }}
        </n-button>
        <n-button size="small" type="primary" @click="openCreateModal">
          <template #icon><SvgIcon name="plus" :size="14" /></template>
          {{ $t('skills.new') }}
        </n-button>
      </div>
    </header>

    <!-- 市场来源切换：内置市场 / 开源市场（browse.sh + GitHub 官方，对齐 Hermes Skills Hub） -->
    <div class="market-source-tabs">
      <button class="market-source-tab" :class="{ active: marketSource === 'builtin' }" @click="switchMarket('builtin')">
        <SvgIcon name="star" :size="13" /> {{ $t('skills.marketBuiltin') }}
      </button>
      <button class="market-source-tab" :class="{ active: marketSource === 'open' }" @click="switchMarket('open')">
        <SvgIcon name="globe" :size="13" /> {{ $t('skills.marketOpen') }}
      </button>
    </div>

    <!-- ===== 内置市场 ===== -->
    <template v-if="marketSource === 'builtin'">
    <!-- 分类 Tab：全部 / 开发 / 研究 / 系统 / 自动化 / 数据 / 写作 / 通用 -->
    <div class="cat-tabs">
      <button
        v-for="tab in categoryTabs"
        :key="tab.value"
        class="cat-tab"
        :class="{ active: activeCategory === tab.value }"
        @click="activeCategory = tab.value"
      >
        <SvgIcon :name="tab.icon" :size="13" v-if="tab.icon" />
        {{ tab.label }}
        <span v-if="tab.count !== undefined" class="cat-count">{{ tab.count }}</span>
      </button>
    </div>

    <div class="stats-bar">
      <span class="stat-item"><strong>{{ marketCards.length }}</strong> {{ $t('skills.total') }}</span>
      <span class="stat-item"><strong>{{ enabledCount }}</strong> {{ $t('skills.active') }}</span>
      <span class="stat-item"><strong>{{ installedCount }}</strong> {{ $t('skills.installed') }}</span>
    </div>

    <div class="skill-ops-bar">
      <span class="skill-ops-hint">{{ $t('skills.exportHint') }}</span>
      <n-button size="small" :loading="exporting" @click="doExportAll">{{ $t('skills.exportAll') }}</n-button>
      <span v-if="exportResult" class="skill-ops-result">{{ exportResult }}</span>
    </div>

    <div class="skills-grid">
      <n-card v-for="s in filteredCards" :key="s.name + (s.id || '')" size="small" class="skill-card" :class="{ disabled: s.installed && !s.enabled }">
        <template #header>
          <div class="skill-header">
            <div class="skill-icon" :class="'cat-' + s.category">
              <SvgIcon :name="s.icon || getCategoryIcon(s.category)" :size="18" />
            </div>
            <div class="skill-info">
              <div class="skill-name">
                {{ s.name }}
                <n-tag v-if="s.installed" size="tiny" :bordered="false" :type="s.enabled ? 'success' : 'default'">{{ s.enabled ? $t('skills.active') : $t('skills.off') }}</n-tag>
                <n-tag v-else size="tiny" :bordered="false" type="info">{{ $t('skills.notInstalled') }}</n-tag>
              </div>
              <div class="skill-tags">
                <span class="skill-cat" :class="'cat-' + s.category">{{ categoryLabel(s.category) }}</span>
                <n-tag v-if="s.core" size="tiny" :bordered="false">{{ $t('skills.core') }}</n-tag>
              </div>
            </div>
          </div>
        </template>
        <p class="skill-desc">{{ s.description }}</p>
        <div class="skill-meta">
          <span v-if="s.trigger_keywords" class="skill-kw">{{ s.trigger_keywords.split(',').slice(0,3).join(', ') }}</span>
        </div>
        <template #action>
          <div class="skill-actions">
            <!-- 未安装 → 安装按钮；已安装 → 开关 + 卸载 -->
            <template v-if="!s.installed">
              <n-button size="tiny" type="primary" :loading="installingName === s.name" @click="installBuiltin(s)">
                {{ $t('skills.install') }}
              </n-button>
            </template>
            <template v-else>
              <n-button v-if="!s.isBuiltin" size="tiny" quaternary @click="editSkillById(s.id)">{{ $t('skills.edit') }}</n-button>
              <n-switch :value="!!s.enabled" @update:value="(v: boolean) => toggleSkill(s.id, v)" size="small" />
              <n-button size="tiny" quaternary type="error" @click="uninstallSkill(s)">{{ $t('skills.uninstall') }}</n-button>
            </template>
          </div>
        </template>
      </n-card>
    </div>

    <n-empty v-if="filteredCards.length===0&&!loading" :description="$t('skills.empty')" style="margin-top:60px">
      <template #extra>
        <n-button size="small" type="primary" :loading="syncing" @click="doSync">{{ $t('skills.initBuiltin') }}</n-button>
      </template>
    </n-empty>
    </template>

    <!-- ===== 开源市场（browse.sh 461 站点技能 + GitHub 官方技能仓库） ===== -->
    <div v-else class="open-market">
      <div class="open-source-switch">
        <button class="open-source-btn" :class="{ active: openTab === 'browse' }" @click="switchOpenTab('browse')">
          <!-- browse.sh（Browserbase）浏览器窗口 logo -->
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><line x1="2" y1="9" x2="22" y2="9"/><circle cx="5.5" cy="6.5" r="0.6" fill="currentColor" stroke="none"/>
          </svg>
          browse.sh
        </button>
        <button class="open-source-btn" :class="{ active: openTab === 'github' }" @click="switchOpenTab('github')">
          <!-- GitHub 官方 logo（fill 型） -->
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
          {{ $t('skills.ghOfficial') }}
        </button>
        <span class="open-source-hint">{{ $t('skills.openHint') }}</span>
      </div>

      <div v-if="openTab === 'browse'" class="open-body">
        <div class="open-toolbar">
          <n-select v-model:value="browseCat" :options="browseCatOptions" clearable :placeholder="$t('skills.filterCategory')" size="small" style="width:220px" @update:value="loadBrowse" />
          <span class="open-count">{{ $t('skills.skillsCount', { n: browseSkills.length, total: 461 }) }}</span>
          <span v-if="browseLoading" class="open-loading">{{ $t('skills.loading') }}</span>
        </div>
        <div v-if="browseSkills.length === 0 && !browseLoading" class="open-empty">{{ $t('skills.noOpenSkills') }}</div>
        <div class="open-list">
          <div v-for="s in browseSkills" :key="s.slug" class="open-card">
            <div class="open-icon" :style="{ background: iconColor(s.title) }">{{ s.title.charAt(0).toUpperCase() }}</div>
            <div class="open-info">
              <div class="open-title">
                {{ s.title }}
                <n-tag size="tiny" :bordered="false" type="warning">browse.sh</n-tag>
              </div>
              <div class="open-desc">{{ s.description }}</div>
              <div class="open-meta">
                <span class="open-cat">{{ s.category }}</span>
                <span v-if="s.verified" class="open-verified">✓ {{ $t('skills.verified') }}</span>
                <span>{{ $t('skills.installs', { n: s.installCount }) }}</span>
              </div>
            </div>
            <n-button size="tiny" type="primary" :loading="installingUrl === s.sourceUrl" @click="openInstallFromUrl(s.sourceUrl)">
              {{ $t('skills.install') }}
            </n-button>
          </div>
        </div>
      </div>

      <div v-else class="open-body">
        <div class="open-toolbar">
          <n-select v-model:value="ghRepo" :options="ghRepoOptions" size="small" style="width:220px" @update:value="loadGithub" />
          <span class="open-count">{{ ghSkills.length }} skills</span>
          <span v-if="ghLoading" class="open-loading">{{ $t('skills.loading') }}</span>
        </div>
        <div v-if="ghSkills.length === 0 && !ghLoading" class="open-empty">{{ $t('skills.noOpenSkills') }}</div>
        <div class="open-list">
          <div v-for="s in ghSkills" :key="s.url" class="open-card">
            <div class="open-icon open-icon--git"><SvgIcon name="git" :size="18" /></div>
            <div class="open-info">
              <div class="open-title">
                {{ s.name }}
                <n-tag size="tiny" :bordered="false" type="success">{{ $t('skills.trusted') }}</n-tag>
              </div>
              <div v-if="s.description" class="open-desc">{{ s.description }}</div>
              <div class="open-meta"><span class="open-cat">{{ $t('skills.official') }}</span></div>
            </div>
            <n-button size="tiny" type="primary" :loading="installingUrl === s.url" @click="openInstallFromUrl(s.url)">
              {{ $t('skills.install') }}
            </n-button>
          </div>
        </div>
      </div>
    </div>

    <!-- Create/Edit Modal -->
    <n-modal v-model:show="showCreateModal" preset="card" :title="editingSkill ? $t('skills.edit') + ' Skill' : $t('skills.new') + ' Skill'" style="max-width:560px" :mask-closable="false">
      <n-form ref="formRef" :model="formData" label-placement="left" label-width="120">
        <n-form-item :label="$t('skills.fldName')"><n-input v-model:value="formData.name" placeholder="Skill name" /></n-form-item>
        <n-form-item :label="$t('skills.fldIcon')"><n-input v-model:value="formData.icon" placeholder="SVG icon name" style="width:120px" /></n-form-item>
        <n-form-item :label="$t('skills.fldDescription')"><n-input v-model:value="formData.description" type="textarea" :rows="2" /></n-form-item>
        <n-form-item :label="$t('skills.fldCategory')"><n-select v-model:value="formData.category" :options="categoryOptions" /></n-form-item>
        <n-form-item :label="$t('skills.fldKeywords')"><n-input v-model:value="formData.trigger_keywords" placeholder="kw1, kw2, ..." /></n-form-item>
        <n-form-item :label="$t('skills.fldGlobs')"><n-dynamic-tags v-model:value="formData.globs" placeholder="*.ts" /></n-form-item>
        <n-form-item :label="$t('skills.fldEnvironments')"><n-input v-model:value="formData.environments" placeholder="node, python, all (comma separated)" /></n-form-item>
        <n-form-item :label="$t('skills.fldPrompt')"><n-input v-model:value="formData.prompt_template" type="textarea" :rows="3" /></n-form-item>
        <n-form-item :label="$t('skills.fldTools')"><n-dynamic-tags v-model:value="formData.tools" /></n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showCreateModal=false">{{ $t('common.cancel') }}</n-button>
        <n-button type="primary" @click="saveSkill">{{ editingSkill ? $t('skills.update') : $t('skills.create') }}</n-button>
      </template>
    </n-modal>

    <!-- Install / Search Modal（技能市场：搜索 GitHub + 直接 URL 安装） -->
    <n-modal v-model:show="showInstallModal" preset="card" :title="$t('skills.marketTitle')" style="max-width:520px" :mask-closable="false">
      <div style="display:flex;flex-direction:column;gap:14px">
        <!-- GitHub 搜索 -->
        <div class="gh-search-row">
          <n-input v-model:value="ghQuery" :placeholder="$t('skills.ghPlaceholder')" @keydown.enter.prevent="searchGithub" />
          <n-button type="primary" :loading="ghSearching" @click="searchGithub">{{ $t('skills.search') }}</n-button>
        </div>
        <div v-if="ghSearching" style="font-size:12px;color:var(--text-muted)">{{ $t('skills.ghSearching') }}</div>
        <div v-if="ghResults.length > 0" class="gh-results">
          <div v-for="(r, i) in ghResults" :key="i" class="gh-result">
            <div class="gh-result-info">
              <div class="gh-result-title">{{ r.title }}</div>
              <a class="gh-result-url" :href="r.url" target="_blank" rel="noopener">{{ r.url }}</a>
            </div>
            <n-button size="tiny" type="primary" :loading="installingUrl === r.url" @click="installFromUrl(r.url)">{{ $t('skills.install') }}</n-button>
          </div>
        </div>
        <div v-else-if="!ghSearching && ghSearched" style="font-size:12px;color:var(--text-muted)">{{ $t('skills.ghNoResults') }}</div>

        <n-divider style="margin:2px 0">{{ $t('skills.orInstallUrl') }}</n-divider>

        <n-input v-model:value="installUrl" placeholder="https://github.com/user/skill-repo" />
        <div v-if="installError" style="color:var(--error);font-size:12px">{{ installError }}</div>
        <div v-if="installSuccess" style="color:var(--success);font-size:12px">{{ installSuccess }}</div>

        <!-- 安装前安全扫描报告（先扫后装，danger 拦截） -->
        <div v-if="scanLoading" style="font-size:12px;color:var(--text-muted)">{{ $t('skills.scanChecking') }}</div>
        <div v-else-if="scanReport" class="scan-report" :class="scanReport.level">
          <div class="scan-head">
            <span>{{ $t('skills.scanTitle') }}</span>
            <n-tag size="tiny" :bordered="false" :type="scanReport.level === 'safe' ? 'success' : scanReport.level === 'warn' ? 'warning' : 'error'">
              {{ scanReport.level === 'safe' ? $t('skills.scanSafe') : scanReport.level === 'warn' ? $t('skills.scanWarn') : $t('skills.scanDanger') }}
            </n-tag>
          </div>
          <div v-if="scanReport.issues.length === 0" class="scan-clean">{{ $t('skills.scanClean') }}</div>
          <div v-else class="scan-issues">
            <div v-for="(it, i) in scanReport.issues" :key="i" class="scan-issue">
              <n-tag size="tiny" :bordered="false" :type="it.severity === 'high' ? 'error' : 'warning'">
                {{ it.severity === 'high' ? $t('skills.scanHigh') : $t('skills.scanHint') }}
              </n-tag>
              <span class="scan-rule">{{ it.rule }}</span>
              <span class="scan-file">{{ it.file }}<template v-if="it.line">:{{ it.line }}</template></span>
            </div>
          </div>
          <n-button v-if="scanReport.level === 'danger' && !installing" size="tiny" type="error" :loading="installing" @click="forceInstall">
            {{ $t('skills.scanForce') }}
          </n-button>
        </div>
      </div>
      <template #action>
        <n-button @click="closeInstallModal">{{ $t('skills.done') }}</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SvgIcon from '@/components/ui/SvgIcon.vue'

const { t } = useI18n({ useScope: 'global' })

interface CatalogItem {
  name: string; icon: string; description: string; category: string
  enabled: boolean; trigger_keywords: string; prompt_template: string
  tools: string[]; globs: string[]; environments: string; sort_order: number; core: boolean
  installed: boolean; id: string | null
}

interface Skill {
  id: string; name: string; name_en?: string; description: string; description_en?: string; icon: string; category: string
  enabled: number; trigger_keywords: string; prompt_template: string; tools: string
  globs?: string; environments?: string; sort_order: number; is_builtin: number
}

interface MarketCard extends CatalogItem {
  isBuiltin: boolean
}

const catalog = ref<CatalogItem[]>([])
const skills = ref<Skill[]>([])
const loading = ref(false)
const syncing = ref(false)
const exporting = ref(false)
const exportResult = ref('')
const searchQuery = ref('')
const activeCategory = ref('')
// 市场来源：builtin（内置）/ open（开源 browse.sh + GitHub 官方）
const marketSource = ref<'builtin' | 'open'>('builtin')
const openTab = ref<'browse' | 'github'>('browse')
const browseSkills = ref<any[]>([])
const browseCats = ref<string[]>([])
const browseCat = ref('')
const browseLoading = ref(false)
const ghSkills = ref<any[]>([])
const ghRepo = ref('anthropics/skills')
const ghLoading = ref(false)
let openSearchTimer: ReturnType<typeof setTimeout> | null = null

const browseCatOptions = computed(() => browseCats.value.map((c) => ({ label: c, value: c })))
const ghRepoOptions = [
  { label: 'anthropics/skills', value: 'anthropics/skills' },
  { label: 'openai/skills', value: 'openai/skills' },
  { label: 'huggingface/skills', value: 'huggingface/skills' },
  { label: 'NVIDIA/skills', value: 'NVIDIA/skills' },
]
const showCreateModal = ref(false)
const showInstallModal = ref(false)
const editingSkill = ref<Skill|null>(null)
const installingName = ref('')
const installUrl = ref('')
const installing = ref(false)
const installError = ref('')
const installSuccess = ref('')
// GitHub 技能市场搜索
const ghQuery = ref('')
const ghResults = ref<Array<{ title: string; url: string }>>([])
const ghSearching = ref(false)
const ghSearched = ref(false)
const installingUrl = ref('')
// 安装前安全扫描
interface ScanIssue { file: string; severity: 'high' | 'medium' | 'low'; rule: string; line?: number }
interface ScanReport { level: 'safe' | 'warn' | 'danger'; safe: boolean; issues: ScanIssue[]; skillNames: string[]; files: number }
const scanReport = ref<ScanReport | null>(null)
const scanLoading = ref(false)
const confirmInstall = ref(false)

const catIcons: Record<string,string> = { coding:'code', research:'search', system:'settings', automation:'zap', analysis:'activity', writing:'pen', general:'star' }
function getCategoryIcon(c:string) { return catIcons[c] || 'star' }

// 开源技能图标：按名称 hash 从调色板取色（browse.sh 首字母徽章）
const iconPalette = ['#4F46E5', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#6366F1']
function iconColor(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
  return iconPalette[h % iconPalette.length]
}

const categoryOptions = [
  { label:'Coding', value:'coding' },{ label:'Research', value:'research' },{ label:'System', value:'system' },
  { label:'Automation', value:'automation' },{ label:'Analysis', value:'analysis' },{ label:'Writing', value:'writing' },{ label:'General', value:'general' },
]

// 分类 Tab（横向浏览）
const categoryTabs = computed(() => {
  const defs = [
    { label: t('skills.catAll'), value: '', icon: '' },
    { label: t('skills.catCoding'), value: 'coding', icon: 'code' },
    { label: t('skills.catResearch'), value: 'research', icon: 'search' },
    { label: t('skills.catSystem'), value: 'system', icon: 'settings' },
    { label: t('skills.catAutomation'), value: 'automation', icon: 'zap' },
    { label: t('skills.catAnalysis'), value: 'analysis', icon: 'activity' },
    { label: t('skills.catWriting'), value: 'writing', icon: 'pen' },
    { label: t('skills.catGeneral'), value: 'general', icon: 'star' },
  ]
  return defs.map((d) => ({
    ...d,
    count: d.value === '' ? undefined : marketCards.value.filter((c) => c.category === d.value).length,
  }))
})

function categoryLabel(c: string): string {
  const m: Record<string, string> = { coding: t('skills.catCoding'), research: t('skills.catResearch'), system: t('skills.catSystem'), automation: t('skills.catAutomation'), analysis: t('skills.catAnalysis'), writing: t('skills.catWriting'), general: t('skills.catGeneral') }
  return m[c] || c
}

const formData = ref({ name:'', icon:'star', description:'', category:'general', trigger_keywords:'', prompt_template:'', tools:[] as string[], globs:[] as string[], environments:'all' })

/** 市场卡片 = 内置目录全部（17）+ 已安装的第三方技能 */
const marketCards = computed<MarketCard[]>(() => {
  const builtins: MarketCard[] = catalog.value.map((c) => ({ ...c, isBuiltin: true }))
  const thirdParty: MarketCard[] = skills.value
    .filter((s) => !s.is_builtin)
    .map((s) => ({
      name: s.name, icon: s.icon, description: s.description, category: s.category,
      enabled: !!s.enabled, trigger_keywords: s.trigger_keywords, prompt_template: s.prompt_template,
      tools: JSON.parse(s.tools || '[]'), globs: JSON.parse(s.globs || '[]'), environments: s.environments || 'all',
      sort_order: s.sort_order, core: false, installed: true, id: s.id, isBuiltin: false,
    }))
  return [...builtins, ...thirdParty]
})

const filteredCards = computed(() => {
  let list = marketCards.value
  if (activeCategory.value) list = list.filter((c) => c.category === activeCategory.value)
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || (c.trigger_keywords || '').toLowerCase().includes(q))
  }
  return list
})

const installedCount = computed(() => marketCards.value.filter((c) => c.installed).length)
const enabledCount = computed(() => marketCards.value.filter((c) => c.installed && c.enabled).length)

async function loadCatalog() {
  try { const r = await fetch('/api/skills/catalog'); catalog.value = await r.json() } catch (e) {}
}
async function loadSkills() {
  loading.value = true
  try { const r = await fetch('/api/skills'); skills.value = await r.json() } catch (e) {}
  loading.value = false
}
async function refresh() { await Promise.all([loadCatalog(), loadSkills()]) }

async function doSync() {
  syncing.value = true
  try {
    await fetch('/api/skills/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    await refresh()
  } catch (e) {} finally { syncing.value = false }
}

// ===== 开源市场 =====
function switchMarket(src: 'builtin' | 'open') {
  marketSource.value = src
  if (src === 'open') {
    if (openTab.value === 'browse') { loadBrowse(); loadBrowseCats() }
    else loadGithub()
  }
}

function switchOpenTab(tab: 'browse' | 'github') {
  openTab.value = tab
  if (tab === 'browse') { loadBrowse(); loadBrowseCats() }
  else loadGithub()
}

async function loadBrowse() {
  browseLoading.value = true
  try {
    const params = new URLSearchParams({ limit: '120' })
    const q = searchQuery.value.trim()
    if (q) params.set('q', q)
    if (browseCat.value) params.set('category', browseCat.value)
    const r = await fetch(`/api/skills/sources/browse?${params}`)
    browseSkills.value = await r.json()
  } catch (e) {} finally { browseLoading.value = false }
}

async function loadBrowseCats() {
  try {
    const r = await fetch('/api/skills/sources/browse/categories')
    browseCats.value = await r.json()
  } catch (e) {}
}

async function loadGithub() {
  ghLoading.value = true
  ghSkills.value = []
  try {
    const r = await fetch(`/api/skills/sources/github?repo=${encodeURIComponent(ghRepo.value)}`)
    ghSkills.value = await r.json()
  } catch (e) {} finally { ghLoading.value = false }
}

// 搜索输入：开源市场下防抖过滤 browse
watch(searchQuery, () => {
  if (marketSource.value !== 'open' || openTab.value !== 'browse') return
  if (openSearchTimer) clearTimeout(openSearchTimer)
  openSearchTimer = setTimeout(() => loadBrowse(), 400)
})

/** 从内置市场安装（直接建库，不经过 GitHub/扫描——内置目录可信） */
async function installBuiltin(c: MarketCard) {
  if (installingName.value) return
  installingName.value = c.name
  try {
    const body = {
      name: c.name, icon: c.icon, description: c.description, category: c.category,
      enabled: c.enabled !== undefined ? c.enabled : true,
      trigger_keywords: c.trigger_keywords, prompt_template: c.prompt_template,
      tools: c.tools, globs: c.globs, environments: c.environments,
      sort_order: c.sort_order, is_builtin: 1,
    }
    const res = await fetch('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error('install failed')
    await refresh()
  } catch (e: any) { installError.value = e.message } finally { installingName.value = '' }
}

/** 卸载（内置也可卸载，卸载后从市场重新安装） */
async function uninstallSkill(c: MarketCard) {
  if (!c.id) return
  await fetch(`/api/skills/${c.id}`, { method: 'DELETE' })
  await refresh()
}

/** 批量导出为 SKILL.md（.agents/skills，Claude Code/Codex/Cursor 可读） */
async function doExportAll() {
  exporting.value = true
  exportResult.value = ''
  try {
    const res = await fetch('/api/skills/export-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const data = await res.json()
    if (data.success) {
      exportResult.value = data.count ? t('skills.exportOk', { n: data.count }) : t('skills.exportNoSkills')
    } else {
      exportResult.value = data.error || t('skills.exportFailed')
    }
  } catch { exportResult.value = t('skills.exportFailed') } finally { exporting.value = false }
}

async function toggleSkill(id: string | null, enabled: boolean) {
  if (!id) return
  await fetch(`/api/skills/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
  await refresh()
}

function openCreateModal() {
  editingSkill.value = null
  formData.value = { name:'', icon:'star', description:'', category:'general', trigger_keywords:'', prompt_template:'', tools:[], globs:[], environments:'all' }
  showCreateModal.value = true
}
function editSkillById(id: string | null) {
  const s = skills.value.find((x) => x.id === id)
  if (!s) return
  editingSkill.value = s
  formData.value = { name: s.name, icon: s.icon || 'star', description: s.description, category: s.category, trigger_keywords: s.trigger_keywords, prompt_template: s.prompt_template, tools: JSON.parse(s.tools || '[]'), globs: JSON.parse(s.globs || '[]'), environments: s.environments || 'all' }
  showCreateModal.value = true
}

async function saveSkill() {
  const body = { ...formData.value, tools: JSON.stringify(formData.value.tools), globs: JSON.stringify(formData.value.globs) }
  try {
    if (editingSkill.value) { await fetch(`/api/skills/${editingSkill.value.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    else { await fetch('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
    showCreateModal.value = false
    await refresh()
  } catch (e) {}
}

async function doInstall() {
  if (!installUrl.value.trim()) { installError.value = t('skills.enterUrl'); return }
  await installFromUrl(installUrl.value.trim())
}

/** 开源市场安装：打开安装弹窗（安全扫描报告可见）+ 走标准安装流程 */
function openInstallFromUrl(url: string) {
  showInstallModal.value = true
  installUrl.value = url
  installError.value = ''
  installSuccess.value = ''
  installFromUrl(url)
}

/** 安装指定 GitHub URL（先安全扫描，danger 拦截；已扫描后 skipScan 安装） */
async function installFromUrl(url: string) {
  if (installingUrl.value) return // 防止重复点击
  installingUrl.value = url
  installing.value = true
  installError.value = ''
  installSuccess.value = ''
  try {
    // 1) 安装前安全扫描
    scanLoading.value = true
    scanReport.value = null
    const sr = await fetch('/api/skills/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
    const scan = await sr.json()
    scanReport.value = scan
    // danger：默认拦截，需用户点"仍然安装"（forceInstall）
    if (scan.level === 'danger' && !confirmInstall.value) {
      installError.value = t('skills.scanBlocked')
      return
    }
    // 2) 安装（已扫描过，skipScan 避免二次 clone）
    const r = await fetch('/api/skills/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, skipScan: true }) })
    const d = await r.json()
    if (d.success) {
      // 支持一次安装多个技能（monorepo 仓库）
      const names = d.skills && d.skills.length > 0 ? d.skills : (d.name ? [d.name] : [])
      installSuccess.value = t('skills.installedOk', { names: names.join(', ') })
      installUrl.value = ''
      setTimeout(() => { showInstallModal.value = false; installSuccess.value = '' }, 2000)
      await refresh()
    } else {
      installError.value = d.error || t('skills.installFailed')
    }
  } catch (e: any) { installError.value = e.message }
  finally { installing.value = false; installingUrl.value = '' }
}

/** 高危强制安装（用户明确了解风险后重试） */
async function forceInstall() {
  confirmInstall.value = true
  await installFromUrl(installingUrl.value)
}

/** 搜索 GitHub 第三方技能（后端复用 agent skill_search 逻辑） */
async function searchGithub() {
  const q = ghQuery.value.trim()
  if (!q) return
  ghSearching.value = true; ghSearched.value = false; ghResults.value = []
  try {
    const r = await fetch(`/api/skills/search?q=${encodeURIComponent(q)}`)
    if (!r.ok) throw new Error('Search failed')
    ghResults.value = await r.json()
  } catch (e: any) { installError.value = e.message }
  finally { ghSearching.value = false; ghSearched.value = true }
}

function closeInstallModal() {
  showInstallModal.value = false
  installUrl.value = ''
  installError.value = ''
  installSuccess.value = ''
  ghResults.value = []
  ghSearched.value = false
  scanReport.value = null
  confirmInstall.value = false
}

onMounted(async () => {
  await refresh()
  if (skills.value.length === 0) await doSync()
})
</script>

<style scoped>
.page-container { height:100%; display:flex; flex-direction:column }
.page-header { display:flex; align-items:flex-start; justify-content:space-between; padding:16px 24px; border-bottom:1px solid var(--border-color); flex-shrink:0 }
.page-header h2 { font-size:var(--text-lg); font-weight:600; margin:0 }
.page-desc { font-size:var(--text-sm); color:var(--text-muted); margin:4px 0 0 }
.header-actions { display:flex; gap:8px; align-items:center }
.search-wrap { position:relative; width:200px }
.search-icon-prefix { position:absolute; left:8px; top:50%; transform:translateY(-50%); color:var(--text-muted); pointer-events:none }
.search-input { width:100%; height:30px; padding:4px 8px 4px 28px; border-radius:var(--radius-sm); border:1px solid var(--border-input, var(--border-color)); background:var(--bg-primary); color:var(--text-primary); font-size:var(--text-sm); outline:none }
.search-input:focus { border-color:var(--accent) }

/* 分类 Tab 行 */
.cat-tabs { display:flex; gap:4px; padding:10px 24px 0; flex-shrink:0; flex-wrap:wrap }

/* 市场来源切换 */
.market-source-tabs { display:flex; gap:6px; padding:10px 24px 0; flex-shrink:0 }
.market-source-tab {
  display:inline-flex; align-items:center; gap:6px;
  padding:6px 16px; border-radius:8px; border:1px solid var(--border-color);
  background:var(--bg-primary); color:var(--text-secondary); font-size:13px; cursor:pointer;
  transition:all .15s;
}
.market-source-tab:hover { border-color:var(--border-hover); color:var(--text-primary) }
.market-source-tab.active { background:var(--accent); border-color:var(--accent); color:#fff }

/* 开源市场 */
.open-market { flex:1; display:flex; flex-direction:column; min-height:0; padding:10px 24px 0 }
.open-source-switch { display:flex; align-items:center; gap:6px; flex-shrink:0 }
.open-source-btn {
  padding:5px 14px; border-radius:999px; border:1px solid var(--border-color);
  background:var(--bg-primary); color:var(--text-secondary); font-size:12.5px; cursor:pointer; transition:all .15s;
}
.open-source-btn:hover { border-color:var(--border-hover); color:var(--text-primary) }
.open-source-btn.active { background:var(--accent); border-color:var(--accent); color:#fff }
.open-source-hint { font-size:11.5px; color:var(--text-muted); margin-left:8px }
.open-body { flex:1; display:flex; flex-direction:column; min-height:0; margin-top:10px }
.open-toolbar { display:flex; align-items:center; gap:12px; flex-shrink:0 }
.open-count { font-size:12px; color:var(--text-muted) }
.open-loading { font-size:12px; color:var(--accent) }
.open-empty { padding:40px 0; text-align:center; font-size:13px; color:var(--text-muted) }
.open-list { flex:1; overflow-y:auto; padding:12px 0 24px; display:grid; gap:10px; grid-template-columns:repeat(2,minmax(0,1fr)); align-content:start }
@media (max-width: 1100px) { .open-list { grid-template-columns:1fr } }
.open-card {
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  padding:12px 14px; border:1px solid var(--border-color); border-radius:10px;
  background:var(--bg-secondary); transition:border-color .15s;
}
.open-card:hover { border-color:var(--border-hover) }
.open-icon {
  width:40px; height:40px; border-radius:10px; flex-shrink:0;
  display:flex; align-items:center; justify-content:center;
  font-size:17px; font-weight:700; color:#fff;
}
.open-icon--git { background:#24292e; color:#fff }
.open-info { min-width:0; flex:1 }
.open-title { display:flex; align-items:center; gap:6px; font-size:13.5px; font-weight:600; color:var(--text-primary); flex-wrap:wrap }
.open-desc { font-size:12.5px; color:var(--text-secondary); margin-top:4px; line-height:1.55; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden }
.open-meta { display:flex; align-items:center; gap:10px; margin-top:6px; font-size:11.5px; color:var(--text-muted) }
.open-cat { font-size:10.5px; font-weight:600; padding:1px 6px; border-radius:3px; background:rgba(100,116,139,.1); color:var(--text-secondary); text-transform:uppercase }
.open-verified { color:var(--success,#16a34a) }
.cat-tab {
  display:inline-flex; align-items:center; gap:5px;
  padding:5px 12px; border-radius:999px; border:1px solid var(--border-color);
  background:var(--bg-primary); color:var(--text-secondary);
  font-size:12.5px; cursor:pointer; transition:all .15s;
}
.cat-tab:hover { border-color:var(--border-hover); color:var(--text-primary) }
.cat-tab.active { background:var(--accent); border-color:var(--accent); color:#fff }
.cat-count { font-size:10px; opacity:.75 }

.stats-bar { display:flex; gap:16px; padding:10px 24px; font-size:var(--text-xs); color:var(--text-muted); border-bottom:1px solid var(--border-color); flex-shrink:0 }
.skill-ops-bar { display:flex; align-items:center; gap:12px; padding:8px 24px; font-size:var(--text-xs); color:var(--text-muted); border-bottom:1px solid var(--border-color); flex-shrink:0 }
.skill-ops-hint { color:var(--text-muted); margin-right:auto }
.skill-ops-result { color:var(--success,#16a34a); font-size:12px }
.stats-bar strong { color:var(--text-secondary) }
.skills-grid { flex:1; overflow-y:auto; padding:24px; display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); align-content:start }
.skill-card { border:1px solid var(--border-color) }
.skill-card:hover { border-color:var(--border-hover) }
.skill-card.disabled { opacity:.6 }
.skill-header { display:flex; gap:12px; align-items:center }
.skill-icon { width:36px; height:36px; border-radius:var(--radius-md); display:flex; align-items:center; justify-content:center; flex-shrink:0; background:var(--bg-secondary); color:var(--text-secondary) }
.skill-icon.cat-coding { background:rgba(37,99,235,.1); color:var(--cat-coding) }
.skill-icon.cat-research { background:rgba(124,58,237,.1); color:var(--cat-research) }
.skill-icon.cat-system,.skill-icon.cat-general { background:rgba(100,116,139,.1); color:var(--cat-system) }
.skill-icon.cat-automation { background:rgba(217,119,6,.1); color:var(--cat-automation) }
.skill-icon.cat-analysis { background:rgba(5,150,105,.1); color:var(--cat-analysis) }
.skill-icon.cat-writing { background:rgba(219,39,119,.1); color:var(--cat-writing) }
.skill-info { flex:1; min-width:0 }
.skill-name { font-weight:600; font-size:var(--text-base); display:flex; align-items:center; gap:6px; flex-wrap:wrap }
.skill-tags { display:flex; gap:6px; align-items:center; margin-top:3px }
.skill-cat { font-size:10px; font-weight:600; padding:1px 5px; border-radius:3px; text-transform:uppercase }
.skill-cat.cat-coding { background:rgba(37,99,235,.08); color:var(--cat-coding) }
.skill-cat.cat-research { background:rgba(124,58,237,.08); color:var(--cat-research) }
.skill-cat.cat-system,.skill-cat.cat-general { background:rgba(100,116,139,.08); color:var(--cat-system) }
.skill-cat.cat-automation { background:rgba(217,119,6,.08); color:var(--cat-automation) }
.skill-cat.cat-analysis { background:rgba(5,150,105,.08); color:var(--cat-analysis) }
.skill-cat.cat-writing { background:rgba(219,39,119,.08); color:var(--cat-writing) }
.skill-desc { font-size:13px; color:var(--text-secondary); margin:8px 0 0; line-height:1.6 }
.skill-meta { display:flex; gap:6px; align-items:center; margin-top:8px; flex-wrap:wrap }
.skill-kw { font-size:var(--text-xs); color:var(--text-muted); margin-left:4px }
.skill-actions { display:flex; gap:4px; align-items:center }

/* 技能市场：GitHub 搜索 */
.gh-search-row { display:flex; gap:8px; }
.gh-results { display:flex; flex-direction:column; gap:8px; max-height:260px; overflow-y:auto; }
/* 安装前安全扫描报告 */
.scan-report { border:1px solid var(--border-color); border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:8px; background:var(--bg-secondary); }
.scan-report.danger { border-color: var(--error); }
.scan-head { display:flex; align-items:center; justify-content:space-between; font-size:13px; font-weight:500; }
.scan-clean { font-size:12px; color:var(--success); }
.scan-issues { display:flex; flex-direction:column; gap:6px; max-height:180px; overflow-y:auto; }
.scan-issue { display:flex; align-items:center; gap:8px; font-size:12px; }
.scan-rule { flex:1; min-width:0; }
.scan-file { color:var(--text-muted); font-family:var(--font-mono); font-size:11px; white-space:nowrap; }
.gh-result {
  display:flex; align-items:center; justify-content:space-between; gap:10px;
  padding:8px 10px; border:1px solid var(--border-color); border-radius:8px;
  background:var(--bg-secondary);
}
.gh-result-info { min-width:0; flex:1; }
.gh-result-title { font-size:13px; font-weight:500; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gh-result-url { font-size:11px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block; text-decoration:none; }
.gh-result-url:hover { color:var(--accent); text-decoration:underline; }
</style>
