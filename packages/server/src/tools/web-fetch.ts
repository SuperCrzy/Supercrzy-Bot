/**
 * web_fetch — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { readSetting } from './shared'
import { fetchPublicWeb, resolveWithSignal } from '../services/public-web-fetch'
import { extractHtmlText } from '../services/html-text'

const MAX_READER_BYTES = 5 * 1024 * 1024
const DEFAULT_CONTENT_LENGTH = 8000
const MAX_CONTENT_LENGTH = 100_000

/** Fetch bodies are already decompressed; limit bytes as they arrive. */
async function readReaderText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_READER_BYTES) {
        void reader.cancel().catch(() => {})
        throw new Error('response_too_large')
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    reader.releaseLock()
  }
}

const tool: ToolDef = {
  name: 'web_fetch',
  description: '获取网页内容。返回网页的文本内容。',
  category: 'network',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '网页完整URL（含https://）' },
      maxLength: { type: 'number', description: '最大返回字符数，默认 8000，范围 1–100000' },
    },
    required: ['url'],
  },
  async execute(args) {
    // 抓取分层（对齐主流实现 WebFetch 能力）：
    // 1) Jina Reader 官方端点（配置 jinaApiKey → Authorization Bearer，更稳定，免费 100w token/月）
    // 2) Jina Reader 免费层（无 key 兜底，服务端渲染 JS → Markdown，解决 403/SPA 空白）
    // 3) 原生 fetch + 文本提取（轻量兜底）
    // Unrestricted browser fallback is disabled: subresources and redirects bypass URL checks.

    const rawUrl = String(args.url || '').trim()
    if (!rawUrl) return '❌ 缺少 URL 参数'
    try { await resolveWithSignal(rawUrl, AbortSignal.timeout(10000)) } catch (err) {
      if (err instanceof Error && err.message === 'fake_ip_dns_unavailable') return '❌ 检测到代理的 fake-IP，但无法通过独立 DNS 验证目标。请检查代理或 DNS 设置后重试。'
      if (err instanceof Error && err.name === 'TimeoutError') return '❌ 验证网页地址超时，请检查 DNS 或网络后重试。'
      return '❌ URL 无法访问或被安全策略拒绝'
    }
    const requestedLength = args.maxLength
    const maxLen = typeof requestedLength === 'number' && Number.isFinite(requestedLength) && requestedLength >= 1
      ? Math.min(Math.floor(requestedLength), MAX_CONTENT_LENGTH)
      : DEFAULT_CONTENT_LENGTH
    const jinaKey = readSetting('jinaApiKey')
    try {
      // ---- 1) Jina Reader 官方端点（带 key）----
      if (jinaKey) {
        try {
          const jr = await fetch(`https://r.jina.ai/${encodeURIComponent(rawUrl)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)', 'Accept': 'text/markdown, text/plain', 'Authorization': `Bearer ${jinaKey}` },
            redirect: 'error',
            signal: AbortSignal.timeout(20000),
          })
          if (jr.ok) {
            const md = await readReaderText(jr)
            if (md && md.trim().length > 20) {
              return buildWebFetchResult(parseWebPageMeta(md.trim()), rawUrl, maxLen)
            }
          }
        } catch {}
      }

      // ---- 2) Jina Reader 免费层 ----
      try {
        const jr = await fetch(`https://r.jina.ai/${encodeURIComponent(rawUrl)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)', 'Accept': 'text/markdown, text/plain' },
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
        })
        if (jr.ok) {
          const md = await readReaderText(jr)
          if (md && md.trim().length > 20) {
            return buildWebFetchResult(parseWebPageMeta(md.trim()), rawUrl, maxLen)
          }
        }
      } catch {}

      // ---- 3) 原生 fetch ----
      const response = await fetchPublicWeb(rawUrl, AbortSignal.timeout(15000))
      const contentType = response.contentType.toLowerCase()
      const sourceUrl = response.finalUrl || rawUrl

      if (response.status < 200 || response.status >= 300) return `❌ 获取网页失败：HTTP ${response.status}`

      if (contentType.includes('text/html')) {
        return buildWebFetchResult(extractHtmlText(response.text), sourceUrl, maxLen)
      } else if (contentType.includes('text/plain')) {
        return buildWebFetchResult({ content: response.text.trim() }, sourceUrl, maxLen)
      } else if (contentType.includes('application/json')) {
        const json = JSON.parse(response.text)
        const content = JSON.stringify(json, null, 2)
        return buildWebFetchResult({ content }, sourceUrl, maxLen)
      } else {
        return `无法解析的内容类型: ${contentType}，状态码: ${response.status}`
      }
    } catch (err: any) {
      return `❌ 获取网页失败：${err.message}`
    }
  },
}

// ---- 本工具私有辅助（随工具一并从 services/tools.ts 迁出，供本文件内使用）----
/** 解析 Jina Reader 返回的 Markdown 头部元信息（Title / URL Source / Published Time / Markdown Content） */
function parseWebPageMeta(md: string): { title?: string; sourceUrl?: string; publishedTime?: string; content: string } {
  const lines = md.split('\n')
  let title: string | undefined
  let sourceUrl: string | undefined
  let publishedTime: string | undefined
  let contentStart = -1
  let inlineContent = ''
  const firstNonEmpty = lines.find(line => line.trim())?.trim() || ''
  const looksLikeEnvelope = /^(?:Title:|URL Source:|Markdown Content:)/.test(firstNonEmpty)
  let scannedChars = 0
  for (let i = 0; looksLikeEnvelope && i < Math.min(lines.length, 128) && scannedChars < 32768; i++) {
    const l = lines[i]
    scannedChars += l.length + 1
    if (l.startsWith('Title:')) title = l.slice(6).trim() || undefined
    else if (l.startsWith('URL Source:')) sourceUrl = l.slice(11).trim() || undefined
    else if (l.startsWith('Published Time:')) publishedTime = l.slice(15).trim() || undefined
    else if (l.startsWith('Markdown Content:')) {
      contentStart = i + 1
      inlineContent = l.slice('Markdown Content:'.length).trim()
      break
    }
  }
  // A reader may return plain Markdown without the metadata envelope.
  // In that case none of the first lines are metadata to discard.
  const content = contentStart < 0 ? md.trim() : `${inlineContent ? `${inlineContent}\n` : ''}${lines.slice(contentStart).join('\n')}`.trim()
  return { title, sourceUrl, publishedTime, content }
}

/** web_fetch 结构化结果（主流实现 WebFetchCompactRenderer 同款：{title,url,publishedTime,content,truncated} 供前端解构展示） */
function buildWebFetchResult(meta: { title?: string; sourceUrl?: string; publishedTime?: string; content: string }, rawUrl: string, maxLen: number) {
  const content = meta.content || '(空内容)'
  const truncated = content.length > maxLen
  const body = truncated ? content.slice(0, maxLen) : content
  return JSON.stringify({
    ok: true,
    url: meta.sourceUrl || rawUrl,
    title: meta.title || '',
    publishedTime: meta.publishedTime || '',
    content: body,
    truncated,
    totalLength: content.length,
  })
}

export default tool
