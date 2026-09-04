<template>
  <aside class="detail-panel" :class="{ visible, maximized, wide: isWideTab }">
    <!-- Tab 头部 -->
    <div class="panel-tabs">
      <button
        v-for="tab in rowTabs"
        :key="tab.key"
        class="panel-tab"
        :class="{ active: activeTab === tab.key }"
        @click="switchMainOrMore(tab.key)"
      >
        <div class="tab-icon" v-html="tab.icon"></div>
        <span class="tab-label">{{ tab.label }}</span>
      </button>

      <!-- 更多(变更/时间线) 收进折叠，不常占顶行 -->
      <div class="more-wrap">
        <button class="panel-tab more-tab" :class="{ active: inMoreTab || tabMoreOpen }" @click="tabMoreOpen = !tabMoreOpen" title="更多">
          <div class="tab-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></div>
          <span class="tab-label">{{ inMoreTab ? (moreTabs.find(x => x.key === activeTab)?.label || '更多') : '更多' }}</span>
        </button>
        <div v-if="tabMoreOpen" class="tab-more-drop">
          <button v-for="tb in moreTabs" :key="tb.key" class="more-item" :class="{ active: activeTab === tb.key }" @click="switchMainOrMore(tb.key)">
            <div class="tab-icon" v-html="tb.icon"></div><span>{{ tb.label }}</span>
          </button>
        </div>
      </div>

      <button class="panel-close-btn" @click="emit('toggle')" :title="$t('detail.collapse')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
    </div>

    <!-- Tab 内容区 -->
    <div class="panel-body">
      <!-- 产物 Tab — AI 产出卡片流（对齐 Harness turn-deliverables：按轮分组、类型 icon、状态角标） -->
      <div v-if="activeTab === 'deliverables'" class="tab-content deliverables-tab">
        <div v-if="deliverableGroups.length === 0" class="tab-empty">
          <n-empty :description="$t('detail.noDeliverables')" />
        </div>
        <div v-for="g in visibleGroups" :key="g.turn" class="deliverable-group">
          <div class="deliverable-group-head" @click="toggleTurn(g.turn)">
            <svg class="deliverable-chevron" :class="{ open: isTurnExpanded(g.turn) }" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
            <span class="deliverable-turn">{{ $t('detail.turn', { n: g.turn }) }}</span>
            <span class="deliverable-summary" v-if="g.summary">{{ g.summary }}</span>
            <span class="deliverable-count">{{ g.items.length }}</span>
          </div>
          <div v-show="isTurnExpanded(g.turn)" class="deliverable-list">
            <div
              v-for="(item, idx) in g.items"
              :key="`${g.turn}-${idx}`"
              class="deliverable-card"
              :class="[item.kind, { error: item.status === 'error' }]"
              @click="onDeliverableClick(item)"
            >
              <div class="deliverable-icon">
                <svg v-if="item.kind === 'diagram'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              </div>
              <div class="deliverable-info">
                <div class="deliverable-name">{{ item.name }}</div>
                <div class="deliverable-path" v-if="item.path">{{ item.path }}</div>
              </div>
              <div class="deliverable-status" :class="item.status" v-if="item.kind === 'edit'">
                {{ item.status === 'error' ? $t('detail.failed') : $t('detail.done') }}
              </div>
              <button
                v-if="item.msgId"
                class="deliverable-jump"
                :title="$t('detail.jumpToMsg')"
                @click.stop="appStore.focusMessage(item.msgId)"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
              </button>
            </div>
            <!-- 图产物展开预览（点击图卡片切换） -->
            <div
              v-if="g.items.some((i) => i.svg && expandedDiagramSvg === i.svg)"
              class="deliverable-diagram-preview"
              v-html="expandedDiagramSvg"
            ></div>
          </div>
        </div>
        <button v-if="collapsedGroupCount > 0" class="deliverable-more" @click="showAllGroups = !showAllGroups">
          {{ showAllGroups ? $t('detail.collapseAll') : $t('detail.showMore', { n: collapsedGroupCount }) }}
        </button>
      </div>

      <!-- 文件 Tab — 工作区文件树（含「本次会话产物」分组，产物并入文件，去重复） -->
      <div v-if="activeTab === 'files'" class="tab-content">
        <!-- 本次会话产物（AI 生成/修改的文件，高亮标记） -->
        <div v-if="artifactFiles.length > 0" class="artifact-group">
          <div class="group-title">{{ $t('detail.sessionArtifacts') }}</div>
          <div class="file-list">
            <div
              v-for="f in artifactFiles"
              :key="f.path"
              class="file-row is-artifact"
              @click="loadAndPreviewFile(f.path)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <span class="file-name">{{ f.name }}</span>
              <span class="file-size" v-if="f.size">{{ formatSize(f.size) }}</span>
            </div>
          </div>
        </div>
        <!-- 工作区文件树 -->
        <div class="tab-hint">{{ $t('detail.currentDir') }}: {{ currentDir || '/' }}</div>
        <button class="refresh-btn" @click="() => loadFiles()" :disabled="loadingFiles">{{ $t('common.refresh') }}</button>
        <div v-if="loadingFiles" class="loading-hint">{{ $t('common.loading') }}</div>
        <div v-else-if="fileTree.length === 0" class="tab-empty">
          <n-empty :description="$t('detail.noFiles')" />
        </div>
        <div v-else class="file-list">
          <div
            v-for="f in fileTree"
            :key="f.path"
            class="file-row"
            @click="f.type === 'directory' ? navigateDir(f.path) : loadAndPreviewFile(f.path)"
          >
            <svg v-if="f.type === 'directory'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="file-name">{{ f.name }}</span>
            <span v-if="f.type === 'directory'" class="file-type-dir">{{ $t('detail.dir') }}</span>
            <span v-if="f.size" class="file-size">{{ formatSize(f.size) }}</span>
          </div>
        </div>
      </div>

      <!-- 变更 Tab -->
      <div v-if="activeTab === 'changes'" class="tab-content">
        <div class="tab-hint">{{ $t('detail.changesHint') }}</div>
        <div v-if="diffFiles.length === 0">
          <n-empty :description="$t('detail.noChanges')" />
        </div>
        <div v-else class="diff-list">
          <div v-for="(df, i) in diffFiles" :key="i" class="diff-item" @click="selectedDiff = i; showDiff()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/></svg>
            <span class="diff-filename">{{ df.name }}</span>
          </div>
        </div>
        <div v-if="showDiffEditor" class="diff-editor-container" ref="diffEditorRef"></div>
      </div>

      <!-- 预览 Tab（L1 实时渲染：AI 生成 html 自动弹出；手动点文件也可预览） -->
      <div v-if="activeTab === 'preview'" class="tab-content preview-tab">
        <div class="preview-toolbar">
          <span class="preview-label">{{ $t('detail.autoPreview') }}</span>
          <template v-if="isSvgPreview">
            <button class="preview-max-btn preview-act" @click="downloadSvg" :title="$t('detail.downloadSvg')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {{ $t('detail.downloadSvg') }}
            </button>
            <button class="preview-max-btn preview-act" @click="copySvg" :title="$t('detail.copySvg')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              {{ $t('detail.copySvg') }}
            </button>
          </template>
          <button class="preview-max-btn" @click="maximized = !maximized" :title="maximized ? $t('detail.previewRestore') : $t('detail.previewMax')">
            <svg v-if="!maximized" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
            <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
          </button>
        </div>
        <div class="tab-hint">{{ $t('detail.previewHint') }}</div>
        <!-- AI 生成图片预览：最近一次生图产物优先显示 -->
        <div v-if="previewImage" class="preview-image-box">
          <div class="preview-header">{{ previewImage.title || $t('detail.imagePreviewLabel') }}</div>
          <img class="preview-image-obj" :src="previewImage.data" alt="generated" />
          <div class="preview-image-actions">
            <!-- 下载生成图（2026-08-27 加：dataURL/URL 均可，SVG 有下载这里补 PNG/jpg） -->
            <button class="preview-max-btn" @click="downloadPreviewImage" :title="$t('detail.downloadImage')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
            <button class="preview-max-btn" @click="openInMax(previewImage.data)" :title="$t('detail.previewMax')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            </button>
          </div>
        </div>
        <div v-else-if="!livePreviewContent && !previewContent && !previewHtml" class="tab-empty">
          <n-empty :description="$t('detail.selectToPreview')" />
        </div>
        <HtmlPreview
          v-else-if="livePreviewContent || previewHtml"
          :content="livePreviewContent || previewHtml"
          :path="livePreviewPath || previewFileName"
          show-header
        />
        <div v-else-if="previewContent" class="preview-content">
          <div class="preview-header">{{ previewFileName }}</div>
          <pre class="preview-code"><code>{{ previewContent }}</code></pre>
        </div>
      </div>

      <!-- 时间线 Tab -->
      <!-- 时间线 Tab — 全对话轨迹回放（对齐 Harness TrajectoryTable：每轮思考/工具/产物/token 用量，可搜索） -->
      <div v-if="activeTab === 'timeline'" class="tab-content">
        <TimelinePanel
          :messages="chatStore.currentMessages"
          @preview-file="loadAndPreviewFile"
          @focus-message="appStore.focusMessage"
        />
      </div>

      <!-- AI 浏览器 Tab（Playwright 实接，实时显示 AI 操作画面） -->
      <div v-if="activeTab === 'browser'" class="tab-content browser-tab">
        <div class="browser-live">
          <span class="browser-live-dot" :class="{ active: browserStatus === '导航中' }" />
          <span class="browser-live-text">{{ browserStatus }}</span>
        </div>
        <div class="browser-url-row">
          <input
            v-model="browserUrlInput"
            class="browser-url-input"
            placeholder="输入网址，AI 浏览器打开…"
            @keyup.enter="goToUrl"
          />
          <button class="browser-go" @click="goToUrl">打开</button>
          <button class="browser-refresh" @click="refreshPage" title="刷新">刷新</button>
          <button class="browser-refresh" @click="browserGoBack" title="后退">后退</button>
          <button class="browser-maxbtn" @click="maximized = !maximized" :title="maximized ? '还原侧栏' : '放大看浏览器画面'">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
          </button>
        </div>
        <div class="browser-view">
          <div class="browser-chrome-bar">
            <span class="bc-dot" style="background:#ef4444" /><span class="bc-dot" style="background:#f59e0b" /><span class="bc-dot" style="background:#22c55e" />
            <span class="bc-url">{{ browserUrl || 'about:blank' }}</span>
          </div>
          <div class="browser-canvas">
            <div v-if="browserScreenshotBase64" class="browser-shot-wrap">
              <img :src="'data:image/jpeg;base64,' + browserScreenshotBase64" class="browser-shot clickable" @click="clickPage" alt="浏览器画面 (点击可操作)" />
              <div class="browser-hit-hint" v-if="browserScreenshotBase64">点击画面 = AI 浏览器替你点击</div>
            </div>
            <span v-else class="browser-placeholder" :class="{ loading: browserLoading }">
              {{ browserLoading ? 'AI 浏览器导航中…' : 'AI 浏览器就绪，输入网址打开（或等 AI 操作）' }}
            </span>
            <p class="browser-fail" v-if="browserFailHint">{{ browserFailHint }}</p>
          </div>
        </div>
        <div class="browser-console">
          <div v-for="(l, i) in browserLog" :key="i" class="browser-log-line">&gt; {{ l }}</div>
          <div v-if="browserLog.length === 0" class="browser-log-line muted">无操作记录</div>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick, onUnmounted, onMounted } from 'vue'
