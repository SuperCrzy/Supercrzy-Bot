<template>
  <div class="tool-call-block" :class="[status, `cat-${category}`, { 'just-completed': justCompleted, 'just-errored': justErrored }]">
    <!-- Header：命令卡片（shell_exec）用命令短述 + 风险标签，其余通用工具用工具名（web_fetch 用专属卡片自带 header，隐藏通用 header） -->
    <!-- 授权决策在 header 行内完成（对齐 WorkBuddy tool-head__actions：Allow/Always Allow/Deny 一行，不展开 body 占地方） -->
    <div v-if="!isWebFetch" class="tool-header" @click="toggle">
      <span class="tool-status-indicator">
        <svg v-if="status === 'running' || status === 'stream_executing'" class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        <svg v-else-if="status === 'done'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        <svg v-else-if="status === 'denied' || status === 'skipped'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        <svg v-else-if="status === 'cancelled'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
        <svg v-else-if="status === 'approved'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      </span>
      <template v-if="isCommand">
        <!-- 终端图标 + 命令短述（Run Command 风格收起行）；pending 时显示"执行命令？"状态标签（WorkBuddy showApprovalButtons 同款） -->
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        <span v-if="status === 'pending'" class="run-command-ask">{{ $t('chatui.runCommandAsk') }}</span>
        <code class="tool-name cmd-summary">{{ commandSummary || $t('chatui.runCommand') }}</code>
        <span v-if="riskLevel !== 'normal'" class="risk-tag" :class="`risk-${riskLevel}`">{{ riskLabel }}</span>
        <span v-if="status === 'pending'" class="perm-tag" :class="`perm-${permission}`">{{ permLabel }}</span>
        <span v-if="isBlocked" class="blocked-tag">{{ $t('chatui.blockedBySandbox') }}</span>
      </template>
      <template v-else-if="isLint">
        <!-- lint_file：诊断徽章 + 文件名 + 问题计数 -->
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><path d="M9 12l2 2 4-4"/><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 4L12 14.01l-3-3"/></svg>
        <code class="tool-name">{{ lintFileName }}</code>
        <span v-if="lintIssues.length" class="lint-count" :class="{ 'has-error': lintErrorCount > 0 }">
          {{ $t('chatui.lintIssues', { n: lintIssues.length }) }}
        </span>
        <span v-else class="lint-clean-badge">{{ $t('chatui.lintClean') }}</span>
        <span v-if="status === 'pending'" class="perm-tag" :class="`perm-${permission}`">{{ permLabel }}</span>
      </template>
      <template v-else>
        <!-- 通用工具：每工具图标 + 友好名称（WorkBuddy tool-icon-registry/tool-name-map 同款） -->
        <svg v-if="toolIcon === 'read'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        <svg v-else-if="toolIcon === 'write'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
        <svg v-else-if="toolIcon === 'search'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <svg v-else-if="toolIcon === 'web'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <svg v-else-if="toolIcon === 'draw'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        <svg v-else-if="toolIcon === 'git'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6"/><path d="M6 9c0 4 5 3 8 5"/></svg>
        <svg v-else-if="toolIcon === 'task'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><polyline points="3 6 4 7 6 5"/><polyline points="3 12 4 13 6 11"/><polyline points="3 18 4 19 6 17"/></svg>
        <svg v-else-if="toolIcon === 'skill'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><path d="M12 3l1.9 5.7L20 10.6l-5.2 3.8L16.5 20 12 16.7 7.5 20l1.7-5.6L4 10.6l6.1-1.9L12 3z"/></svg>
        <svg v-else-if="toolIcon === 'memory'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
        <svg v-else-if="toolIcon === 'ask'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <svg v-else-if="toolIcon === 'plan'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        <svg v-else-if="toolIcon === 'computer'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        <svg v-else-if="toolIcon === 'folder'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <svg v-else-if="toolIcon === 'trash'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        <svg v-else-if="toolIcon === 'image'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        <svg v-else-if="toolIcon === 'sparkle'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><path d="M12 3l1.9 5.7L20 10.6l-5.2 3.8L16.5 20 12 16.7 7.5 20l1.7-5.6L4 10.6l6.1-1.9L12 3z"/></svg>
        <svg v-else-if="toolIcon === 'database'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
        <svg v-else-if="toolIcon === 'cloud'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>
        <svg v-else-if="toolIcon === 'grid'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cmd-icon"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
        <!-- 读文件卡片：文件名可点击 → 打开文件定位行号（P0-3，WorkBuddy onFileClick 同款） -->
        <code v-if="isReadFile && fullFilePath" class="tool-name file-link" :title="fullFilePath" @click.stop="openReadFile">{{ fileHeaderLabel }}</code>
        <code v-else class="tool-name" :class="{ 'tool-shining': isFileWrite && isExecutingState }">{{ fileHeaderLabel }}</code>
        <span v-if="status === 'pending'" class="perm-tag" :class="`perm-${permission}`">{{ permLabel }}</span>
        <span v-if="isBlocked" class="blocked-tag">{{ $t('chatui.blockedBySandbox') }}</span>
      </template>
      <span v-if="runningElapsed" class="tool-duration">{{ runningElapsed }}</span>
      <span v-else-if="duration" class="tool-duration">{{ duration }}s</span>
      <!-- 错误摘要（对齐 WorkBuddy：失败卡片 header 显示原因，点击展开详情） -->
      <span v-if="status === 'error'" class="tool-error-hint">{{ errorSummary }}</span>
      <!-- 执行中数字滚动徽标（GPT 同款：+N 实时滚动——写入行数平滑增长，WorkBuddy +N/-M 徽标） -->
      <span v-if="liveLines && (status === 'running' || status === 'stream_executing')" class="tool-lines lines-live-badge"><span class="lines-badge live">+{{ displayedLines }}</span></span>
      <span v-if="lineStat && status === 'done'" class="tool-lines" :class="{ 'lines-live': justCompleted }"><span class="lines-badge">{{ lineStat }}</span></span>
      <!-- 授权按钮组（对齐 WorkBuddy tool-head__actions：header 一行内决策，pending 不展开 body） -->
      <span v-if="status === 'pending' && isSensitive" class="tool-head-actions" @click.stop>
        <!-- 倒计时结束已自动放行：不挂按钮，明确提示正在自动执行 -->
        <span v-if="autoApproved" class="tba-auto-approving">{{ $t('chatui.autoApproving') }}</span>
        <template v-else>
          <button class="tba-btn tba-allow" @click="$emit('allow')">
            {{ $t('chatui.allow') }}
            <span v-if="countdown > 0" class="confirm-allow-countdown">{{ countdown }}s</span>
          </button>
          <button class="tba-btn tba-session" @click="$emit('allow-session')">{{ $t('chatui.allowSession') }}</button>
          <button class="tba-btn tba-deny" @click="$emit('deny')">{{ $t('chatui.deny') }}</button>
        </template>
      </span>
      <span class="tool-expand-toggle">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: expanded }"><path d="M6 9l6 6 6-6"/></svg>
      </span>
    </div>

    <!-- 运行中摘要行（折叠态）：实时显示输出尾部预览——执行中不展开正文，进度仍可见（老板 2026-08-21 要求紧凑） -->
    <div v-if="!expanded && (status === 'running' || status === 'stream_executing')" class="tool-running-hint">
      <span class="trh-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
      <span class="trh-text">{{ runningHint }}</span>
    </div>

    <!-- 写文件行数实时滚动（折叠态，代码不展开只显数据）：文件图标+文件名 + 大数字 CountUp + 进度 + 最近增量标签（老板 2026-08-21 / 2026-08-27 补文件名栏）
         2026-09-25 老板定稿：完成后**保留最终 ± 增删**不再消失（此前只在执行中显示，写完即无，观感"没做实时显示"） -->
    <div v-if="!expanded && writeProgress && (isWriteRunning || status === 'done')" class="write-progress-bar">
      <span class="wp-file">
        <span class="wp-file-icon">{{ isWriteNew ? '+' : '~' }}</span>
        <span class="wp-file-name" :title="fileName" @click.stop="toggle">{{ fileName || friendlyName }}</span>
      </span>
      <template v-if="status === 'done'">
        <span class="wp-count">+{{ progress?.added || 0 }}</span>
        <span v-if="(progress?.deleted || 0) > 0" class="wp-progress wp-del">−{{ progress?.deleted }}</span>
      </template>
      <template v-else>
        <span class="wp-count">+{{ displayedLines }}</span>
        <span class="wp-detail">行</span>
        <span class="wp-progress">写入 {{ writeProgress.written }}/{{ writeProgress.total }} 行</span>
      </template>
      <span v-for="(d, i) in (isWriteRunning ? recentDeltas : [])" :key="i" class="wp-delta">{{ d > 0 ? '+' + d : d }}</span>
    </div>

    <!-- Body -->
    <div class="tool-body" v-if="expanded">
      <!-- 网页获取卡片（WorkBuddy WebFetchCompactRenderer 同款：一行 header + 结构化展开，执行中不展开正文） -->
      <WebFetchCard
        v-if="isWebFetch"
        :args="props.args"
        :result="props.result"
        :status="props.status"
      />
      <!-- 可视化指南卡片（WorkBuddy VisualizerReadMeRenderer 同款：read_me 工具专属） -->
      <VisualizerReadMeCard
        v-else-if="isReadMe"
        :args="props.args"
        :result="props.result"
        :status="props.status"
      />
      <!-- 命令卡片展开态（WorkBuddy ExecuteCommandRenderer 同款，renderers/ 目录） -->
      <CommandRenderer
        v-else-if="isCommand"
        :args="props.args"
        :result="props.result"
        :status="props.status"
      />
      <!-- 执行计划任务卡（2026-08-27 加：create_plan 内联 PlanCard，显示 #N 步骤进度，对齐 WorkBuddy todo 卡） -->
      <PlanCard
        v-else-if="isPlan"
      />
      <!-- lint 展开态：诊断列表（WorkBuddy ReadLintsRenderer 同款） -->
      <LintRenderer
        v-else-if="isLint"
        :result="props.result"
      />
      <!-- 通用工具展开态（Arguments + diff + 多文件编辑 + 流式代码 + 结果，renderers/ 目录） -->
      <FileOpRenderer
        v-else
        :tool-name="props.toolName"
        :args="props.args"
        :result="props.result"
        :status="props.status"
        :stream-output="props.streamOutput"
        :file-diff="props.fileDiff"
        @accept="onAcceptMultiEdit"
        @reject="onRejectMultiEdit"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { resolveToolMeta } from '@/utils/tool-meta'
