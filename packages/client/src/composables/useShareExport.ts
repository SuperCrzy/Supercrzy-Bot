/**
 * 对话分享 / 导出（Grok 式传播杠杆）—— 从 ChatView.vue 抽出
 *
 * 三条出口都是"整段对话"的序列化，纯副作用 + 一个开关：
 *   - 复制 Markdown 到剪贴板
 *   - 下载 `.md`
 *   - 画一张分享图（canvas → PNG）
 *
 * 布局/绘制/文本提取的**纯逻辑**早已下沉在 `utils/share-export` 与 `utils/message-text`，
 * 本模块只负责浏览器副作用（clipboard / Blob / `<a download>` / canvas）。
 *
 * 约定：`title` 与 `messages` 传 **getter**。二者在 ChatView 里的声明位置在本模块调用点之后，
 * 直接传 `ref.value` 会在 setup 阶段读到未初始化的 const（TDZ）；且标题会随会话切换变化。
 */
import { ref } from 'vue'
import { messagePlainText } from '@/utils/message-text'
import {
  safeFileName, buildConversationMarkdown, computeShareBlocks, computeShareImageHeight, drawShareImage,
} from '@/utils/share-export'

export interface ShareMessageLike {
  role: string
  content: unknown
}

export interface UseShareExportOptions {
  title: () => string | undefined
  messages: () => ShareMessageLike[]
  t: (key: string) => string
  onWarn: (msg: string) => void
  onInfo: (msg: string) => void
  onError: (msg: string) => void
  /** 分享图最多取多少条消息（默认 6，与迁移前一致） */
  maxMessages?: number
}

export function useShareExport(opts: UseShareExportOptions) {
  const { title, messages, t, onWarn, onInfo, onError, maxMessages = 6 } = opts

  const shareMenuOpen = ref(false)

  /** 把整个对话转成 Markdown（纯逻辑在 utils/share-export，此处只供标题与文案） */
  function buildMarkdown(): string {
    return buildConversationMarkdown({
      title: title() || t('nav.newTask'),
      messages: messages() as any[],
      plainText: messagePlainText,
      meLabel: t('chat.me'),
      assistantLabel: 'SUPERCRZY',
    })
  }

  /** 复制为 Markdown */
  async function copyConversationMarkdown() {
    shareMenuOpen.value = false
    const md = buildMarkdown()
    if (!md.trim()) { onWarn(t('chat.shareEmpty')); return }
    try {
      await navigator.clipboard.writeText(md)
      onInfo(t('chat.shareCopied'))
    } catch {
      onError(t('chat.shareCopyFail'))
    }
  }

  /** 下载 Markdown 文件 */
  function downloadConversationMarkdown() {
    shareMenuOpen.value = false
    const md = buildMarkdown()
    if (!md.trim()) { onWarn(t('chat.shareEmpty')); return }
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${safeFileName(title())}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  /** 生成分享图（canvas 绘制对话卡片 → 下载 PNG）；布局与绘制在 utils/share-export */
  function generateShareImage() {
    shareMenuOpen.value = false
    const msgs = messages().filter((m) => m.role === 'user' || m.role === 'assistant')
    if (!msgs.length) { onWarn(t('chat.shareEmpty')); return }
    onInfo(t('chat.shareImageGenerating'))
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    ctx.font = '15px system-ui, sans-serif'
    const blocks = computeShareBlocks(msgs as any[], ctx, { plainText: messagePlainText, maxMessages })
    if (!blocks.length) { onWarn(t('chat.shareEmpty')); return }
    canvas.width = 1080
    canvas.height = computeShareImageHeight(blocks)
    drawShareImage(ctx, blocks, {
      title: title() || '',
      dateText: new Date().toLocaleDateString(),
      meLabel: t('chat.me'),
      assistantLabel: 'SUPERCRZY',
    })
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `${safeFileName(title())}.png`
    a.click()
  }

  return { shareMenuOpen, copyConversationMarkdown, downloadConversationMarkdown, generateShareImage }
}