import { NEmpty } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { useChatStore } from '@/stores/chat'
import { useI18n } from 'vue-i18n'
import { extractFiles } from '@/types'
import type { ChatFlowNode } from '@/types'
import TimelinePanel from '@/components/chat/TimelinePanel.vue'
import HtmlPreview from '@/components/chat/HtmlPreview.vue'
import type { FileBlock } from '@/types'
import * as monaco from 'monaco-editor'

interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

const props = defineProps<{
  visible: boolean
  activeTab: 'deliverables' | 'files' | 'changes' | 'preview' | 'timeline' | 'browser'
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'update:tab', tab: 'deliverables' | 'files' | 'changes' | 'preview' | 'timeline' | 'browser'): void
}>()

const appStore = useAppStore()
const { t } = useI18n({ useScope: 'global' })
const chatStore = useChatStore()

// ===== L1/L2 实时预览：store 数据 + 800ms 防抖 + 配套 css/js 内联 =====
const maximized = ref(false)
/** 宽内容 Tab（预览/浏览器画面/变更 diff/图）：自动加宽至 58%（可被手动 maximized 覆盖的 default-wide） */
const isWideTab = computed(() => !maximized.value && (props.activeTab === "preview" || props.activeTab === "changes" || props.activeTab === "browser"))
const livePreviewPath = ref('')