import { formatDurationMs } from '@/utils/tool-summary'
import { useSecondTick } from '@/composables/useSecondTick'
import { openFilePreview } from '@/utils/file-preview'
import {
  resolveToolRendererKey,
  isReadFileTool,
  isWriteFileTool,
  isWriteNewTool,
} from '@/components/chat/renderers/tool-renderer-registry'
import CommandRenderer from '@/components/chat/renderers/CommandRenderer.vue'
import LintRenderer from '@/components/chat/renderers/LintRenderer.vue'
import FileOpRenderer from '@/components/chat/renderers/FileOpRenderer.vue'
import PlanCard from '@/components/chat/PlanCard.vue'
import VisualizerReadMeCard from '@/components/chat/VisualizerReadMeCard.vue'
import WebFetchCard from '@/components/chat/WebFetchCard.vue'
import type { ToolProgress } from '@/types'

const { t } = useI18n({ useScope: 'global' })
const props = withDefaults(defineProps<{
  toolName: string
  args?: string
  result?: string
  status: 'pending' | 'approved' | 'running' | 'stream_executing' | 'done' | 'error' | 'denied' | 'skipped' | 'cancelled' | 'parsing' | 'destroyed'
  duration?: number
  /** 当前会话沙箱权限档（用于命令风险标签自动推导） */
  permission?: string
  /** 授权弹窗自动允许等待秒数（>0 时显示倒计时提示，超时后端自动放行） */
  autoApproveSeconds?: number
  /** 工具流式输出（执行中实时追加，WorkBuddy streamOutput 同款） */
  streamOutput?: string
  /** 工具结构化进度（tool_progress 事件，执行中实时覆盖）——写文件行数/编辑处数的**唯一数据源** */
  progress?: ToolProgress
  /** 工具开始执行时刻（执行中实时耗时显示用） */
  startedAt?: number
  /** 写文件 diff（file_changed 事件挂载，对齐 WorkBuddy WriteFileRenderer DiffViewer） */
  fileDiff?: { path: string; oldContent: string; newContent: string }
}>(), {
  args: '',
  result: '',
  duration: undefined,
  permission: '',
  autoApproveSeconds: 0,
})

const emit = defineEmits<{
  (e: 'allow'): void
  (e: 'deny'): void
  (e: 'allow-session'): void
}>()

