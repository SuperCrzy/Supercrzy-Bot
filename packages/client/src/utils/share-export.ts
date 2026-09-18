/**
 * 对话导出（Markdown / 分享图）— P1-04 ChatView 拆分，2026-09-18
 *
 * 原来这三段（Markdown 拼装、canvas 换行、canvas 绘制）全内联在 ChatView.vue，
 * 其中"文件名净化"重复写了两次、canvas 布局高度计算无法直测。
 * 抽出后：① 纯计算可直测；② ChatView 只保留 blob/下载/剪贴板等副作用。
 */

/** 文件名净化：去掉 macOS/Windows 不允许的字符 */
export function safeFileName(title: string | undefined, fallback = 'conversation'): string {
  return (title || fallback).replace(/[\\/:*?"<>|]/g, '_')
}

export interface ShareMessage {
  role: string
  content?: any
}

/**
 * 把整个对话拼成 Markdown。
 * @param plainText 从消息取纯文本的回调（组件侧用 messagePlainText，含 flow 节点拼接逻辑）
 */
export function buildConversationMarkdown(opts: {
  title: string
  messages: ShareMessage[]
  plainText: (m: any) => string
  meLabel: string
  assistantLabel: string
  /** 生成时间文案（传入以便测试固定） */
  generatedAt?: string
}): string {
  const { title, messages, plainText, meLabel, assistantLabel } = opts
  const stamp = opts.generatedAt ?? new Date().toLocaleString()
  const head = `# ${title}\n\n> SUPERCRZY BOT · ${stamp}\n`
  const body: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = plainText(m).trim()
    if (!text) continue
    body.push(`---\n\n**${m.role === 'user' ? meLabel : assistantLabel}**\n\n${text}`)
  }
  return [head, ...body].join('\n\n')
}

/** canvas 文本自动换行（按 measureText 宽度，逐字符累积；换行符保留为空行） */
export function wrapText(ctx: { measureText: (t: string) => { width: number } }, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    if (!para) { lines.push(''); continue }
    let line = ''
    for (const ch of para) {
      const test = line + ch
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = ch }
      else line = test
    }
    lines.push(line)
  }
  return lines
}

export interface ShareBlock {
  role: string
  lines: string[]
  h: number
}

/** 分享图布局常量（与绘制共用，避免两处魔法数漂移） */
export const SHARE_LAYOUT = {
  width: 1080,
  pad: 56,
  titleH: 132,
  textMaxW: 1080 - 56 * 2 - 40,
  blockGap: 18,
  lineH: 26,
  blockChromeH: 46 + 22,
} as const

/**
 * 预先算好每条消息的换行与块高 —— canvas 高度必须在设置 canvas.height 之前确定，
 * 而换行又依赖 ctx 的度量，所以这一步独立出来才能测。
 */
export function computeShareBlocks(
  msgs: ShareMessage[],
  ctx: { measureText: (t: string) => { width: number } },
  opts: { plainText: (m: any) => string; textMaxW?: number; maxMessages?: number },
): ShareBlock[] {
  const maxW = opts.textMaxW ?? SHARE_LAYOUT.textMaxW
  const picked = typeof opts.maxMessages === 'number' ? msgs.slice(-opts.maxMessages) : msgs
  const blocks: ShareBlock[] = []
  for (const m of picked) {
    const text = opts.plainText(m).trim()
    if (!text) continue
    const lines = wrapText(ctx, text, maxW)
    blocks.push({ role: m.role, lines, h: SHARE_LAYOUT.blockChromeH + lines.length * SHARE_LAYOUT.lineH })
  }
  return blocks
}

/** 分享图总高（含标题区与底部留白） */
export function computeShareImageHeight(blocks: ShareBlock[]): number {
  return SHARE_LAYOUT.titleH + blocks.reduce((s, b) => s + b.h + SHARE_LAYOUT.blockGap, 0) + SHARE_LAYOUT.pad
}

export interface ShareDrawCtx {
  /** 用 any：真实 CanvasRenderingContext2D 的 fillStyle 是 string | CanvasGradient | CanvasPattern，
   *  收窄成 string 会导致真实 ctx 无法传入（TS2345） */
  fillStyle: any
  font: string
  fillText: (t: string, x: number, y: number) => void
  fillRect: (x: number, y: number, w: number, h: number) => void
  beginPath?: () => void
  roundRect?: (x: number, y: number, w: number, h: number, r: number) => void
  fill?: () => void
}

/** 分享图绘制（背景 + 标题区 + 消息块）；ctx 已按 computeShareImageHeight 设好尺寸 */
export function drawShareImage(
  ctx: ShareDrawCtx,
  blocks: ShareBlock[],
  opts: { title?: string; dateText: string; meLabel: string; assistantLabel: string },
): void {
  const { width: W, pad, titleH, blockGap, lineH } = SHARE_LAYOUT
  // 背景
  ctx.fillStyle = '#f5f5f7'
  ctx.fillRect(0, 0, W, titleH + blocks.reduce((s, b) => s + b.h + blockGap, 0) + pad)
  // 标题区
  ctx.fillStyle = '#141414'
  ctx.font = '700 26px system-ui, sans-serif'
  ctx.fillText('SUPERCRZY BOT', pad, 64)
  ctx.fillStyle = '#6b6b70'
  ctx.font = '400 16px system-ui, sans-serif'
  const sub = (opts.title || '').slice(0, 60)
  if (sub) ctx.fillText(sub, pad, 96)
  ctx.fillStyle = '#b0b0b6'
  ctx.font = '400 13px system-ui, sans-serif'
  ctx.fillText(opts.dateText, pad, 120)
  // 消息块
  let y = titleH
  for (const b of blocks) {
    const isUser = b.role === 'user'
    ctx.fillStyle = isUser ? '#ffffff' : '#141414'
    if (typeof ctx.roundRect === 'function' && typeof ctx.beginPath === 'function' && typeof ctx.fill === 'function') {
      ctx.beginPath()
      ctx.roundRect(pad, y, W - pad * 2, b.h, 16)
      ctx.fill()
    } else {
      ctx.fillRect(pad, y, W - pad * 2, b.h)
    }
    ctx.fillStyle = isUser ? '#9a9aa2' : '#8a8a94'
    ctx.font = '600 13px system-ui, sans-serif'
    ctx.fillText(isUser ? opts.meLabel : opts.assistantLabel, pad + 22, y + 26)
    ctx.fillStyle = isUser ? '#1f1f23' : '#e9e9ec'
    ctx.font = '15px system-ui, sans-serif'
    let ty = y + 54
    for (const ln of b.lines) {
      ctx.fillText(ln, pad + 22, ty)
      ty += lineH
    }
    y += b.h + blockGap
  }
}