// ===== SVG 预览操作：下载 / 复制代码 =====
const isSvgPreview = computed(() => {
  const p = (livePreviewPath.value || '').toLowerCase()
  return p.endsWith('.svg') || (livePreviewContent.value || '').trimStart().startsWith('<svg')
})
function downloadSvg() {
  const svg = livePreviewContent.value || ''
  if (!svg) return
  const blob = new Blob([svg], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = livePreviewPath.value || 'diagram.svg'
  a.click()
  URL.revokeObjectURL(url)
}
/** 下载预览的生成图（2026-08-27 加：dataURL 直接下；远程 URL 先转 Blob 再下，画质无损） */
async function downloadPreviewImage() {
  const img = previewImage.value
  if (!img?.data) return
  const title = (img.title || 'image').replace(/[\s\/\\:*?"<>|]+/g, '-').slice(0, 60)
  try {
    if (img.isUrl) {
      // 远程 URL（如 pollinations 直链）：fetch 转 Blob 下载（规避跨域 cors 直链 a.click 失效）
      const resp = await fetch(img.data)
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title}.png`
      a.click()
      URL.revokeObjectURL(url)
    } else {
      // dataURL / base64：直接创建链接下载
      const a = document.createElement('a')
      a.href = img.data
      a.download = `${title}.png`
      a.click()
    }
  } catch {
    // 兜底：直接打开新窗口（允许用户手动保存）
    window.open(img.data, '_blank')
  }
}
async function copySvg() {
  const svg = livePreviewContent.value || ''
  if (!svg) return
  try {
    await navigator.clipboard.writeText(svg)
    copiedSvg.value = true
    setTimeout(() => (copiedSvg.value = false), 1500)
  } catch { /* 剪贴板不可用时静默 */ }
}
const copiedSvg = ref(false)
const livePreviewContent = ref('')
let previewDebounce: ReturnType<typeof setTimeout> | null = null
watch(
  () => appStore.previewTs,
  () => {
    if (previewDebounce) clearTimeout(previewDebounce)
    previewDebounce = setTimeout(() => {
      livePreviewPath.value = appStore.previewPath
      livePreviewContent.value = inlineAssets(appStore.previewContent, appStore.previewPath, appStore.previewFiles)
    }, 800)
  },
)

/**
 * 内联配套资源：把 html 里引用的同目录 css/js 替换为内联内容。
 * iframe srcdoc 无 base URL，相对路径的 <link href="x.css"> / <script src="y.js"> 加载不到，
 * 必须内联才能完整渲染（支持 AI 生成 html+css+js 整套网页）。
 */
function inlineAssets(html: string, htmlPath: string, files: Record<string, string>): string {
  if (!html) return html
  let out = html
  // <link rel="stylesheet" href="xxx.css"> → <style>内容</style>
  out = out.replace(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi, (m, href: string) => {
    const css = findAsset(href, htmlPath, files, 'css')
    return css ? `<style>\n${css}\n</style>` : m
  })
  // 外链脚本（script 标签带 src）→ 内联内容
  out = out.replace(/<script[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (m, src: string) => {
    const js = findAsset(src, htmlPath, files, 'js')
    // 注意：源码禁止出现 script 闭合标签字面量（Vue SFC 解析器会截断 script 块），用拼接
    const openTag = '<scr' + 'ipt>'
    const closeTag = '</scr' + 'ipt>'
    return js ? openTag + '\n' + js + '\n' + closeTag : m
  })
  return out
}
function findAsset(href: string, htmlPath: string, files: Record<string, string>, ext: string): string {
  if (!/\.(css|js)$/i.test(href)) return ''
  // 去掉查询参数/锚点
  const clean = href.split(/[?#]/)[0]
  // 候选：绝对路径（/a/b.css）、相对路径（./b.css / b.css / ../x/b.css）
  const htmlDir = htmlPath.split('/').slice(0, -1).join('/')
  const candidates = [
    clean,
    `${htmlDir}/${clean.replace(/^\.\//, '')}`,
    `${htmlDir}/${clean}`,
  ]
  for (const c of candidates) {
    const hit = Object.keys(files).find((p) => {
      const norm = p.replace(/\\/g, '/')
      const nc = c.replace(/\\/g, '/')
      return norm === nc || norm.endsWith('/' + nc.split('/').pop())
    })
    if (hit) return files[hit]
  }
  return ''
}

/** 当前会话最后一条 assistant 消息的时序流（时间线数据源） */
const lastAssistantFlow = computed<ChatFlowNode[] | undefined>(() => {
  const msgs = chatStore.currentMessages
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && m.flow && m.flow.length) {
      return m.flow
    }
  }
  return undefined
})

// ===== Deliverables（产物卡片流：对齐 Harness turn-deliverables + fitProducedFiles）=====
interface DeliverableItem {
  kind: 'edit' | 'diagram'
  name: string
  path?: string
  turn: number
  status: 'done' | 'error'
  svg?: string
  /** 所属消息 id（产物↔消息联动：点击定位到消息区对应消息） */
  msgId?: string
}
interface DeliverableGroup {
  turn: number
  summary: string
  items: DeliverableItem[]
}

const FILE_PRODUCER_TOOLS = new Set(['file_write', 'multi_edit'])

function toolPath(args: string): string {
  try {
    const a = JSON.parse(args || '{}')
    return String(a.path || a.filePath || a.file || a.name || '')
  } catch { return '' }
}
function toolError(result?: string): boolean {
  if (!result) return false
  return /error|❌|失败|denied|refused/i.test(result.slice(0, 400))
}

const deliverableGroups = computed<DeliverableGroup[]>(() => {
  const msgs = chatStore.currentMessages
  const groups: DeliverableGroup[] = []
  let turn = 0
  for (const m of msgs) {
    if (m.role !== 'assistant') continue
    turn++
    const items: DeliverableItem[] = []
    let summary = ''
    for (const node of m.flow || []) {
      if (!summary && node.kind === 'text') summary = node.text.trim().replace(/\s+/g, ' ').slice(0, 24)
      if (node.kind === 'tool') {
        const t = node.tool
        if (FILE_PRODUCER_TOOLS.has(t.name)) {
          const path = toolPath(t.arguments)
          if (path) items.push({ kind: 'edit', name: path.split('/').pop() || path, path, turn, status: toolError(t.result) ? 'error' : 'done', msgId: m.id })
        }
      } else if (node.kind === 'diagram' && node.svg && !node.pending) {
        items.push({ kind: 'diagram', name: node.title || '图', turn, status: 'done', svg: node.svg.slice(0, 4000), msgId: m.id })
      }
    }
    // content file 块（最终产物；与 flow 工具产物去重，同路径保留 flow 优先）
    const seen = new Set(items.filter((i) => i.kind === 'edit' && i.path).map((i) => i.path))
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'file' && !seen.has(b.path)) {
        items.push({ kind: 'edit', name: b.name || b.path.split('/').pop() || b.path, path: b.path, turn, status: 'done', msgId: m.id })
      }
    }
    if (items.length > 0) groups.push({ turn, summary, items })
  }
  return groups.reverse() // 最新轮次在前
})

const expandedTurns = ref<Set<number>>(new Set())
const showAllGroups = ref(false)
const MAX_VISIBLE_GROUPS = 2
const collapsedGroupCount = computed(() => Math.max(0, deliverableGroups.value.length - MAX_VISIBLE_GROUPS))
const visibleGroups = computed(() =>
  showAllGroups.value ? deliverableGroups.value : deliverableGroups.value.slice(0, MAX_VISIBLE_GROUPS),
)
function isTurnExpanded(turn: number): boolean {
  // 默认展开最新轮，其余折叠（组头可点切换）
  if (expandedTurns.value.has(turn)) return true
  return turn === (deliverableGroups.value[0]?.turn)
}
function toggleTurn(turn: number) {
  const s = new Set(expandedTurns.value)
  if (s.has(turn)) s.delete(turn); else s.add(turn)
  expandedTurns.value = s
}
const expandedDiagramSvg = ref<string | null>(null)
function onDeliverableClick(item: DeliverableItem) {
  // C 2026-09-04 WorkBuddy: 点产物 → 右栏自动放大到近全屏看细节(而非仅缩略切换)
  maximized.value = true
  if (item.kind === 'diagram' && item.svg) {
    expandedDiagramSvg.value = expandedDiagramSvg.value === item.svg ? null : item.svg
    return
  }
  if (item.path) { loadAndPreviewFile(item.path); return }
}

// ----- Artifacts -----
const artifactFiles = computed<FileBlock[]>(() => {
  const msgs = chatStore.currentMessages
  const files: FileBlock[] = []
  for (const m of msgs) {
    if (m.role === 'assistant') {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'file') files.push(b as FileBlock)
      }
    }
  }
  return files
})