// 展开策略（对齐 WorkBuddy ToolCard clickHeader + defaultShowResult）：
// 默认折叠成摘要行（工具名+状态+输出尾部预览），点击 header 展开详情；
// 授权按钮组内嵌 header 一行（tool-head__actions），pending 不强制展开 body——并行工具不占地方（老板 2026-08-21）
// web_fetch 走专属卡片（WebFetchCard 内部管理折叠），ToolCallBlock 恒展开
/** 渲染分支 key（注册表单一来源：tool-renderer-registry.ts，WorkBuddy toolRendererRegistry 同款） */
const rendererKey = computed(() => resolveToolRendererKey(props.toolName))
const isWebFetch = computed(() => rendererKey.value === 'web-fetch')
const expanded = ref(isWebFetch.value)

// ===== 自动允许倒计时：pending 等待授权时按钮内实时递减（5s→4s→…）=====
// 到 0 自动放行：前端主动 emit('allow')，让"自动授权"前后端闭环（此前只停倒计时不提交，
// 按钮一直挂着等点，用户感知"5 秒后不自动执行"）。后端 waitForToolConfirmation 的 5s 定时器
// 也会放行；前端提前提交是更可靠、且 UI 能立即反映"已自动允许"。
const countdown = ref(0)
const autoApproved = ref(false)
let countdownTimer: ReturnType<typeof setInterval> | null = null
watch(() => props.status, (s) => {
  if (s === 'pending' && props.autoApproveSeconds > 0) {
    countdown.value = props.autoApproveSeconds
    autoApproved.value = false
    if (!countdownTimer) {
      countdownTimer = setInterval(() => {
        countdown.value = Math.max(0, countdown.value - 1)
        if (countdown.value <= 0 && countdownTimer) {
          clearInterval(countdownTimer); countdownTimer = null
          if (props.status === 'pending') {
            // 倒计时结束且仍待授权 → 自动放行（不再挂起等用户点）
            autoApproved.value = true
            emit('allow')
          }
        }
      }, 1000)
    }
  } else if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}, { immediate: true })
onUnmounted(() => { if (countdownTimer) clearInterval(countdownTimer) })

/** 错误摘要（header 显示）：去 emoji/前缀，截断 40 字符 */
const errorSummary = computed(() => {
  const r = (props.result || '').trim().replace(/^[✅❌⚠️]+\s*/, '')
  return r.length > 40 ? r.slice(0, 40) + '…' : r
})

// 写文件行数统计徽标（WorkBuddy addedLines 同款）：从结果文本解析 "+N/-M 行" 或 "(N 行)"
const lineStat = computed(() => {
  const r = props.result || ''
  // 更新: "+N/-M 行"；新建: "(字符, N 行)"（逗号后可能有空格）
  const m = r.match(/\+(\d+)\/-(\d+) 行/) || r.match(/,\s*(\d+) 行\)/)
  if (!m) return ''
  return m[2] !== undefined ? `+${m[1]} / -${m[2]} 行` : `+${m[1]} 行`
})

// ===== 执行中数字滚动徽标（三合一：ChatGPT 行数滚动 + WorkBuddy 徽标 + 我们进度流）=====
const isFileWrite = computed(() => isWriteFileTool(props.toolName))

/** 从结构化进度提取当前写入行数（tool_progress 的 done）。
 *  ⚠️ 2026-09-24（G5/I13）：后端不再往流式输出里塞 "📝 写入 N/M 行" 中文文案 —— 旧实现靠
 *     `/写入\s*(\d+)\s*\/\s*(\d+)\s*行/` 正则解析这句中文，后端改一个字即静默失效。
 *     现以 `progress` 为唯一数据源；正则仅作**历史消息**回放兜底（老消息里存着旧文案）。 */
const liveLines = computed<number | null>(() => {
  if (props.progress?.done != null) return props.progress.done
  if (!props.streamOutput) return null
  const m = props.streamOutput.match(/写入\s*(\d+)\s*\/\s*(\d+)\s*行/)
  return m ? Number(m[1]) : null
})

/** 写文件进度（written/total，折叠态滚动区数据源）——数据源同 liveLines */
const writeProgress = computed<{ written: number; total: number } | null>(() => {
  if (props.progress?.total != null && props.progress?.done != null) {
    return { written: props.progress.done, total: props.progress.total }
  }
  if (!props.streamOutput) return null
  const m = props.streamOutput.match(/写入\s*(\d+)\s*\/\s*(\d+)\s*行/)
  return m ? { written: Number(m[1]), total: Number(m[2]) } : null
})

/** 写入进度条的阶段：执行中显滚动行数，完成后保留最终 ± 增删（2026-09-25 老板定稿） */
const isWriteRunning = computed(() => props.status === 'running' || props.status === 'stream_executing')

/** 最近行数增量（每块 +N/-N，限最近 6 个——折叠态"数据实时滚动"效果，代码不展开；删除行预留 -N） */
const recentDeltas = ref<number[]>([])
let lastWrittenLines = 0
watch(writeProgress, (p) => {
  if (!p) return
  if (p.written < lastWrittenLines) lastWrittenLines = 0 // 新工具/重写 → 重置
  const delta = p.written - lastWrittenLines
  if (delta !== 0) {
    recentDeltas.value = [...recentDeltas.value.slice(-5), delta]
    lastWrittenLines = p.written
  }
})
// 工具切换（新 file_write 卡片）→ 重置增量
watch(
  () => props.toolName,
  () => { lastWrittenLines = 0; recentDeltas.value = [] },
)
/** 平滑滚动的显示行数（CountUp 风格：旧值过渡到新值，比 ChatGPT 硬跳更顺滑） */
const displayedLines = ref(0)
let linesAnimFrame = 0
watch(liveLines, (to) => {
  if (to == null) return
  const from = displayedLines.value
  if (from === to) {
    displayedLines.value = to
    return
  }
  cancelAnimationFrame(linesAnimFrame)
  const start = performance.now()
  const DUR = 160
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / DUR)
    const eased = p < 1 ? 1 - Math.pow(1 - p, 3) : 1
    displayedLines.value = Math.round(from + (to - from) * eased)
    if (p < 1) linesAnimFrame = requestAnimationFrame(step)
  }
  linesAnimFrame = requestAnimationFrame(step)
})
onUnmounted(() => cancelAnimationFrame(linesAnimFrame))

// 状态过渡动画 + 自动展开/折叠
/** 折叠态运行中摘要：输出尾部最后一行（截断 120 字符），无输出时给通用提示 */
const runningHint = computed(() => {
  const s = props.streamOutput || ''
  const tail = s.trim().split('\n').pop() || ''
  const t = tail.trim()
  return t ? t.slice(-120) : props.toolName + ' …'
})

