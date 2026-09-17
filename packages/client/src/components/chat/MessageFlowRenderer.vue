<template>
  <div class="msg-flow-renderer" @click="onContentClick">
    <!-- 骨架屏（对齐 Harness skeleton + GPT 占位，2026-08-23）：AI 回复前 typing 指示 + 脉动骨架线 -->
    <div
      v-if="msg.role === 'assistant' && isLoading && !msg.content && (!msg.flow || msg.flow.length === 0)"
      class="skeleton-block"
    >
      <div class="typing-indicator">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="typing-text">{{ msg.plannerPending ? t('chat.plannerThinking') : t('chat.thinking') }}</span>
      </div>
      <div class="skeleton-line w70"></div>
      <div class="skeleton-line w45"></div>
      <div class="skeleton-line w55"></div>
    </div>

    <!-- 时序流：分段 MetaFold（WorkBuddy 同款）——正文/图始终原位，连续思考/工具聚合成"过程段"默认折叠成摘要条 -->
    <template v-if="msg.flow && msg.flow.length">
      <template v-for="(seg, si) in segments" :key="'seg-' + si">
        <!-- 分批展开：超长会话（展开态）顶部显示"显示更早 N 条"（WorkBuddy expand-budget 同款） -->
        <div
          v-if="si === 0 && hiddenCount > 0 && !props.isLoading"
          class="expand-earlier"
          @click="revealEarlier"
        >{{ t('chat.expandEarlier', { n: hiddenCount }) }}</div>
        <!-- text 段：正文原位显示。2026-08-25 13:5x 老板反馈"正式结果出来了上面的过程还平铺"——
             中间说明（"我先搜索/搜到几条候选"这类工具间叙述）是 text 段，旧规则"永不折叠"导致它们永远平铺在结果上方。
             改为：折叠态只显示最后一个 text 段（最终正文），中间说明收进折叠条；流式/展开态全部显示。 -->
        <div
          v-if="seg.kind === 'text' && shouldShowText(seg, si)"
          class="message-content"
          v-html="renderMarkdown(stripSourceLinks(seg.node.text).replace(SVG_CODE_BLOCK_RE, '').replace(SVG_BARE_RE, ''))"
        ></div>
        <!-- 引用来源卡片（对齐 GPT conversation-source：正文末尾来源链接渲染成可点卡片，2026-08-23） -->
        <SourceCards
          v-if="seg.kind === 'text' && !props.isLoading && seg.node.id === lastTextNodeId"
          :text="seg.node.text"
        />
        <!-- diagram 段：图是交付产物，始终显示（不随过程折叠消失） -->
        <div
          v-else-if="seg.kind === 'diagram'"
          class="flow-diagram-card"
          :class="{ pending: (seg.node as any).pending }"
          :title="t('chat.viewDiagram')"
          @click="openFlowDiagram(seg.node as any)"
        >
          <div v-if="seg.node.title || (seg.node as any).pending" class="flow-diagram-title">{{ (seg.node as any).pending ? t('chatui.webSummarizing') : seg.node.title }}</div>
          <div class="flow-diagram-body" v-html="seg.node.svg"></div>
        </div>
        <!-- image 段：AI 生成图片，始终显示（交付产物），点击放大 + 右下角下载 -->
        <div
          v-else-if="seg.kind === 'image'"
          class="flow-image-card"
          :title="t('chat.viewImage')"
          @click="openFlowImage(seg.node)"
        >
          <div v-if="seg.node.title" class="flow-image-title">{{ seg.node.title }}</div>
          <img class="flow-image-body" :src="seg.node.data" :alt="seg.node.title" />
          <button class="flow-image-download" :title="t('detail.downloadImage')" @click.stop="downloadFlowImage(seg.node)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
        </div>
        <!-- process 段：连续思考/工具聚合，默认折叠成摘要条（WorkBuddy MetaFold），点击展开该段 -->
        <template v-else-if="seg.kind === 'process'">
          <!-- 折叠条常驻（对齐 WorkBuddy MetaFold：header 始终存在，点击切换展开/收起）——
               展开态显示 open 样式（箭头朝上），过程节点在下方平铺；不再 v-if 消失导致无收起入口（老板 2026-08-21） -->
          <div class="process-collapse-bar" :class="{ open: !segCollapsed(si) }" @click="toggleSegment(si)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <span class="pc-label">{{ t('chat.processCollapsed') }}</span>
            <span class="pc-summary">{{ segSummary(seg) }}</span>
            <span v-if="foldElapsedText && si === lastProcessIndex" class="pc-duration">{{ foldElapsedText }}</span>
            <svg class="pc-arrow" :class="{ down: !segCollapsed(si) }" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </div>
          <!-- 段展开：段内节点按原顺序平铺（执行中/用户展开态） -->
          <template v-if="!segCollapsed(si)">
            <template v-for="(node, ni) in segmentVisibleNodes(si, seg)" :key="'sn-' + si + '-' + ni">
              <ThinkingGroup
                v-if="showReasoning && node.kind === 'thinking-group'"
                :turns="node.turns"
              />
              <ThinkingBlock
                v-else-if="showReasoning && node.kind === 'thinking'"
                :message="node.message || ''"
                :turn="node.turn"
                :completed="node.completed"
                :reasoning="node.reasoning"
              />
              <ToolErrorBoundary v-else-if="node.kind === 'tool'" :tool-name="node.tool.name">
                <ToolCallBlock
                  :tool-name="node.tool.name"
                  :args="node.tool.arguments"
                  :result="node.tool.result"
                  :status="node.tool.status"
                  :duration="node.tool.duration"
                  :stream-output="node.tool.streamOutput"
                  :started-at="node.tool.startedAt"
                  :file-diff="(node.tool as any).fileDiff"
                  :permission="permission"
                  :auto-approve-seconds="autoApproveSeconds"
                  @allow="emit('allow', node.tool)"
                  @deny="emit('deny', node.tool)"
                  @allow-session="emit('allow-session', node.tool)"
                />
              </ToolErrorBoundary>
            </template>
          </template>
        </template>
      </template>
    </template>

    <!-- 无时序流时（历史消息 / 简单模式）：直接渲染 content（多模型对比由 ChatView 外层处理） -->
    <div v-else-if="msg.content" class="message-content" v-html="renderMarkdown(contentWithoutDiagrams(msg))"></div>

    <!-- 重试提示（UI 禁 emoji：改用 SVG 旋转箭头图标） -->
    <div v-if="msg.retrying" class="retry-hint">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
      <span>{{ msg.retrying }}</span>
    </div>

    <!-- 结构化停止原因（对齐 WorkBuddy MaxTurnsExceededError：轮次超限/中断——明确告诉用户为什么停、怎么继续） -->
    <div v-if="msg.stopReason" class="stop-reason-banner">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span class="sr-text">{{ msg.stopReason.message || t('chat.stopReasonDefault') }}</span>
      <code v-if="msg.stopReason.checkpointId" class="sr-checkpoint">{{ msg.stopReason.checkpointId }}</code>
      <!-- 2026-08-26：有检查点时显示"继续"按钮，一键触发续跑（对齐停止原因横幅"可继续"） -->
      <button
        v-if="msg.stopReason.checkpointId"
        class="sr-continue"
        @click="emit('continueFromCheckpoint', msg.stopReason)"
      >{{ t('chat.continueFromCheckpoint') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark.css'
import type { ChatMessage, ChatFlowNode } from '@/types'
import { composeFoldSummary, formatDurationMs } from '@/utils/tool-summary'
import { stageOfTool, stageBreakdown, formatStageBreakdown, STAGE_I18N } from '@/utils/stage'
import { openFilePreview } from '@/utils/file-preview'
import { useAppStore } from '@/stores/app'
import ThinkingGroup from './ThinkingGroup.vue'
import SourceCards from './SourceCards.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallBlock from './ToolCallBlock.vue'
import ToolErrorBoundary from './ToolErrorBoundary.vue'

const props = defineProps<{
  msg: ChatMessage
  /** 是否正在流式接收（chatStore.isLoading） */
  isLoading: boolean
  /** 是否是最后一条消息（流式平铺判定用） */
  isLastMessage: boolean
  /** 是否显示推理（设置项） */
  showReasoning: boolean
  /** 当前会话权限档位 */
  permission: string
  /** 工具自动授权秒数 */
  autoApproveSeconds: number
}>()

const emit = defineEmits<{
  (e: 'allow', tool: any): void
  (e: 'deny', tool: any): void
  (e: 'allow-session', tool: any): void
  (e: 'continueFromCheckpoint', stopReason: any): void
}>()

const { t } = useI18n({ useScope: 'global' })

// ============ 正文路径点击定位（P0-1：事件委托 → 打开文件预览） ============
function onContentClick(e: MouseEvent) {
  const target = (e.target as HTMLElement)?.closest?.('.msg-path-link') as HTMLElement | null
  if (!target) return
  e.stopPropagation()
  const path = target.dataset.path || ''
  if (!path) return
  const start = target.dataset.start ? parseInt(target.dataset.start, 10) : undefined
  const end = target.dataset.end ? parseInt(target.dataset.end, 10) : undefined
  openFilePreview(path, start, end)
}

// ============ flow 图节点点击 → 右侧面板全尺寸预览（复用 appStore preview 机制） ============
const appStore = useAppStore()

function openFlowDiagram(node: Extract<ChatFlowNode, { kind: 'diagram' }>) {
  const name = `diagram-${(node.title || 'svg').replace(/[\s\/\\:*?"<>|]+/g, '-').slice(0, 30)}.svg`
  appStore.previewFiles = { ...appStore.previewFiles, [name]: node.svg }
  appStore.previewPath = name
  appStore.previewContent = node.svg
  appStore.previewTs = Date.now()
  appStore.detailPanelVisible = true
  appStore.setDetailPanelTab('preview')
}

/** 生成图点击 → 右侧 preview tab 全尺寸预览 */
function openFlowImage(node: Extract<ChatFlowNode, { kind: 'image' }>) {
  appStore.setPreviewImage(node.data, node.isUrl, node.title)
  appStore.detailPanelVisible = true
  appStore.setDetailPanelTab('preview')
}

/** 对话卡片内直接下载生成图（2026-08-27 加：dataURL/远程 URL 均可；URL 先 fetch 转 Blob 规避跨域） */
async function downloadFlowImage(node: Extract<ChatFlowNode, { kind: 'image' }>) {
  const title = (node.title || 'image').replace(/[\s\/\\:*?"<>|]+/g, '-').slice(0, 60)
  try {
    if (node.isUrl) {
      const resp = await fetch(node.data)
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title}.png`
      a.click()
      URL.revokeObjectURL(url)
    } else {
      const a = document.createElement('a')
      a.href = node.data
      a.download = `${title}.png`
      a.click()
    }
  } catch {
    window.open(node.data, '_blank')
  }
}

// ============ Markdown 渲染（从 ChatView 迁入） ============
// 代码块渲染对齐 WorkBuddy CodeBlock（cr-code-like-box）：header（语言标签 + 常驻复制按钮）+ pre 代码。
// 复制按钮带 .code-copy-btn class → ChatView enhanceCodeBlocks 事件委托统一处理；pre 带 has-copy 防重复注入。
const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(str: string, lang: string): string {
    let code: string
    // 无语言代码块语言标签对齐 WorkBuddy（language || "code"）——不显示 plaintext
    let safeLang = 'code'
    if (lang && hljs.getLanguage(lang)) {
      safeLang = lang
      try {
        code = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
      } catch {
        code = md.utils.escapeHtml(str)
      }
    } else {
      code = md.utils.escapeHtml(str)
    }
    const copyLabel = t('chat.copy')
    return (
      `<div class="cr-code-like-box">` +
      `<div class="cr-code-like-box__header">` +
      `<span class="cr-code-block__language">${md.utils.escapeHtml(safeLang)}</span>` +
      `<button type="button" class="cr-code-block__copy-button code-copy-btn" title="${md.utils.escapeHtml(copyLabel)}">${copyLabel}</button>` +
      `</div>` +
      `<div class="cr-code-like-box__content"><pre class="hljs has-copy"><code>${code}</code></pre></div>` +
      `</div>`
    )
  },
})

/** SVG 提取/移除：①```svg/```xml 语言代码块整体移除（不要求含 <svg> 标签——模型输出可能缺起始标签，一律移除防裸露）②裸 <svg>...</svg> */
const SVG_CODE_BLOCK_RE = /```(?:svg|xml)\s*[\s\S]*?```/g
const SVG_BARE_RE = /<svg[\s\S]*?<\/svg>/g

/** 正文路径链接（WorkBuddy inline-code path-detector 同款：正文里的代码路径可点击定位） */
const PATH_LINK_RE = /((?:\/|~\/|\.{1,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.(?:[tj]sx?|vue|ts|js|mjs|cjs|json|md|mdx|css|scss|sass|less|py|go|rs|java|kt|c|h|cpp|hpp|cs|php|rb|swift|yml|yaml|toml|ini|cfg|sh|bash|zsh|fish|html|htm|svg|png|jpe?g|gif|webp|ico|db|sqlite|sql|txt|log|xml|env|lock|editorconfig|gitignore|dockerfile|graphql|proto|wasm))/gi

/**
 * 在渲染后的 HTML 上做正文路径检测：文本节点中的代码路径 → 可点击 span（跳过代码块 pre 内部）。
 * 行号后缀（:12 / L12-30）保留在 span 文本里一并点击。
 */
function linkifyPaths(html: string): string {
  if (!html || typeof document === 'undefined') return html
  const div = document.createElement('div')
  div.innerHTML = html
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  while (walker.nextNode()) {
    const n = walker.currentNode as Text
    if (!n.nodeValue || !PATH_LINK_RE.test(n.nodeValue)) continue
    if (n.parentElement?.closest('pre')) continue
    textNodes.push(n)
  }
  for (const node of textNodes) {
    const text = node.nodeValue || ''
    PATH_LINK_RE.lastIndex = 0
    const frag = document.createDocumentFragment()
    let last = 0
    let m: RegExpExecArray | null
    while ((m = PATH_LINK_RE.exec(text))) {
      const path = m[0]
      const idx = m.index
      // 行号后缀：紧随路径的 :N / :N-M / L N-M
      const rest = text.slice(idx + path.length, idx + path.length + 12)
      const lm = rest.match(/^\s*:\s*(\d+)(?:\s*[-–]\s*(\d+))?\b/)
      const lineSuffix = lm ? lm[0].trim() : ''
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)))
      const span = document.createElement('span')
      span.className = 'msg-path-link'
      span.dataset.path = path
      if (lm) {
        span.dataset.start = lm[1]
        if (lm[2]) span.dataset.end = lm[2]
      }
      span.textContent = path + (lm ? `:${lm[1]}${lm[2] ? `-${lm[2]}` : ''}` : '')
      frag.appendChild(span)
      last = idx + path.length + (lm ? lm[0].length : 0)
      PATH_LINK_RE.lastIndex = last
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    if (last > 0) node.parentNode?.replaceChild(frag, node)
  }
  return div.innerHTML
}

function renderMarkdown(content: string) {
  if (!content) return ''
  return linkifyPaths(md.render(content))
}

/** 剥离正文中"连续 ≥2 个 markdown 链接"的来源段（2026-08-25：模型常把 [新浪财经1](url) [新浪财经2](url)…
 *  挤在正文末尾一行；SourceCards 已增强提取成卡片，正文中移除链接串避免"集中一行"，单个链接保留（正文内嵌引用正常） */
function stripSourceLinks(md: string): string {
  return md.replace(/(?:\[[^\]]{1,60}\]\(\s*https?:\/\/[^)\s]+\s*\)[ \t\u3000]*){2,}/g, '')
}

/** 提取消息里的 SVG 图（与 ChatView 的 autoExtractDiagrams 对应，content 里保留图卡片） */
function contentWithoutDiagrams(msg: ChatMessage): string {
  let s = String((msg as any).content || '')
  if (Array.isArray((msg as any).content)) {
    s = ((msg as any).content as any[])
      .map((b: any) => (b.type === 'text' ? b.text : ''))
      .join('\n')
  }
  return s
}

// ============ Flow 显示（从 ChatView 迁入） ============
type FlowDisplayNode =
  | ChatFlowNode
  | { kind: 'thinking-group'; turns: Array<Extract<ChatFlowNode, { kind: 'thinking' }>> }

function flowDisplay(flow: ChatFlowNode[] | undefined): FlowDisplayNode[] {
  if (!flow) return []
  const out: FlowDisplayNode[] = []
  let group: Array<Extract<ChatFlowNode, { kind: 'thinking' }>> = []
  const flushGroup = () => {
    if (group.length === 0) return
    const meaningful = group.filter((t) => t.reasoning || !t.completed)
    if (meaningful.length > 0) out.push({ kind: 'thinking-group', turns: meaningful })
    group = []
  }
  for (const node of flow) {
    if (node.kind === 'thinking' && node.completed) {
      group.push(node)
    } else {
      flushGroup()
      out.push(node)
    }
  }
  flushGroup()
  return out
}

// ============ 分段 MetaFold（WorkBuddy 同款）：正文/图原位，连续思考/工具聚合成"过程段"默认折叠 ============
type FlowSegment =
  | { kind: 'text'; node: Extract<ChatFlowNode, { kind: 'text' }> }
  | { kind: 'diagram'; node: Extract<ChatFlowNode, { kind: 'diagram' }> }
  | { kind: 'image'; node: Extract<ChatFlowNode, { kind: 'image' }> }
  | { kind: 'process'; nodes: FlowDisplayNode[]; tools: number; thinks: number }

function segmentFlow(nodes: FlowDisplayNode[]): FlowSegment[] {
  const segs: FlowSegment[] = []
  let cur: FlowDisplayNode[] = []
  const flush = () => {
    if (cur.length === 0) return
    segs.push({
      kind: 'process',
      nodes: cur,
      tools: cur.filter((n) => n.kind === 'tool').length,
      thinks: cur.filter((n) => n.kind === 'thinking' || n.kind === 'thinking-group').length,
    })
    cur = []
  }
  for (const n of nodes) {
    if (n.kind === 'diagram') {
      // 图是交付产物：始终单独成段显示（不随过程折叠消失）
      flush()
      segs.push({ kind: 'diagram', node: n })
    } else if (n.kind === 'image') {
      // 生成图是交付产物：单独成段，始终显示
      flush()
      segs.push({ kind: 'image', node: n })
    } else if (n.kind === 'text' && n.text.trim()) {
      // 正文（含中间说明/正式回复/最终报告）一律单独成段、永不折叠——
      // WorkBuddy 同款（isFoldableContent 仅 reasoning+tool-call，text 不折叠）：正式回复不隐藏（老板 2026-08-21）
      flush()
      segs.push({ kind: 'text', node: n })
    } else {
      // thinking/tool → 过程段（完成态收进折叠条）
      cur.push(n)
    }
  }
  flush()
  return segs
}

/** 合并 process 段（完成态：所有过程合一，一个折叠条收起全部过程） */
function makeProcessSeg(nodes: FlowDisplayNode[]): FlowSegment {
  return {
    kind: 'process',
    nodes,
    tools: nodes.filter((n) => n.kind === 'tool').length,
    thinks: nodes.filter((n) => n.kind === 'thinking' || n.kind === 'thinking-group').length,
  }
}

/**
 * 分段结果：
 * - 执行中（流式中）：保持分段结构，全程平铺可视化（工具紧凑卡片 + 中间说明 + 思考实时可见）——不逐段折叠
 * - 完成态：所有过程段合并为一个折叠条（"过程执行完整体折叠，非逐段折叠"——老板 2026-08-21），只出结论
 */
const segments = computed<FlowSegment[]>(() => {
  const segs = segmentFlow(visibleFlow(props.msg.flow))
  if (!shouldCollapse(props.msg)) return segs
  // 完成态：所有 process 段合并为一个折叠条（不被中间的 text 说明打断——旧实现遇 text 就 flush，
  // 导致"2 个一模一样"的多个折叠条，老板 2026-08-25 反馈）；text/diagram 保持原顺序排后面
  const out: FlowSegment[] = []
  let buf: FlowDisplayNode[] = []
  for (const s of segs) {
    if (s.kind === 'process') buf.push(...s.nodes)
    else out.push(s)
  }
  if (buf.length) out.unshift(makeProcessSeg(buf))
  return out
})

/** 最后一个 text 段节点 id（来源卡片只挂在最后一段正文后，避免每条 text 都重复渲染） */
const lastTextNodeId = computed(() => {
  const segs = segments.value
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].kind === 'text') return (segs[i] as any).node.id as string
  }
  return ''
})

/** 段级展开态：用户点开单个过程段后该段保持展开（index 语义，flow 变化时重置） */
const segOpen = reactive<Record<number, boolean>>({})

/** 过程段是否折叠：执行中平铺可视化（不折叠）；完成态折叠成一条。仅全展开模式或用户手动展开的段除外 */
function segCollapsed(si: number): boolean {
  if (props.msg.processCollapsed === false) return false
  if (segOpen[si]) return false
  // 2026-08-25 11:3x 修复的补充：显式折叠意图（processCollapsed=true，含 content_chunk 判定的"最终正文已开始"）
  // 必须优先于"流式中平铺"默认——否则正文打字机慢播期间（SSE 未 done，isLoading 仍 true）过程永远平铺，
  // 折叠实际只在 done 之后才发生，等于修复没生效（老板二次反馈"准备输出结果没折叠"）。
  if (props.msg.processCollapsed !== true && isMsgStreaming(props.msg)) return false
  return true
}

/**
 * 折叠态下 text 段是否显示：只保留最后一个 text 段（最终正文），
 * 中间的"工具间说明"text 段（"我先搜索/搜到几条候选"这类模型叙述）收进折叠条。
 * 流式/展开态（processCollapsed 非 true）全部显示（保持现有交互）。
 */
function shouldShowText(seg: FlowSegment, si: number): boolean {
  if (seg.kind !== 'text') return false
  if (props.msg.processCollapsed !== true) return true
  let lastTextIdx = -1
  for (let i = 0; i < segments.value.length; i++) {
    if (segments.value[i].kind === 'text') lastTextIdx = i
  }
  return si >= lastTextIdx
}

/** 点击过程段折叠条：展开/收起该段 */
function toggleSegment(si: number) {
  segOpen[si] = !segOpen[si]
}
/** 段展开后全部节点原位显示（回归老板 2026-08-21 原则："用户手动展开 = 想看全部 → 一次全出"；
 *  超长会话分批兜底由顶层 visibleFlow/revealEarlier 处理，段内不做二次分批） */
function segmentVisibleNodes(si: number, seg: FlowSegment): FlowDisplayNode[] {
  void si
  return (seg as { nodes: FlowDisplayNode[] }).nodes || []
}

/** 工具节点是否还在执行（未终态）——类型守卫：true 时 n 收窄为 tool 节点 */
function isToolRunning(n: FlowDisplayNode): n is Extract<FlowDisplayNode, { kind: 'tool' }> {
  return n.kind === 'tool' && !['done', 'error', 'denied', 'cancelled', 'skipped'].includes(n.tool.status)
}

/** 写文件行数进度（复用 ToolCallBlock liveLines 同款正则，匹配后端"📝 写入 N / M 行"）：
 *  折叠条上实时滚动显示，执行过程收拢后进度仍可见 */
function runningLines(n: Extract<FlowDisplayNode, { kind: 'tool' }>): string {
  const s = n.tool.streamOutput || ''
  const m = s.match(/写入\s*(\d+)\s*\/\s*(\d+)\s*行/)
  if (m) return `+${m[1]} 行`
  const m2 = s.match(/wrote\s*(\d+)\s*\/\s*(\d+)\s*lines/i)
  if (m2) return `+${m2[1]} lines`
  return ''
}

/** 段摘要：流式中显示当前活动动作（"正在思考" / "正在读取 src/utils.ts"，写文件带实时行数），完成显示静态统计 */
function segSummary(seg: FlowSegment): string {
  if (seg.kind !== 'process') return ''
  if (isMsgStreaming(props.msg)) {
    const nodes = seg.nodes
    // ①未完成的思考 → "正在思考"
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]
      if (props.showReasoning && n.kind === 'thinking' && !n.completed) {
        return t('chat.processRunning', { action: t('chat.thinking') })
      }
    }
    // ②运行中的工具 → 动作+宾语（"读取 src/utils.ts"）；写文件追加实时行数（"+42 行"）
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]
      if (isToolRunning(n)) {
        const atom = composeFoldSummary([n] as ChatFlowNode[], (key: string) => t(key) || key)
        const lines = runningLines(n)
        // P1-02：拿不到宾语时退到「阶段名」，绝不把内部工具名(browser/shell_exec)抛给用户
        const fallback = t(STAGE_I18N[stageOfTool(n.tool.name)]) || t('chat.statusWorking')
        return t('chat.processRunning', { action: atom || fallback }) + (lines ? ` · ${lines}` : '')
      }
    }
  }
  // P1-02：完成态改为「阶段画像」（读取 3 · 编辑 2 · 验证 1），替代原来的"N 次工具调用"——
  // 同样紧凑，但用户看得懂这次到底做了什么。无工具时退回原有计数。
  const parts: string[] = []
  const tt = t as unknown as (k: string, p?: Record<string, unknown>) => string
  const stages = formatStageBreakdown(stageBreakdown(seg.nodes), tt)
  if (stages) parts.push(stages)
  else if (seg.tools) parts.push(t('chat.processTools', { n: seg.tools }))
  if (props.showReasoning && seg.thinks) parts.push(t('chat.processThinking', { n: seg.thinks }))
  // 纯说明文本段（无工具无思考）兜底：显示"执行过程"，避免空摘要
  if (!parts.length) return t('chat.processCollapsed')
  return parts.join(' · ')
}

/** 最后一个过程段的 index（折叠条上的总耗时只显示一次） */
const lastProcessIndex = computed(() => {
  const segs = segments.value
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].kind === 'process') return i
  }
  return -1
})

// ============ 折叠条实时计时（执行中"已用时 Xs"每秒增长；完成后"已完成 Xs"静态） ============
const foldNow = ref(Date.now())
let foldTimer: ReturnType<typeof setInterval> | null = null
watch(
  () => [props.isLoading, props.isLastMessage],
  ([loading, last]) => {
    if (loading && last) {
      foldNow.value = Date.now()
      if (!foldTimer) foldTimer = setInterval(() => { foldNow.value = Date.now() }, 1000)
    } else if (foldTimer) {
      clearInterval(foldTimer)
      foldTimer = null
    }
  },
)
onUnmounted(() => { if (foldTimer) clearInterval(foldTimer) })

/** 折叠条耗时文案：流式中"已用时 Xs"（实时，复用 footer 同款 i18n）；完成后"已完成 Xs + 性能指标" */
const foldElapsedText = computed(() => {
  const msg = props.msg
  if (msg.elapsedMs) {
    // 完成态：已完成 Xs · 首字 X.Xs · 打字 XX 字符/s（对齐 Harness turn-metrics 性能指标）
    let text = `${t('chat.turnCompleted')} ${formatDurationMs(msg.elapsedMs)}`
    if (msg.firstTokenMs) text += ` · ${t('chatui.ttft', { n: (msg.firstTokenMs / 1000).toFixed(1) })}`
    const chars = msg.streamChars || 0
    const elapsedSec = msg.elapsedMs / 1000
    if (chars > 50 && elapsedSec > 0.5) {
      const cps = Math.round(chars / elapsedSec)
      text += ` · ${t('chatui.charPerSec', { n: cps })}`
    }
    return text
  }
  if (msg.startedAt && props.isLoading && props.isLastMessage) {
    return t('chatui.timingInProgress', { n: formatDurationMs(foldNow.value - msg.startedAt) })
  }
  return ''
})

// ============ 过程展开（用户主动展开 = 想看全部 → 一次全出；超长会话自动分批兜底性能） ============
/** 超长会话阈值：节点数超过此值自动切换分批（默认仍全展开，尊重"展开即全部"决策） */
const LONG_FLOW_THRESHOLD = 200
/** 单批渲染预算：节点数（超长会话分批时每批条数） */
const BATCH_SIZE = 50
/** 已显示的最大节点数（默认全部展开：9999 等同不限；超长会话自动下调） */
const visibleCount = ref(9999)

/** 展开态可见节点：尾部优先取 visibleCount 项（默认全量；>200 节点自动分批尾部 50，防长会话卡顿） */
function visibleFlow(flow: ChatFlowNode[] | undefined): FlowDisplayNode[] {
  const nodes = flowDisplay(flow)
  // 完成态（折叠）：展开折叠条要看完整过程，不分批（超长会话流式中分批只影响流式展示，完成后恢复全量）
  if (shouldCollapse(props.msg)) return nodes
  // 超长会话（>200 节点）且仍处全展开态 → 自动切换分批（尾部优先）
  if (nodes.length > LONG_FLOW_THRESHOLD && visibleCount.value === 9999) {
    visibleCount.value = BATCH_SIZE
  }
  if (nodes.length <= visibleCount.value) return nodes
  return nodes.slice(nodes.length - visibleCount.value)
}

/** 当前被隐藏的节点数（"显示更早 N 条"） */
const hiddenCount = computed(() => {
  if (shouldCollapse(props.msg)) return 0
  const nodes = flowDisplay(props.msg.flow)
  return Math.max(0, nodes.length - visibleCount.value)
})

/** 点击"显示更早"：多显示一批（WorkBuddy 尾部优先逐批展开） */
function revealEarlier() {
  visibleCount.value += BATCH_SIZE
}

/** 消息变化（新节点/流式结束）时重置分页：超长会话流式中尾部优先，正常会话保持全展开 */
watch(
  () => props.msg.flow?.length,
  () => {
    if (props.isLoading) {
      // 流式中：>阈值才分批（尾部优先防卡顿）；正常会话全展开（不藏过程内容）
      visibleCount.value = (props.msg.flow?.length || 0) > LONG_FLOW_THRESHOLD ? BATCH_SIZE : 9999
      // flow 变化 → 段 index 失效，重置段展开态（流式中本就全展开，无感知）
      for (const k of Object.keys(segOpen)) delete segOpen[+k]
    }
  },
)

/**
 * 当前消息是否正在流式接收（最后一条且 chatStore 加载中）。
 * WorkBuddy 逻辑：执行中全程平铺可视化，完成出结果才折叠。
 */
/** 工具终态集合（非终态 = 仍在执行） */
const TOOL_TERMINAL = new Set(['done', 'error', 'denied', 'cancelled', 'skipped'])

/**
 * 消息是否仍在流式：
 * ①消息内仍有未完成节点（running 工具 / 未完成思考）→ 流式中（过程平铺）
 * ②isLoading 且是最后一条 → 流式中
 * 双条件：即使 isLoading 翻转有延迟（done→打字机收尾 gap），工具全部终态后立即折叠
 * （老板 2026-08-21：AI 都回复正式结果了，上面的执行过程还没折叠）
 */
function isMsgStreaming(msg: ChatMessage): boolean {
  if (msg.flow?.some((n) => n.kind === 'tool' && !TOOL_TERMINAL.has(n.tool.status))) return true
  if (msg.flow?.some((n) => n.kind === 'thinking' && !n.completed)) return true
  return props.isLoading && props.isLastMessage
}

/**
 * 折叠态判定（对齐 WorkBuddy"执行完折叠过程只出结果"）：
 * - true  → 折叠（done 完成自动折叠 / 历史消息默认折叠）
 * - false → 展开（用户手动展开）
 * - undefined：流式中 → 平铺全过程；历史 → 折叠
 */
function shouldCollapse(msg: ChatMessage): boolean {
  if (msg.processCollapsed === false) return false
  if (msg.processCollapsed === true) return true
  return !isMsgStreaming(msg)
}
</script>

<style scoped>
.msg-flow-renderer {
  min-width: 0;
}

/* Markdown 表格样式（原在 ChatView scoped，组件化后需在组件内生效——:deep 穿透 v-html） */
.msg-flow-renderer :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 12px 0;
}

/* Markdown 列表缩进（组件化后补充：ChatView scoped 穿透不到子组件 v-html，圆点曾贴消息框左缘；
 * 老板定稿：缩进 20px、圆点 14px 深色） */
.msg-flow-renderer :deep(ul),
.msg-flow-renderer :deep(ol) {
  padding-left: 20px;
  margin: 8px 0;
}
.msg-flow-renderer :deep(li) {
  margin: 3px 0;
}
.msg-flow-renderer :deep(li::marker) {
  font-size: 1em;
  color: var(--text-primary);
}

/* 正文路径链接（P0-1：代码路径可点击定位，WorkBuddy inline-code 同款） */
.msg-flow-renderer :deep(.msg-path-link) {
  color: var(--accent, #6366f1);
  border-bottom: 1px dashed color-mix(in srgb, var(--accent, #6366f1) 40%, transparent);
  cursor: pointer;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.92em;
  padding: 0 1px;
  border-radius: 3px;
}
.msg-flow-renderer :deep(.msg-path-link:hover) {
  background: color-mix(in srgb, var(--accent, #6366f1) 10%, transparent);
  border-bottom-style: solid;
}

/* flow 图节点（WorkBuddy image-block 同款：按位置内联渲染，白底卡片） */
.flow-diagram-card {
  margin: 8px 0;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border-color);
  background: #fff;
  overflow: hidden;
  cursor: zoom-in;
}
.dark .flow-diagram-card { background: #fff; } /* SVG 白底，深色模式也保持白卡片 */
.flow-diagram-card:hover {
  border-color: var(--accent, #6366f1);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #6366f1) 18%, transparent);
}
/* 流式绘制中（diagram_chunk 逐块到达）：虚线画板状态 */
.flow-diagram-card.pending {
  border-style: dashed;
  border-color: var(--accent, #6366f1);
  min-height: 60px;
}
.flow-diagram-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  padding: 8px 12px 0;
}
.flow-diagram-body {
  padding: 10px 12px 12px;
}
.flow-diagram-body :deep(svg) {
  width: 100%;
  height: auto;
  display: block;
}
/* 生成图卡片（generate_image）：对话内显示，点击右侧预览放大 */
.flow-image-card {
  margin: 8px 0;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--border-color);
  overflow: hidden;
  cursor: zoom-in;
  max-width: 480px;
}
.flow-image-card:hover {
  border-color: var(--accent, #6366f1);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #6366f1) 18%, transparent);
}
.flow-image-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  padding: 8px 12px 0;
}
.flow-image-body {
  width: 100%;
  height: auto;
  display: block;
  padding: 8px 12px 12px;
  box-sizing: border-box;
  border-radius: 4px;
}
/* 生成图下载按钮（2026-08-27 加：卡片右下角悬浮） */
.flow-image-download {
  position: absolute;
  right: 14px;
  bottom: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: rgba(15, 20, 30, 0.75);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}
.flow-image-card { position: relative; }
.flow-image-card:hover .flow-image-download { opacity: 1; }
.flow-image-download:hover { background: rgba(15, 20, 30, 0.95); }
.msg-flow-renderer :deep(th),
.msg-flow-renderer :deep(td) {
  border: 1px solid var(--border-color);
  padding: 8px 12px;
  text-align: left;
}
.msg-flow-renderer :deep(th) {
  background: var(--bg-secondary);
}

/* 重试提示（图标 + 文案横排） */
.retry-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted, var(--text-color));
  padding: 4px 0;
}
.retry-hint svg { flex-shrink: 0; animation: retry-spin 1.2s linear infinite; }
@keyframes retry-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 分批展开：显示更早 N 条（WorkBuddy expand-budget 同款） */
.expand-earlier {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 4px 0;
  padding: 3px 10px;
  border: 1px dashed var(--border-color);
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-muted, var(--text-color));
  font-size: 11.5px;
  cursor: pointer;
  user-select: none;
  transition: border-color var(--duration-fast, 0.15s), color var(--duration-fast, 0.15s);
}
.expand-earlier:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}

/* 思考状态（typing 三点） */
.typing-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
  color: var(--text-muted, var(--text-color));
  font-size: 12px;
}
/* 骨架屏（2026-08-23）：AI 回复前脉动占位线 */
.skeleton-block { padding: 6px 0 10px; }
.skeleton-line {
  height: 12px;
  border-radius: 6px;
  margin-top: 8px;
  background: linear-gradient(90deg, var(--border-tertiary, rgba(128,128,128,0.12)) 25%, var(--border-secondary, rgba(128,128,128,0.25)) 50%, var(--border-tertiary, rgba(128,128,128,0.12)) 75%);
  background-size: 200% 100%;
  animation: skeleton-pulse 1.4s ease-in-out infinite;
}
.skeleton-line.w70 { width: 70%; }
.skeleton-line.w45 { width: 45%; }
.skeleton-line.w55 { width: 55%; }
@keyframes skeleton-pulse {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.typing-indicator .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-muted, var(--text-color));
  animation: typing-bounce 1.2s infinite ease-in-out;
}
.typing-indicator .dot:nth-child(2) { animation-delay: 0.15s; }
.typing-indicator .dot:nth-child(3) { animation-delay: 0.3s; }
.typing-indicator .typing-text { margin-left: 6px; }
@keyframes typing-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
  40% { transform: translateY(-3px); opacity: 1; }
}

/* 过程折叠条：思考/工具收拢成一行摘要，点击展开/收起 */
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
  transition: border-color var(--duration-fast, 0.15s), color var(--duration-fast, 0.15s), background var(--duration-fast, 0.15s);
}
.process-collapse-bar:hover {
  border-color: var(--accent);
  color: var(--text-primary);
  background: var(--bg-hover);
}
/* 展开态：折叠条保持可见（可点击收起），视觉区分 + 箭头朝上 */
.process-collapse-bar.open {
  border-color: var(--accent);
  color: var(--text-primary);
  background: var(--bg-hover);
}
.process-collapse-bar.open .pc-summary { color: var(--text-primary); }
.process-collapse-bar svg { flex-shrink: 0; }
.process-collapse-bar .pc-label { font-weight: 500; }
.process-collapse-bar .pc-summary { color: var(--text-secondary); font-weight: 500; }
.process-collapse-bar .pc-duration { color: var(--text-muted); }
.process-collapse-bar .pc-duration::before { content: '·'; margin-right: 6px; }
.process-collapse-bar .pc-arrow { transition: transform 0.2s ease; }
.process-collapse-bar .pc-arrow.down { transform: rotate(180deg); }

/* 结构化停止原因横幅（轮次超限等） */
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
.stop-reason-banner svg { flex-shrink: 0; color: var(--warning, #f59e0b); }
.stop-reason-banner .sr-text { flex: 1; min-width: 0; }
.stop-reason-banner .sr-checkpoint {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg-secondary);
  padding: 1px 6px;
  border-radius: 4px;
}
/* 继续按钮（2026-08-26：检查点续跑一键触发） */
.stop-reason-banner .sr-continue {
  flex-shrink: 0;
  margin-left: 6px;
  padding: 2px 10px;
  border: 1px solid var(--accent, #4f8cff);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent, #4f8cff) 12%, transparent);
  color: var(--accent, #4f8cff);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.stop-reason-banner .sr-continue:hover {
  background: var(--accent, #4f8cff);
  color: #fff;
}
</style>

<!-- 全局样式：复制按钮由 ChatView enhanceCodeBlocks 动态创建（无 scope 属性），scoped 匹配不到——
     必须用非 scoped 样式才能让按钮浮在代码块右上角（否则退化成代码下方一行普通文本，老板 2026-08-21） -->
<style>
/* 正文链接样式（2026-08-28 加固：markdown <a> 用 var(--accent) 自动适应浅色/深色——浅色靛蓝高对比、
   深色亮紫蓝；加下划线+粗体，明显可点。双选择器确保 `.dark` 加在 body/.app-layout 任一都生效） */
.message-content a {
  color: var(--accent, #4f8cff);
  text-decoration: underline;
  text-decoration-thickness: 1.5px;
  text-underline-offset: 3px;
  font-weight: 500;
  word-break: break-all; /* 长 URL 自动折行 */
}
.message-content a:hover { color: var(--accent-hover, #6366f1); text-decoration-thickness: 2px; }
/* 深色模式：亮天蓝，深底高对比（覆盖 .dark 加在 html/body/app-layout/[data-theme] 的情况） */
html.dark .message-content a,
body.dark .message-content a,
.app-layout.dark .message-content a,
[data-theme='dark'] .message-content a,
.dark .message-content a {
  color: #7dd3fc;
  text-decoration-color: rgba(125, 211, 252, 0.55);
}
html.dark .message-content a:hover,
body.dark .message-content a:hover,
.app-layout.dark .message-content a:hover { color: #bae6fd; }
/* 用户消息气泡是蓝色渐变底(#4F46E5→#6366F1)、正文白字——链接若用 accent(靛蓝)会蓝底蓝字看不清。
   改为白色下划线链接，蓝底上清晰可点（2026-08-28 修"看不清"真根因） */
.message.user .message-content a {
  color: #ffffff;
  text-decoration: underline;
  text-decoration-color: rgba(255, 255, 255, 0.7);
  text-decoration-thickness: 1.5px;
  text-underline-offset: 3px;
  font-weight: 500;
}
.message.user .message-content a:hover {
  color: #e0e7ff;
  text-decoration-color: #ffffff;
}
.message-content pre {
  position: relative;

}
.code-copy-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 2px 8px;
  border: none;
  border-radius: 5px;
  background: rgba(128, 128, 128, 0.15);
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}
.message-content pre:hover .code-copy-btn {
  opacity: 1;
}
.code-copy-btn:hover {
  background: rgba(128, 128, 128, 0.3);
  color: var(--text-primary);
}
.code-copy-btn.copied {
  background: rgba(16, 185, 129, 0.2);
  color: #0f766e;
}

/* ===== 代码框（对齐 WorkBuddy cr-code-like-box：header 语言标签 + 常驻复制按钮 + 圆角边框） ===== */
.cr-code-like-box {
  margin: 8px 0;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.3));
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-code, rgba(128, 128, 128, 0.05));
}
.cr-code-like-box__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 6px 3px 12px;
  background: var(--bg-code-header, rgba(128, 128, 128, 0.08));
  border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
}
.cr-code-block__language {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary, rgba(128, 128, 128, 0.8));
  font-family: var(--font-mono, ui-monospace, monospace);
  text-transform: lowercase;
  letter-spacing: 0.3px;
}
.cr-code-block__copy-button {
  border: none;
  background: transparent;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px 7px;
  border-radius: 4px;
  opacity: 0.75;
  transition: opacity 0.15s, background 0.15s;
}
.cr-code-block__copy-button:hover {
  opacity: 1;
  background: rgba(128, 128, 128, 0.15);
  color: var(--text-primary);
}
.cr-code-block__copy-button.copied {
  color: #0f766e;
  opacity: 1;
}
.cr-code-like-box__content pre {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.55;
  background: transparent;
}
.cr-code-like-box__content pre code {
  font-family: var(--font-mono, ui-monospace, monospace);
  white-space: pre;
}
/* 旧结构 pre（无 header）保持相对定位供复制按钮定位 */
.message-content pre:not(.cr-code-like-box__content pre) {
  position: relative;
}

/* ===== 代码框 hljs token 配色（WorkBuddy one-light/one-dark 双主题同款） ===== */
/* 浅色模式（默认）：one-light——深色系 token 在浅灰底上清晰 */
.message-content .hljs {
  color: #383a42;
}
.message-content .hljs-keyword,
.message-content .hljs-selector-tag,
.message-content .hljs-literal,
.message-content .hljs-section,
.message-content .hljs-link {
  color: #a626a4;
}
.message-content .hljs-string,
.message-content .hljs-title,
.message-content .hljs-name,
.message-content .hljs-type,
.message-content .hljs-attribute,
.message-content .hljs-symbol,
.message-content .hljs-bullet,
.message-content .hljs-addition,
.message-content .hljs-variable,
.message-content .hljs-template-tag,
.message-content .hljs-template-variable {
  color: #50a14f;
}
.message-content .hljs-comment,
.message-content .hljs-quote,
.message-content .hljs-deletion {
  color: #a0a1a7;
  font-style: italic;
}
.message-content .hljs-number,
.message-content .hljs-meta {
  color: #986801;
}
.message-content .hljs-built_in,
.message-content .hljs-builtin-name,
.message-content .hljs-params {
  color: #c18401;
}
.message-content .hljs-attr {
  color: #986801;
}
.message-content .hljs-function .hljs-title,
.message-content .hljs-class .hljs-title {
  color: #4078f2;
}
/* 深色模式：one-dark——亮色系 token 在深灰底上发光 */
.dark .message-content .hljs {
  color: #abb2bf;
}
.dark .message-content .hljs-keyword,
.dark .message-content .hljs-selector-tag,
.dark .message-content .hljs-literal,
.dark .message-content .hljs-section,
.dark .message-content .hljs-link {
  color: #c678dd;
}
.dark .message-content .hljs-string,
.dark .message-content .hljs-title,
.dark .message-content .hljs-name,
.dark .message-content .hljs-type,
.dark .message-content .hljs-attribute,
.dark .message-content .hljs-symbol,
.dark .message-content .hljs-bullet,
.dark .message-content .hljs-addition,
.dark .message-content .hljs-variable,
.dark .message-content .hljs-template-tag,
.dark .message-content .hljs-template-variable {
  color: #98c379;
}
.dark .message-content .hljs-comment,
.dark .message-content .hljs-quote,
.dark .message-content .hljs-deletion {
  color: #7f848e;
  font-style: italic;
}
.dark .message-content .hljs-number,
.dark .message-content .hljs-meta {
  color: #d19a66;
}
.dark .message-content .hljs-built_in,
.dark .message-content .hljs-builtin-name,
.dark .message-content .hljs-params {
  color: #e5c07b;
}
.dark .message-content .hljs-attr {
  color: #d19a66;
}
.dark .message-content .hljs-function .hljs-title,
.dark .message-content .hljs-class .hljs-title {
  color: #61afef;
}
</style>