// ----- File Tree -----
const fileTree = ref<FileEntry[]>([])
const currentDir = ref('')
const loadingFiles = ref(false)

async function loadFiles(dir?: string) {
  loadingFiles.value = true
  try {
    const url = dir ? `/api/workspace/files?dir=${encodeURIComponent(dir)}` : '/api/workspace/files'
    const res = await fetch(url)
    if (res.ok) {
      const data = await res.json()
      fileTree.value = data.files || []
      currentDir.value = data.path || ''
    }
  } catch (e) {
    console.error('Failed to load workspace files:', e)
  } finally {
    loadingFiles.value = false
  }
}

function navigateDir(path: string) {
  loadFiles(path)
}

// Auto-load files when tab switches to 'files'
watch(() => ({ visible: true, tab: null }), () => {
  // handled by parent
})

// ----- Preview -----
const previewContent = ref('')
const previewHtml = ref('')
const previewFileName = ref('')
// AI 生成图预览（从 appStore 读：generate_image 工具产物 + flow 图点击）
const previewImage = computed(() => appStore.previewImage)
function openInMax(src: string) {
  // dataURL 在新窗口展示；URL 直接打开
  const w = window.open('', '_blank')
  if (w) {
    if (src.startsWith('data:')) { w.document.write(`<img src="${src}" style="width:100%;height:auto"/>`); w.document.close() }
    else w.location.href = src
  }
}