// ============ 运行中实时耗时（执行中 header 显示"已运行 Xs"每秒增长；完成后用 tool_duration 静态值） ============
// 与轮次计时器共用 useSecondTick（锚定 props.startedAt），避免三处各自 setInterval 相位不一
const toolRunning = () => (props.status === 'running' || props.status === 'stream_executing') && !!props.startedAt
const toolNow = useSecondTick(toolRunning, () => props.startedAt)

/** 运行中实时耗时；非运行态返回空（走 duration 静态值）。格式化统一走 formatDurationMs */
const runningElapsed = computed(() => {
  if (!toolRunning()) return ''
  const live = Math.max(1000, toolNow.value - (props.startedAt ?? toolNow.value))
  return formatDurationMs(live)
})

const justCompleted = ref(false)
const justErrored = ref(false)

watch(() => props.status, (newStatus, oldStatus) => {
  // 写文件工具进入执行态 → 自动展开（对齐 WorkBuddy defaultShowResult：代码流实时"长出来"可见）。
  // 旧逻辑"执行中不强制展开"只留折叠摘要，慢屏幕上看不到正在写的代码；执行中展开让代码实时可见，完成再折叠。
  if (isFileWrite.value && (newStatus === 'stream_executing' || newStatus === 'running') && oldStatus !== newStatus) {
    expanded.value = true
  }
  // 执行中/等待授权均不强制展开（默认折叠摘要行；授权按钮组已在 header 一行，无需展开 body）——对齐 WorkBuddy compact
  if ((newStatus === 'done' || newStatus === 'denied' || newStatus === 'skipped') && (oldStatus === 'running' || oldStatus === 'stream_executing')) {
    justCompleted.value = true
    setTimeout(() => { justCompleted.value = false }, 700)
    if (!isWebFetch.value) setTimeout(() => { expanded.value = false }, 1200)  // 完成后折叠（web_fetch 保持专属卡片）
  }
  if (newStatus === 'error' && (oldStatus === 'running' || oldStatus === 'stream_executing')) {
    justErrored.value = true
    // 错误也折叠成一行（对齐 WorkBuddy：header 状态色+错误指示，点击展开看详情，不裸露参数/结果）
    if (!isWebFetch.value) expanded.value = false
    setTimeout(() => { justErrored.value = false }, 700)
  }
})

// 敏感操作列表 — 需要用户确认
const SENSITIVE_TOOLS = new Set(['shell_exec', 'file_write', 'file_delete'])
const isSensitive = computed(() => SENSITIVE_TOOLS.has(props.toolName))
const sensitiveDesc = computed(() => {
  const map: Record<string, string> = {
    shell_exec: t('chatui.toolDescShell'),
    file_write: t('chatui.toolDescFileWrite'),
    file_delete: t('chatui.toolDescFileDelete'),
  }
  return map[props.toolName] || t('chatui.toolDescSensitive')
})

// Tool category mapping
const categoryMap: Record<string, { label: string; cat: string }> = {
  web_search: { label: 'Network', cat: 'network' },
  web_fetch: { label: 'Network', cat: 'network' },
  memory_store: { label: 'Memory', cat: 'memory' },
  memory_recall: { label: 'Memory', cat: 'memory' },
  memory_list: { label: 'Memory', cat: 'memory' },
  file_read: { label: 'File', cat: 'file' },
  file_write: { label: 'File', cat: 'file' },
  file_exists: { label: 'File', cat: 'file' },
  shell_exec: { label: 'System', cat: 'system' },
  ask_question: { label: 'Ask', cat: 'interaction' },
  create_plan: { label: 'Plan', cat: 'system' },
  git_status: { label: 'Git', cat: 'git' },
  git_diff: { label: 'Git', cat: 'git' },
  git_commit: { label: 'Git', cat: 'git' },
  computer_use: { label: 'Computer', cat: 'system' },
}

const category = computed(() => categoryMap[props.toolName]?.cat || 'system')
const categoryLabel = computed(() => categoryMap[props.toolName]?.label || 'System')

// 工具图标 + 友好名称（WorkBuddy tool-icon-registry/tool-name-map 同款：精确→前缀→兜底）
const toolMeta = computed(() => resolveToolMeta(props.toolName))
const toolIcon = computed(() => toolMeta.value.icon)
const friendlyName = computed(() => t(toolMeta.value.nameKey))

/** 读文件工具判定（WorkBuddy ReadFileCompactRenderer 同款） */
const isReadFile = computed(() => isReadFileTool(props.toolName))

/** 可视化指南工具判定（WorkBuddy isVisualizerReadMe 同款） */
const isReadMe = computed(() => rendererKey.value === 'read-me')

/** 多文件编辑判定（WorkBuddy multi_edit 同款） */
const isMultiEdit = computed(() => rendererKey.value === 'multi-edit')

/** 接受修改（保留当前 diff 展示，标记已接受——后续可扩展为后端确认） */
function onAcceptMultiEdit() {
  acceptedRef.value = true
}
/** 拒绝修改 */
function onRejectMultiEdit() {
  acceptedRef.value = false
}
const acceptedRef = ref(false)

/** 写/读文件操作的完整路径（P0-3 文件定位：点击文件名 → 打开文件 + 定位行号） */
const fullFilePath = computed(() => {
  if (!props.args) return ''
  try {
    const obj = JSON.parse(props.args)
    const raw = obj.path ?? obj.file_path ?? obj.filePath ?? ''
    return typeof raw === 'string' ? raw.trim() : ''
  } catch {
    return ''
  }
})
/** 写/读文件操作的文件名（WorkBuddy 从 args.path/file_path 提取 basename） */
const fileName = computed(() => {
  if (!props.args) return ''
  try {
    const obj = JSON.parse(props.args)
    const raw = obj.path ?? obj.file_path ?? obj.filePath ?? ''
    if (typeof raw !== 'string' || !raw.trim()) return ''
    const base = raw.replace(/\\/g, '/').split('/').pop() || ''
    return base.slice(0, 60)
  } catch {
    return ''
  }
})
/** 读文件定位行号（openFilePreview 用：startLine/endLine 或 start/end） */
const readLineStart = computed(() => {
  if (!props.args) return undefined
  try {
    const obj = JSON.parse(props.args)
    const s = obj.startLine ?? obj.start ?? obj.line_start
    return typeof s === 'number' && s > 0 ? s : undefined
  } catch {
    return undefined
  }
})
const readLineEnd = computed(() => {
  if (!props.args) return undefined
  try {
    const obj = JSON.parse(props.args)
    const e = obj.endLine ?? obj.end ?? obj.line_end
    return typeof e === 'number' && e > 0 ? e : undefined
  } catch {
    return undefined
  }
})
/** 点击已读取的文件名 → 打开文件预览 + 定位行号（WorkBuddy onFileClick(filePath,startLine,endLine) 同款） */
function openReadFile() {
  if (!fullFilePath.value) return
  openFilePreview(fullFilePath.value, readLineStart.value, readLineEnd.value)
}
/** 读文件行号范围（WorkBuddy "L12-30" 同款：从 args.startLine/endLine 或 start/end 提取；
 *  只有 startLine 无 endLine → 表示读到末尾，显示 "L489-末尾"（对齐 WorkBuddy "L489 至末尾" 语义，2026-08-27） */
