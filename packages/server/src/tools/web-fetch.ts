/**
 * web_fetch — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { execFile } from 'child_process'
import { statSync } from 'fs'
import { resolve } from 'path'
import { readSetting } from './shared'

const tool: ToolDef = {
  name: 'web_fetch',
  description: '获取网页内容。返回网页的文本内容。',
  category: 'network',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '网页完整URL（含https://）' },
      maxLength: { type: 'number', description: '最大返回字符数，默认5000' },
    },
    required: ['url'],
  },
  async execute(args) {
    // 抓取分层（对齐 WorkBuddy WebFetch 能力）：
    // 1) Jina Reader 官方端点（配置 jinaApiKey → Authorization Bearer，更稳定，免费 100w token/月）
    // 2) Jina Reader 免费层（无 key 兜底，服务端渲染 JS → Markdown，解决 403/SPA 空白）
    // 3) 原生 fetch + 文本提取（轻量兜底）
    // 4) 无头浏览器渲染（Chrome headless 兜底，JS 重页面/SPA 也能抓到 DOM）
    const rawUrl = String(args.url || '').trim()
    if (!rawUrl) return '❌ 缺少 URL 参数'
    const maxLen = args.maxLength || 8000
    const jinaKey = readSetting('jinaApiKey')
    try {
      // ---- 1) Jina Reader 官方端点（带 key）----
      if (jinaKey) {
        try {
          const jr = await fetch(`https://r.jina.ai/${encodeURIComponent(rawUrl)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)', 'Accept': 'text/markdown, text/plain', 'Authorization': `Bearer ${jinaKey}` },
            redirect: 'follow',
            signal: AbortSignal.timeout(20000),
          })
          if (jr.ok) {
            const md = await jr.text()
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
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        })
        if (jr.ok) {
          const md = await jr.text()
          if (md && md.trim().length > 20) {
            return buildWebFetchResult(parseWebPageMeta(md.trim()), rawUrl, maxLen)
          }
        }
      } catch {}

      // ---- 3) 原生 fetch ----
      const response = await fetch(rawUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(15000),
      })
      const contentType = response.headers.get('content-type') || ''

      if (!response.ok) {
        // 403/5xx → 交给无头浏览器（反爬/需要 JS）
        return webFetchChromeFallback(rawUrl, maxLen)
      }

      if (contentType.includes('text/html') || contentType.includes('text/plain')) {
        const text = await response.text()
        // 简单提取文本（去除HTML标签）
        const plainText = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        if (plainText.length < 50) return webFetchChromeFallback(rawUrl, maxLen) // 内容太少 → 可能 JS 渲染
        return buildWebFetchResult({ content: plainText }, rawUrl, maxLen)
      } else if (contentType.includes('application/json')) {
        const json = await response.json()
        const content = JSON.stringify(json, null, 2)
        return buildWebFetchResult({ content }, rawUrl, maxLen)
      } else {
        return `无法解析的内容类型: ${contentType}，状态码: ${response.status}`
      }
    } catch (err: any) {
      // fetch 异常（网络/超时）→ 最后尝试无头浏览器
      try { return await webFetchChromeFallback(rawUrl, maxLen) } catch { return `❌ 获取网页失败：${err.message}` }
    }
  },
}

// ---- 本工具私有辅助（随工具一并从 services/tools.ts 迁出，供本文件内使用）----
/** 无头浏览器兜底：系统 Chrome headless dump-dom 渲染 JS 页面（SPA/登录页/反爬）→ 提取正文 */
async function webFetchChromeFallback(rawUrl: string, maxLen: number): Promise<string> {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  const chrome = candidates.find((p) => { try { return statSync(p).isFile() } catch { return false } })
  if (!chrome) return `❌ 获取网页失败：所有抓取策略均失败（无可用浏览器渲染）`

  const dom = await new Promise<string>((resolve, reject) => {
    execFile(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--dump-dom', '--virtual-time-budget=10000', rawUrl], {
      timeout: 30000,
      maxBuffer: 20 * 1024 * 1024,
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
  const plainText = dom.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!plainText) throw new Error('浏览器渲染后无内容')
  return buildWebFetchResult({ content: plainText }, rawUrl, maxLen)
}

/** 解析 Jina Reader 返回的 Markdown 头部元信息（Title / URL Source / Published Time / Markdown Content） */
function parseWebPageMeta(md: string): { title?: string; sourceUrl?: string; publishedTime?: string; content: string } {
  const lines = md.split('\n')
  let title: string | undefined
  let sourceUrl: string | undefined
  let publishedTime: string | undefined
  let i = 0
  for (; i < Math.min(lines.length, 12); i++) {
    const l = lines[i]
    if (l.startsWith('Title:')) title = l.slice(6).trim() || undefined
    else if (l.startsWith('URL Source:')) sourceUrl = l.slice(11).trim() || undefined
    else if (l.startsWith('Published Time:')) publishedTime = l.slice(15).trim() || undefined
    else if (l.startsWith('Markdown Content:')) {
      i++
      break
    }
  }
  const content = lines.slice(i).join('\n').trim()
  return { title, sourceUrl, publishedTime, content }
}

/** web_fetch 结构化结果（WorkBuddy WebFetchCompactRenderer 同款：{title,url,publishedTime,content,truncated} 供前端解构展示） */
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