const diffEditorRef = ref<HTMLElement | null>(null)
const selectedDiff = ref(0)
const showDiffEditor = ref(false)
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null

// 变更数据源：store 里的 file_changed 事件（file_write 写入时后端推送，含真实改前/改后内容）
const diffFiles = computed(() => appStore.fileChanges.map((c: { name: string; path: string; oldContent: string; newContent: string }) => ({
  name: c.name,
  path: c.path,
  oldContent: c.oldContent,
  newContent: c.newContent,
})))

function showDiff() {
  showDiffEditor.value = true
  nextTick(() => {
    if (diffEditorRef.value) {
      if (diffEditor) diffEditor.dispose()
      const df = diffFiles.value[selectedDiff.value]
      diffEditor = monaco.editor.createDiffEditor(diffEditorRef.value, {
        theme: 'vs-dark', readOnly: true, automaticLayout: true,
        fontSize: 12, minimap: { enabled: false },
      })
      diffEditor.setModel({
        original: monaco.editor.createModel(df?.oldContent || '', 'text/plain'),
        modified: monaco.editor.createModel(df?.newContent || '', 'text/plain'),
      })
    }
  })
}

async function loadAndPreviewFile(filePath: string) {
  try {
    const res = await fetch(`/api/workspace/files/content?path=${encodeURIComponent(filePath)}`)
    if (res.ok) {
      const data = await res.json()
      const content = data.content.substring(0, 100000)
      previewFileName.value = filePath
      previewContent.value = ''
      previewHtml.value = ''

      // HTML 文件 → iframe 预览
      if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
        previewHtml.value = content
      } else {
        previewContent.value = content
      }
      // switch to preview tab
      emit('update:tab', 'preview')
    }
  } catch (e) {
    console.error('Failed to load file:', e)
  }
}

// Load files when panel becomes visible
watch(() => ({ visible: true }), () => {
  // no-op for now
})

// 监听外部触发的文件预览请求（从 ChatView 点击文件产出）
watch(() => appStore.previewFilePath, (path) => {
  if (path) {
    loadAndPreviewFile(path)
    appStore.previewFilePath = ''  // 消费后清空
  }
})

function switchTab(tab: 'deliverables' | 'files' | 'changes' | 'preview' | 'timeline' | 'browser') {
  emit('update:tab', tab)
  if (tab === 'files' && fileTree.value.length === 0) {
    loadFiles()
  }
}
// WorkBuddy 融合:顶行收敛——主频 产物/文件/预览/浏览器，变更+时间线收进「更多」(2026-09-04)
const tabMoreOpen = ref(false)
const MAIN_KEYS = ['deliverables', 'files', 'preview', 'browser'] as const
const MORE_KEYS = ['changes', 'timeline'] as const
const rowTabs = (tabs as { key: string }[]).filter((x) => (MAIN_KEYS as readonly string[]).includes(x.key))
const moreTabs = (tabs as { key: string }[]).filter((x) => (MORE_KEYS as readonly string[]).includes(x.key))
const inMoreTab = computed(() => (MORE_KEYS as readonly string[]).includes(props.activeTab))
function switchMainOrMore(k: string) { emit('update:tab', k as any); if ((MORE_KEYS as readonly string[]).includes(k)) tabMoreOpen.value = false }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ---- AI 浏览器（Playwright 实接，2026-09-01）----
const browserStatus = ref('待机')
const browserFailHint = ref('')
const browserUrl = ref('')
const browserUrlInput = ref('')
const browserScreenshotBase64 = ref('')
const browserLoading = ref(false)
const browserLog = ref<string[]>([])