const readLineRange = computed(() => {
  if (!props.args) return ''
  try {
    const obj = JSON.parse(props.args)
    const start = obj.startLine ?? obj.start ?? obj.line_start
    const end = obj.endLine ?? obj.end ?? obj.line_end
    if (start == null) return ''
    // 有 endLine → "L12-30"；无 endLine（表示读到末尾）→ "L12-末尾"
    return end != null && end !== start ? `L${start}-${end}` : `L${start}-${t('chat.toolToEnd')}`
  } catch {
    return ''
  }
})
/** 读文件状态词（WorkBuddy tool.readFile.running/done/error 同款） */
const readStatusText = computed(() => {
  if (props.status === 'error' || props.status === 'denied') return t('chat.toolReadFailed')
  if (props.status === 'running' || props.status === 'stream_executing' || props.status === 'pending') return t('chat.toolReading')
  return t('chat.toolReadDone')
})
/** 执行中状态（写文件流光动画/摘要用） */
const isExecutingState = computed(() => ['running', 'stream_executing', 'pending'].includes(props.status))
/** 文件操作 header 显示：写文件 → "编辑 demo.py"；读文件 → "已读取 demo.py L12-30"（对齐 GPT/WorkBuddy 文件变更摘要） */
const fileHeaderLabel = computed(() => {
  if (isReadFile.value) {
    if (!fileName.value) return friendlyName.value
    const range = readLineRange.value ? ` ${readLineRange.value}` : ''
    return `${readStatusText.value} ${fileName.value}${range}`
  }
  if (!isFileWrite.value || !fileName.value) return friendlyName.value
  // 语义联动（WorkBuddy write-file getOperateName 同款）：动词由"新建 vs 修改"动态推导，不写死
  const verb = isWriteNew.value
    ? isExecutingState.value ? t('chatui.toolCreating') : t('chatui.toolCreated')
    : isExecutingState.value ? t('chatui.toolModifying') : t('chatui.toolModified')
  return `${verb} ${fileName.value}`
})

/** 写文件是否为新建（file_write/append → 生成；file_edit/replace/multi_edit → 修改） */
const isWriteNew = computed(() => isWriteNewTool(props.toolName))
/** 写文件是否为修改已有文件 */
const isWriteModify = computed(() => !isWriteNew.value && isWriteFileTool(props.toolName))

// Format arguments as key-value pairs
const formattedArgs = computed(() => {
  if (!props.args) return []
  try {
    const obj = JSON.parse(props.args)
    return Object.entries(obj).map(([key, value]) => ({
      key,
      value: typeof value === 'string' && value.length > 120
        ? value.slice(0, 120) + '...'
        : String(value),
    }))
  } catch {
    return [{ key: 'raw', value: props.args.slice(0, 200) }]
  }
})

// Result handling
// ===== 命令执行卡片（shell_exec 专用，学 WorkBuddy Run Command） =====
const isCommand = computed(() => rendererKey.value === 'command')

// ===== 执行计划任务卡（2026-08-27 加：create_plan 工具挂内联 PlanCard，对齐 WorkBuddy todo 卡） =====
const isPlan = computed(() => props.toolName === 'create_plan' || props.toolName === 'plan_task' || props.toolName === 'plan_create')

// ===== lint_file 诊断渲染 =====
const isLint = computed(() => rendererKey.value === 'lint')
/** 被检查文件名（最后一段） */
const lintFileName = computed(() => {
  try {
    const o = JSON.parse(props.args || '{}')
    const p = typeof o.path === 'string' ? o.path : ''
    return p ? p.split('/').pop() : 'lint_file'
  } catch {
    return 'lint_file'
  }
})
/** lint 问题数（header 徽标；诊断列表本体在 LintRenderer） */
const lintIssues = computed<Array<{ severity: string; line: number; message: string }>>(() => {
  if (!props.result) return []
  try {
    const d = JSON.parse(props.result)
    return d && Array.isArray(d.diagnostics) ? d.diagnostics : []
  } catch {
    return []
  }
})
const lintErrorCount = computed(() => lintIssues.value.filter((d) => d.severity === 'error').length)

/** 从 args 中提取命令文本 */
const commandText = computed(() => {
  if (!isCommand.value || !props.args) return ''
  try {
    const obj = JSON.parse(props.args)
    return typeof obj.command === 'string' ? obj.command : ''
  } catch {
    return props.args.slice(0, 200)
  }
})

/** 命令短述：第一行截断 ~60 字符 */
/** 命令卡标题（对齐 WorkBuddy headerText = description || command）：
 *  优先模型提供的 description（"运行查看 deeplink.ts 实际位置"），没有时从命令首行推导人类可读摘要 */
const commandSummary = computed(() => {
  // ① 优先 description（WorkBuddy 同款：工具调用方写的短说明，前端用作卡片标题）
  let argsObj: Record<string, unknown> = {}
  try {
    argsObj = JSON.parse(props.args || '{}')
  } catch {}
  const desc = argsObj.description
  if (typeof desc === 'string' && desc.trim()) return desc.trim().length > 60 ? desc.trim().slice(0, 60) + '…' : desc.trim()

  // ② fallback：从命令首行推导摘要（动词+宾语，替代裸命令行）
  const cmd = commandText.value.split('\n')[0].trim()
  if (!cmd) return ''
  const m = cmd.match(/^(?:cd\s+(.+)|(?:cat|less|head|tail|view|open)\s+(.+)|(?:ls|ll|dir)(?:\s+(.+))?|(?:npm|pnpm|yarn)\s+(.+)|(?:grep|rg|ag)\s+(.+))$/)
  if (m) {
    if (m[1]) return `进入目录 ${m[1].split('/').pop() || m[1]}`
    if (m[2]) return `查看文件 ${m[2].split('/').pop()}`
    if (m[3] !== undefined) return `列出目录 ${m[3] ? m[3].split('/').pop() : '当前目录'}`
    if (m[4]) return `运行 ${m[4]}`
    if (m[5]) return `搜索 ${m[5].split(' ')[0]}`
  }
  return cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd
})