async function goToUrl() {
  const url = browserUrlInput.value.trim()
  if (!url) return
  browserLoading.value = true
  browserStatus.value = '导航中'
  browserLog.value.push('导航 ' + url)
  try {
    const r = await fetch('/api/collab/browser/navigate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    })
    if (r.ok) {
      const d = await r.json()
      browserUrl.value = d.url || url
      browserScreenshotBase64.value = d.screenshot || ''
      browserStatus.value = '实时'
      browserFailHint.value = ''
    } else { browserStatus.value = '失败'; browserFailHint.value = '后端返回错误 ' + r.status + '，无法打开网页' }
  } catch {
    browserStatus.value = '断开'
    browserFailHint.value = '未能连到浏览器服务(后端 3000)。请先启动后端再打开网页'
  }
  browserLoading.value = false
  // 自动滑动到最新
  await nextTick()
}

async function refreshPage() {
  browserLoading.value = true
  browserStatus.value = '刷新中'
  try {
    const r = await fetch('/api/collab/browser/refresh', { method: 'POST' })
    if (r.ok) {
      const d = await r.json()
      browserUrl.value = d.url || browserUrl.value
      browserScreenshotBase64.value = d.screenshot || ''
      browserStatus.value = '实时'
    } else { browserStatus.value = '失败' }
  } catch { browserStatus.value = '断开' }
  browserLoading.value = false
}

// AI 浏览器 L2：双击镜像发送坐标点击 / 滚轮 / 停止
const browserClickMode = ref<'auto' | 'off'>('auto')
async function clickPage(e: MouseEvent) {
  const t = e.target as HTMLElement
  const img = t.closest('img')
  if (!img) return
  const r = img.getBoundingClientRect()
  const native = (img.naturalWidth || img.width)
  // 镜像宽可能 > 实浏览器宽，但坐标应相对截图实际像素：click 用相对图位置*viewport比例
  const X = ((e.clientX - r.left) / r.width) * img.naturalWidth
  const Y = ((e.clientY - r.top) / r.height) * img.naturalHeight
  // 后端 viewport(1000x700)相对图上自然像素比例，统一按 viewport 给
  await doAct({ action: 'click_at', x: Math.round(X * 1000 / img.naturalWidth), y: Math.round(Y * 1000 / img.naturalHeight) })
  browserLog.value.push(`点击 ${Math.round(X)},${Math.round(Y)}`)
}
async function browserGoBack() { await doAct({ action: 'back' }); browserLog.value.push('后退') }
let lastFrameTs = 0
let liveTimer: ReturnType<typeof setInterval> | null = null
// D2 画面自动同步: 当右栏在浏览器 tab，每~1.6s 取后端最近动作帧(含 AI 自主驾驶时的画面)，有更新即刷
async function pollLiveFrame() {
  if (!props.visible || props.activeTab !== "browser") return
  try {
    const r = await fetch('/api/collab/browser/latest')
    if (!r.ok) return
    const f = await r.json()
    if (f?.screenshot && f?.ts && f.ts !== lastFrameTs) {
      lastFrameTs = f.ts
      browserScreenshotBase64.value = f.screenshot
      if (f.url) browserUrl.value = f.url
    }
  } catch { /* 静默:保留现画面 */ }
}
onMounted(() => {
  lastFrameTs = 0
  liveTimer = setInterval(pollLiveFrame, 1600)
  // 切到 browser tab / 或一开始就停这里时立即取一帧
  pollLiveFrame()
})
onUnmounted(() => { if (liveTimer) { clearInterval(liveTimer); liveTimer = null } })
async function doAct(body: Record<string, unknown>) {
  browserLoading.value = true
  try {
    const r = await fetch('/api/collab/browser/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (r.ok) {
      const d = await r.json()
      if (d?.snapshot?.screenshot) { browserScreenshotBase64.value = d.snapshot.screenshot; browserUrl.value = d.snapshot.url || browserUrl.value }
      if (d?.result?.error) { browserStatus.value = '动作失败' }
    } else { browserStatus.value = '失败' }
  } catch { browserStatus.value = '断开' }
  browserLoading.value = false
}

const tabs = [
  { key: 'deliverables' as const, label: t('detail.tabArtifacts'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>' },
  { key: 'files' as const, label: t('detail.tabFiles'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' },
  { key: 'changes' as const, label: t('detail.tabChanges'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>' },
  { key: 'preview' as const, label: t('detail.tabPreview'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' },
  { key: 'timeline' as const, label: t('detail.tabTimeline'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17h18M3 12h18M3 7h18"/><circle cx="12" cy="17" r="1.5" fill="currentColor"/><circle cx="7" cy="12" r="1.5" fill="currentColor"/><circle cx="16" cy="7" r="1.5" fill="currentColor"/></svg>' },
  { key: 'browser' as const, label: t('detail.tabBrowser'), icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><circle cx="7" cy="7" r="1" fill="currentColor"/><circle cx="11" cy="7" r="1" fill="currentColor"/></svg>' },
]
</script>

<style scoped>
.detail-panel {
  width: 0;
  min-width: 0;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width var(--duration-normal) var(--ease-out),
              min-width var(--duration-normal) var(--ease-out),
              opacity var(--duration-fast) var(--ease-out);
  opacity: 0;
}

.detail-panel.visible {
  width: 320px;
  min-width: 320px;
  opacity: 1;
}

/* 宽内容 Tab（preview 预览/图、changes 变更 diff）自动加宽：长代码/表格/宽图不挤在 320px */
.detail-panel.visible.wide {
  width: 58%;
  min-width: 480px;
}

/* 预览最大化：展开覆盖聊天区，大屏查看（L1） */
.detail-panel.visible.maximized {
  width: 92%;
  min-width: 720px;
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 80;
  box-shadow: -4px 0 20px rgba(0, 0, 0, .18);
}

/* 预览 Tab 工具条 */
.preview-tab { display: flex; flex-direction: column; gap: 6px; }

/* 产物卡片流（对齐 Harness turn-deliverables） */
.deliverables-tab { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.deliverable-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
}
.deliverable-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  cursor: pointer;
  user-select: none;
  background: color-mix(in srgb, var(--bg-hover, rgba(127,127,127,0.06)) 60%, transparent);
}
.deliverable-group-head:hover { background: var(--bg-hover, rgba(127,127,127,0.1)); }
.deliverable-chevron { flex-shrink: 0; transition: transform 0.18s ease; color: var(--text-muted); }
.deliverable-chevron.open { transform: rotate(180deg); }
.deliverable-turn { font-size: 11px; font-weight: 600; color: var(--accent, #4f7cff); white-space: nowrap; }
.deliverable-summary {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.deliverable-count {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-hover, rgba(127,127,127,0.12));
  border-radius: 8px;
  padding: 0 6px;
  line-height: 15px;
}
.deliverable-list { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px 8px; }
.deliverable-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.deliverable-card:hover { background: var(--bg-hover, rgba(127,127,127,0.08)); border-color: var(--border-color); }
.deliverable-card.error { opacity: 0.75; }
.deliverable-icon {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent, #4f7cff);
  background: color-mix(in srgb, var(--accent, #4f7cff) 12%, transparent);
}
.deliverable-card.diagram .deliverable-icon { color: #a78bfa; background: color-mix(in srgb, #a78bfa 14%, transparent); }
.deliverable-info { flex: 1; min-width: 0; }
.deliverable-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.deliverable-path {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.deliverable-status {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 8px;
  white-space: nowrap;
}
.deliverable-status.done { color: #34d399; background: color-mix(in srgb, #34d399 14%, transparent); }
.deliverable-status.error { color: #f87171; background: color-mix(in srgb, #f87171 14%, transparent); }
.deliverable-jump {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
}
.deliverable-card:hover .deliverable-jump { opacity: 1; }
.deliverable-jump:hover { background: var(--bg-hover, rgba(127,127,127,0.12)); color: var(--accent, #4f7cff); }
.deliverable-diagram-preview {
  margin-top: 4px;
  padding: 6px;
  border-radius: 6px;
  background: var(--bg-input, rgba(127,127,127,0.06));
  overflow: auto;
  max-height: 280px;
}
.deliverable-diagram-preview :deep(svg) { width: 100%; height: auto; }
.deliverable-more {
  align-self: center;
  font-size: 11px;
  color: var(--text-muted);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 3px 12px;
  background: transparent;
  cursor: pointer;
}
.deliverable-more:hover { color: var(--accent, #4f7cff); border-color: var(--accent, #4f7cff); }

/* 本次会话产物分组（并入文件 tab） */
.artifact-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border-color);
}
.group-title { font-size: 11px; font-weight: 500; color: var(--accent, #4f7cff); }
.file-row.is-artifact { color: var(--accent, #4f7cff); }
.file-row.is-artifact .file-name { font-weight: 500; }
.preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.preview-label { font-size: 11px; color: var(--text-secondary); }
.preview-max-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 3px;
  display: flex;
  border-radius: 4px;
}
.preview-max-btn:hover { background: var(--border-color); color: var(--text-primary); }
.preview-tab .html-preview { min-height: 300px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); overflow: hidden; }

.panel-tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
  padding: 0 4px;
  gap: 1px;
  flex-shrink: 0;
}

.panel-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 0;
  gap: 3px;
  padding: 7px 4px;
  font-size: 11px;
  color: var(--text-muted);
  background: none;
  border: none;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
  white-space: nowrap;
}

.panel-tab:hover { color: var(--text-secondary); background: var(--bg-hover); }
.panel-tab.active { color: var(--accent); border-bottom: 2px solid var(--accent); margin-bottom: -1px; }

.tab-icon { display: flex; align-items: center; flex-shrink: 0; }
.tab-label { font-weight: 500; white-space: nowrap; flex-shrink: 0; }

.panel-max-btn {
  margin-left: auto;
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: var(--radius-sm);
  border: none; background: transparent; cursor: pointer; color: var(--text-muted);
}
.panel-max-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.more-wrap { position: relative; margin-left: 2px; }
.panel-tab.more-tab { border: none; background: transparent; padding: 5px 6px; }
.tab-more-drop { position: absolute; right: 0; top: 30px; z-index: 60; background: var(--bg-sidebar); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 4px; box-shadow: 0 6px 18px rgba(0,0,0,.15); min-width: 120px; }
.more-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; border: none; background: transparent; border-radius: var(--radius-sm); cursor: pointer; color: var(--text-secondary); font-size: 12px; text-align: left; }
.more-item.active { color: var(--text-primary); background: var(--bg-hover); }
.more-item:hover { background: var(--bg-hover); }
.panel-close-btn {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: var(--radius-sm);
  border: none; background: transparent; cursor: pointer; color: var(--text-muted);
}
.panel-close-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

.panel-body { flex: 1; overflow-y: auto; padding: 8px; }
.tab-content { display: flex; flex-direction: column; gap: 8px; }
.tab-hint { font-size: 11px; color: var(--text-muted); line-height: 1.4; }
.tab-empty { margin-top: 24px; }

/* ---- AI 浏览器 Tab（Playwright 实接）---- */
.browser-live { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted); }
.browser-live-dot { width: 6px; height: 6px; border-radius: 50%; background: #cbd5e1; }
.browser-live-dot.active { background: #22c55e; animation: bdot 1s infinite; }
@keyframes bdot { 0%,100%{opacity:1} 50%{opacity:.35} }
.browser-url-row { display: flex; gap: 4px; }
.browser-url-input { flex: 1; min-width: 0; border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 4px 8px; font-size: 11px; background: var(--bg-tertiary); }
.browser-go, .browser-refresh { border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); font-size: 11px; padding: 3px 8px; cursor: pointer; color: var(--text-secondary); }
.browser-maxbtn { border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); cursor: pointer; color: var(--text-secondary); display: inline-flex; align-items: center; justify-content: center; height: 20px; margin-left: 2px; padding: 0 5px; }
.browser-maxbtn:hover { border-color: var(--border-strong); color: var(--text-primary); }
.browser-view { border: 1px solid var(--border-color); border-radius: var(--radius-sm); overflow: hidden; }
.browser-chrome-bar { display: flex; align-items: center; gap: 4px; padding: 4px 8px; background: #0f172a; }
.bc-dot { width: 7px; height: 7px; border-radius: 50%; }
.bc-url { margin-left: auto; font-size: 10px; color: #64748b; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browser-canvas { min-height: 140px; display: flex; align-items: center; justify-content: center; background: var(--bg-tertiary); }
.browser-shot-wrap { width: 100%; overflow-x: auto; }
.browser-shot { display: block; width: 100%; height: auto; }
.browser-shot.clickable { cursor: crosshair; }
.browser-hit-hint { font-size: 10px; color: var(--text-tertiary); text-align: center; padding: 2px 0; }
.browser-fail { font-size: 12px; color: var(--danger, #e24b4a); text-align: center; padding: 6px 10px; line-height: 1.5; }
.browser-placeholder { font-size: 11px; color: var(--text-muted); padding: 10px; text-align: center; line-height: 1.5; }
.browser-placeholder.loading { color: var(--text-secondary); }
.browser-console { background: #0f172a; border-radius: var(--radius-sm); padding: 6px 8px; font-family: var(--font-mono, monospace); font-size: 10px; color: #6ee7a0; max-height: 90px; overflow-y: auto; }
.browser-log-line { margin: 2px 0; }
.browser-log-line.muted { color: #64748b; }

/* File list */
.file-list { display: flex; flex-direction: column; gap: 2px; }
.file-row {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border-radius: var(--radius-sm);
  cursor: pointer; font-size: 12px;
  transition: background var(--duration-fast);
}
.file-row:hover { background: var(--bg-hover); }
.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-path { font-size: 10px; color: var(--text-muted); max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.file-size { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.file-type-dir { font-size: 10px; color: #eab308; }

.refresh-btn {
  font-size: 11px; padding: 2px 8px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-color); background: transparent;
  cursor: pointer; color: var(--text-secondary);
}
.refresh-btn:hover { background: var(--bg-hover); }

.loading-hint { font-size: 11px; color: var(--text-muted); text-align: center; }

/* Preview */
.preview-header { font-size: 11px; color: var(--text-muted); padding: 4px 0; border-bottom: 1px solid var(--border-color); margin-bottom: 4px; }
.preview-code { font-family: var(--font-mono); font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-x: auto; max-height: 100%; padding: 8px; background: var(--bg-primary); border-radius: var(--radius-sm); color: var(--text-primary); }
.preview-image-box { display: flex; flex-direction: column; height: 100%; }
.preview-image-obj { width: 100%; height: auto; object-fit: contain; border-radius: var(--radius-sm); border: 1px solid var(--border-color); margin: 6px 0; }
.preview-image-actions { display: flex; gap: 6px; justify-content: flex-end; }
/* 最大化遮罩显示大图（DataURL 下内联渲染） */
.overlay-image { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,.75); display: flex; align-items: center; justify-content: center; cursor: zoom-out; }
.overlay-image img { max-width: 92%; max-height: 92%; border-radius: 8px; }.preview-iframe { width: 100%; min-height: 400px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); }

/* Diff */
.diff-list { display: flex; flex-direction: column; gap: 2px; }
.diff-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; font-size: 12px; border-radius: var(--radius-sm); cursor: pointer; }
.diff-item:hover { background: var(--bg-hover); }
.diff-filename { font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-editor-container { margin-top: 8px; height: 350px; border: 1px solid var(--border-color); border-radius: var(--radius-md); overflow: hidden; }
</style>