/** 高危命令模式（用于风险标签，与后端沙箱策略对齐） */
const HIGH_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/rm\s+-(r|rf|fr)[^|]*\s+(\/|~|\$HOME)/, '删除根/家目录'],
  [/curl[^|]*\|\s*(ba|da)?sh\b/, 'curl 管道执行'],
  [/wget[^|]*\|\s*(ba|da)?sh\b/, 'wget 管道执行'],
  [/base64\s*-d[^|]*\|\s*(ba|da)?sh\b/, 'base64 解码执行'],
  [/nc\s+-[^|]*\s*-e\b/, '反弹 shell'],
  [/mkfs|dd\s+if=.*of=\/dev\//, '磁盘操作'],
  [/chmod\s+777\s+(\/|~|\$HOME)/, '根目录放权'],
  [/sudo\s+rm/, 'sudo 删除'],
]

/** 风险等级：high（高危命令，full 权限） / elevated（普通命令 + full 权限）/ normal */
const riskLevel = computed<'high' | 'elevated' | 'normal'>(() => {
  if (!isCommand.value) return 'normal'
  const cmd = commandText.value
  const isHigh = HIGH_RISK_PATTERNS.some(([re]) => re.test(cmd))
  if (isHigh) return 'high'
  // full 权限下命令可操作任意路径 → elevated 提示
  if (props.permission === 'full') return 'elevated'
  return 'normal'
})

const riskLabel = computed(() => {
  const map: Record<string, string> = {
    high: t('chatui.riskHigh'),
    elevated: t('chatui.riskElevated'),
    normal: t('chatui.riskNormal'),
  }
  return map[riskLevel.value]
})

/** 权限档徽标：本操作在哪个沙箱权限档下执行（护城河可视化） */
const permLabel = computed(() => {
  const map: Record<string, string> = {
    'workspace-only': t('chatui.permWorkspaceOnly'),
    sandbox: t('chatui.permSandbox'),
    full: t('chatui.permFull'),
  }
  return map[props.permission] || t('chatui.permSandbox')
})

/** 沙箱拦截徽标：工具结果含越权/拦截特征（后端 sandbox 返回"路径越权"等） */
const isBlocked = computed(() => {
  const r = (props.result || '').toLowerCase()
  return (
    r.includes('路径越权') ||
    r.includes('越权') ||
    r.includes('blocked by sandbox') ||
    r.includes('沙箱拦截') ||
    r.includes('权限不足')
  )
})

function toggle() {
  if (props.args || props.result) {
    expanded.value = !expanded.value
  }
}
</script>

<style scoped>
.tool-call-block {
  margin: 4px 0;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  overflow: hidden;
  font-size: var(--text-sm);
  transition: border-color var(--duration-fast) var(--ease-out), opacity var(--duration-fast);
}

.tool-call-block.running { border-left-color: var(--accent); }
.tool-call-block.stream_executing { border-left-color: var(--accent); }
.tool-call-block.done { border-left-color: var(--success); opacity: 0.85; }
.tool-call-block.error { border-left-color: var(--error); }
.tool-call-block.pending { border-left-color: var(--warning); }
.tool-call-block.denied { border-left-color: var(--error); opacity: 0.7; }
.tool-call-block.skipped { border-left-color: var(--border-color); opacity: 0.6; }
.tool-call-block.cancelled { border-left-color: var(--warning, #d97706); opacity: 0.7; }
.tool-call-block.approved { border-left-color: var(--success); }

/* 拒绝/跳过：工具名划线 + 淡化（用户可见"被拒"反馈） */
.tool-call-block.denied .tool-name,
.tool-call-block.skipped .tool-name {
  text-decoration: line-through;
  color: var(--text-muted);
}

.tool-call-block.stream_executing .tool-status-indicator {
  color: var(--accent);
  animation: stream-pulse 1.2s ease-in-out infinite;
}
@keyframes stream-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.tool-call-block.denied .tool-status-indicator {
  color: var(--error);
}
.tool-call-block.skipped .tool-status-indicator {
  color: var(--text-muted);
}
.tool-call-block.cancelled .tool-status-indicator {
  color: var(--warning, #d97706);
}
.tool-call-block.approved .tool-status-indicator {
  color: var(--success);
}

/* 状态过渡动画 */
.tool-call-block.just-completed {
  animation: pulse-done 0.6s ease-out;
}

@keyframes pulse-done {
  0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.5); border-color: var(--success); }
  50%  { box-shadow: 0 0 0 6px rgba(34,197,94,0.18); border-color: var(--success); }
  100% { box-shadow: 0 0 0 0 transparent; border-color: var(--border-color); }
}

.tool-call-block.just-errored {
  animation: pulse-error 0.6s ease-out;
}

@keyframes pulse-error {
  0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.5); border-color: var(--error); }
  50%  { box-shadow: 0 0 0 6px rgba(239,68,68,0.18); border-color: var(--error); }
  100% { box-shadow: 0 0 0 0 transparent; border-color: var(--border-color); }
}

/* Category color accents — subtle, not competing with status */
.tool-call-block.cat-memory { border-left-color: #8b5cf6; }
.tool-call-block.cat-file { border-left-color: #2563eb; }
.tool-call-block.cat-network { border-left-color: #059669; }
.tool-call-block.cat-system { border-left-color: #64748b; }
.tool-call-block.running.cat-memory,
.tool-call-block.running.cat-file,
.tool-call-block.running.cat-network,
.tool-call-block.running.cat-system { border-left-color: var(--accent); }

/* Header */
.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
}

.tool-status-indicator {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.tool-call-block.running .tool-status-indicator {
  color: var(--warning);
}

.tool-call-block.done .tool-status-indicator {
  color: var(--success);
}

.tool-call-block.error .tool-status-indicator {
  color: var(--error);
}

.spin {
  animation: spin 1.5s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.tool-name {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  flex: 1;
  font-weight: 500;
}

/* 读文件定位（P0-3）：文件名可点击 → 打开文件 + 定位行号 */
.tool-name.file-link {
  color: var(--accent, #6366f1);
  cursor: pointer;
  border-bottom: 1px dashed color-mix(in srgb, var(--accent, #6366f1) 40%, transparent);
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-name.file-link:hover {
  background: color-mix(in srgb, var(--accent, #6366f1) 10%, transparent);
  border-bottom-style: solid;
}

.tool-category-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  flex-shrink: 0;
}

.cat-memory .tool-category-tag { background: rgba(139, 92, 246, 0.12); color: var(--cat-memory); }
.cat-file .tool-category-tag { background: rgba(37, 99, 235, 0.12); color: var(--cat-file); }
.cat-network .tool-category-tag { background: rgba(5, 150, 105, 0.12); color: var(--cat-network); }
.cat-system .tool-category-tag { background: rgba(100, 116, 139, 0.12); color: var(--cat-system); }

.dark .cat-memory .tool-category-tag { background: rgba(139, 92, 246, 0.2); }
.dark .cat-file .tool-category-tag { background: rgba(37, 99, 235, 0.2); }
.dark .cat-network .tool-category-tag { background: rgba(5, 150, 105, 0.2); }
.dark .cat-system .tool-category-tag { background: rgba(100, 116, 139, 0.2); }

.tool-duration {
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-family: var(--font-mono);
  flex-shrink: 0;
}
/* 写文件行数徽标（+N/-M 行，对齐 ChatGPT 代码写入反馈）：header 内联、彩色、完成时脉冲强调 */
.tool-lines {
  display: inline-flex;
  align-items: center;
  margin-left: 4px;
  flex-shrink: 0;
}
.lines-badge {
  font-size: 11px;
  font-weight: 600;
  font-family: var(--font-mono);
  color: #059669;
  background: rgba(16, 185, 129, 0.12);
  border: 1px solid rgba(16, 185, 129, 0.35);
  border-radius: 5px;
  padding: 1px 7px;
  white-space: nowrap;
}
.tool-lines.lines-live .lines-badge {
  animation: lines-pop 0.6s ease-out;
}

/* 执行中"写入 N 行"徽标：accent 色（与完成态绿色区分），数字等宽平滑滚动 */
.lines-badge.live {
  color: var(--accent);
  background: var(--accent-muted);
  border-color: var(--accent);
  font-variant-numeric: tabular-nums;
}

/* 错误摘要（header 内，失败原因一眼可见） */
.tool-error-hint {
  font-size: 11px;
  color: var(--danger, #ef4444);
  background: rgba(239, 68, 68, 0.08);
  border: 0.5px solid rgba(239, 68, 68, 0.25);
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
  flex-shrink: 0;
}
@keyframes lines-pop {
  0% { transform: scale(0.8); opacity: 0.5; }
  50% { transform: scale(1.12); }
  100% { transform: scale(1); opacity: 1; }
}

.tool-expand-toggle {
  display: flex;
  color: var(--text-muted);
  flex-shrink: 0;
}

.tool-expand-toggle svg {
  transition: transform var(--duration-fast) var(--ease-out);
}

.tool-expand-toggle svg.rotated {
  transform: rotate(180deg);
}

/* Body */
.tool-body {
  padding: 6px 10px;
  border-top: 1px solid var(--border-color);
}

.tool-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool-section + .tool-section {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-color);
}

/* 写文件流式区：行号代码视图（ChatGPT CodeDiff 同款——代码逐行"长出来"，自动吸底） */
.stream-code {
  max-height: 260px;
  overflow-y: auto;
  border-radius: 6px;
  background: var(--code-bg, rgba(15, 20, 30, 0.9));
  padding: 8px 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 1.55;
}
.stream-code-line {
  display: flex;
  padding: 0 10px;
}
.stream-code-line:hover {
  background: rgba(128, 128, 128, 0.08);
}
.stream-code-ln {
  flex-shrink: 0;
  width: 40px;
  text-align: right;
  padding-right: 12px;
  color: var(--text-muted, #8b93a7);
  opacity: 0.6;
  user-select: none;
  font-variant-numeric: tabular-nums;
}
.stream-code-text {
  white-space: pre;
  color: var(--text-primary, #e2e8f0);
}
.stream-code::-webkit-scrollbar {
  width: 6px;
}
.stream-code::-webkit-scrollbar-thumb {
  background: var(--border-color, #334155);
  border-radius: 3px;
}

.tool-section-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.tool-params {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.tool-param-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
}

.param-key {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
  min-width: 60px;
}

.param-value {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-primary);
  background: var(--bg-primary);
  padding: 2px 6px;
  border-radius: 3px;
  word-break: break-all;
}

.tool-result {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg-primary);
  padding: 8px;
  border-radius: var(--radius-xs);
  max-height: 200px;
  overflow-y: auto;
}

.tool-error .tool-result {
  background: var(--error-muted);
  color: var(--error);
}

.tool-result-expand {
  font-size: var(--text-xs);
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 0;
  text-align: left;
}

.tool-result-expand:hover {
  text-decoration: underline;
}

/* ===== 命令执行卡片（Run Command 风格） ===== */
.cmd-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}
.cmd-summary {
  font-weight: 500;
}
.risk-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  letter-spacing: 0.3px;
  flex-shrink: 0;
}
/* 权限档徽标：本操作在哪个沙箱档下执行（护城河可视化） */
.perm-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  border: 0.5px solid var(--border-color);
  color: var(--text-secondary);
  background: transparent;
}
.perm-workspace-only { color: #0f766e; border-color: rgba(16, 185, 129, 0.4); }
.perm-sandbox { color: #b45309; border-color: rgba(245, 158, 11, 0.4); }
.perm-full { color: #b91c1c; border-color: rgba(239, 68, 68, 0.45); }
/* 沙箱拦截徽标 */
.blocked-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  color: #fff;
  background: var(--error, #ef4444);
}
/* lint_file 诊断 */
.lint-count {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  color: #b45309;
  background: rgba(245, 158, 11, 0.15);
}
.lint-count.has-error {
  color: #fff;
  background: var(--error, #ef4444);
}
.lint-clean-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  color: #0f766e;
  background: rgba(16, 185, 129, 0.14);
}
.lint-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 260px;
  overflow-y: auto;
}
.lint-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 9px;
  border-radius: 7px;
  font-size: 12px;
  background: var(--bg-secondary);
}
.lint-item.error { border-left: 2px solid var(--error, #ef4444); }
.lint-item.warning { border-left: 2px solid #f59e0b; }
.lint-sev {
  flex-shrink: 0;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
}
.lint-item.error .lint-sev { background: var(--error, #ef4444); }
.lint-item.warning .lint-sev { background: #f59e0b; }
.lint-line {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}
.lint-msg { color: var(--text-primary); }
.lint-clean {
  padding: 10px 4px;
  font-size: 12px;
  color: #0f766e;
}
.risk-high {
  background: rgba(239, 68, 68, 0.14);
  color: var(--error);
}
.risk-elevated {
  background: rgba(234, 179, 8, 0.14);
  color: var(--warning);
}
.cmd-head {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-primary);
  border-radius: var(--radius-xs);
  padding: 6px 10px;
  margin-bottom: 8px;
  font-family: var(--font-mono);
}
.cmd-prompt {
  color: var(--success);
  font-weight: 600;
  flex-shrink: 0;
}
.cmd-line {
  font-size: 11px;
  color: var(--text-primary);
  word-break: break-all;
  white-space: pre-wrap;
}
.cmd-output {
  max-height: 320px;
}

/* ===== Confirm Panel ===== */
.tool-call-block.pending {
  border-color: var(--warning);
}

.confirm-panel {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--bg-secondary);
}

.confirm-header {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.confirm-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.confirm-desc {
  font-size: 12px;
  color: var(--text-secondary);
}

.confirm-args {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.confirm-args code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-primary);
  padding: 2px 6px;
  border-radius: 3px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

/* 自动允许倒计时徽标：内嵌在"允许执行"按钮上，数字实时递减 */
.confirm-allow-countdown {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  background: rgba(255, 255, 255, 0.22);
  animation: auto-pulse 1s ease-in-out infinite;
}
/* 倒计时结束自动放行提示（替代授权按钮，明确"正在自动执行"） */
.tba-auto-approving {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--success, #3fb950);
  background: rgba(63, 185, 80, 0.12);
  border-radius: 9px;
  padding: 3px 9px;
  animation: auto-pulse 1.2s ease-in-out infinite;
}
@keyframes auto-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.confirm-deny,
.confirm-session,
.confirm-allow {
  padding: 5px 14px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: background var(--duration-fast);
}

.confirm-deny {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.confirm-deny:hover {
  background: var(--bg-hover);
}

/* 本会话全部允许：介于拒绝与仅本次之间，按钮略小 */
.confirm-session {
  background: var(--accent-muted);
  color: var(--accent);
}

.confirm-session:hover {
  filter: brightness(0.95);
}

.confirm-allow {
  background: var(--accent);
  color: white;
}

.confirm-allow:hover {
  filter: brightness(1.1);
}

/* 授权按钮组（对齐 WorkBuddy tool-head__actions：header 一行内嵌，pending 不展开 body） */
.tool-head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 6px;
  flex-shrink: 0;
}
/* pending 命令状态标签（WorkBuddy "Run Command?" 同款） */
.run-command-ask {
  font-size: 11px;
  font-weight: 600;
  color: var(--warning, #b45309);
  white-space: nowrap;
  flex-shrink: 0;
}
.tba-btn {
  font-size: 11px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 5px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.35));
  background: transparent;
  color: var(--text-secondary, inherit);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s;
}
.tba-btn:hover { border-color: var(--accent, #4f8cff); }
.tba-allow {
  color: #2ea043;
  border-color: rgba(46, 160, 67, 0.45);
  background: rgba(46, 160, 67, 0.08);
}
.tba-allow:hover { background: rgba(46, 160, 67, 0.16); }
.tba-session {
  color: var(--accent, #4f8cff);
  border-color: rgba(79, 140, 255, 0.45);
}
.tba-session:hover { background: rgba(79, 140, 255, 0.12); }
.tba-deny {
  color: #d1242f;
  border-color: rgba(209, 36, 47, 0.45);
}
.tba-deny:hover { background: rgba(209, 36, 47, 0.1); }

/* 写文件执行中标题流光（WorkBuddy cb-shining-text 同款：渐变扫过，表现"正在写入"状态感） */
.tool-shining {
  background: linear-gradient(90deg, var(--text-primary) 40%, var(--accent, #6366f1) 50%, var(--text-primary) 60%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: tool-shining-sweep 1.6s linear infinite;
}
@keyframes tool-shining-sweep {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* 运行中摘要行（折叠态）：三点动画 + 输出尾部预览，单行省略 */
.tool-running-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px 8px;
  font-size: 11.5px;
  color: var(--text-muted, var(--text-secondary));
  min-width: 0;
}
.tool-running-hint .trh-dots {
  display: inline-flex;
  gap: 2px;
  flex-shrink: 0;
}
.tool-running-hint .trh-dots .dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent, #6366f1);
  animation: trh-bounce 1.2s infinite ease-in-out;
}
.tool-running-hint .trh-dots .dot:nth-child(2) { animation-delay: 0.15s; }
.tool-running-hint .trh-dots .dot:nth-child(3) { animation-delay: 0.3s; }
.tool-running-hint .trh-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
@keyframes trh-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
  40% { transform: translateY(-2px); opacity: 1; }
}

/* 写文件行数实时滚动条（折叠态）：文件名 + 大数字 CountUp + 进度 + 最近增量标签 */
.write-progress-bar {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 0 12px 8px;
  font-size: 12px;
  flex-wrap: wrap;
  min-width: 0;
}
/* 折叠态文件名栏（2026-08-27 补，对齐 WorkBuddy WriteFileRenderer：文件图标+文件名+行数三并列）：
   让"在写哪个文件"一眼可见；点击文件名展开详情 */
.write-progress-bar .wp-file {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-primary);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11.5px;
  min-width: 0;
  max-width: 220px;
}
.write-progress-bar .wp-file-icon {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  font-family: var(--font-mono, ui-monospace, monospace);
  background: color-mix(in srgb, var(--accent, #6366f1) 12%, transparent);
  color: var(--accent, #6366f1);
}
.write-progress-bar .wp-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  border-bottom: 1px dashed var(--border-color);
}
.write-progress-bar .wp-file-name:hover {
  color: var(--accent, #6366f1);
  border-bottom-style: solid;
}
.write-progress-bar .wp-count {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 15px;
  font-weight: 700;
  color: var(--accent, #6366f1);
  font-variant-numeric: tabular-nums;
}
.write-progress-bar .wp-detail {
  color: var(--text-muted, var(--text-secondary));
  font-size: 11px;
}
.write-progress-bar .wp-progress {
  color: var(--text-muted, var(--text-secondary));
  font-size: 11px;
}
/* 完成态保留的最终删除数（红，对齐 PSL .psl-del） */
.write-progress-bar .wp-del {
  color: #dc2626;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.write-progress-bar .wp-delta {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  color: var(--accent, #6366f1);
  background: color-mix(in srgb, var(--accent, #6366f1) 10%, transparent);
  border-radius: 4px;
  padding: 0 5px;
  line-height: 1.6;
  animation: wp-pop 0.25s ease-out;
}
@keyframes wp-pop {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
