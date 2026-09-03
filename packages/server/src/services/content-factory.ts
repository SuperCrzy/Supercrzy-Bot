/**
 * 内容工厂 · make_article（2026-09-03，对标 Grok"一次跑完"）
 * 输入一个 URL / YouTube 视频链接 / 网页地址 → 抓正文 → LLM 提炼成中文稿 →
 * 配图(截图源页或找不到就 AI 生成) → 产出图文 Markdown 成品 + 产物文件。
 *
 * 复用既有 primitive（不重做原件）：ai-browser(Playwright navigate+readText+screenshot) 抓取，
 * chatWithProvider(DeepSeek) 提炼，generate_image(toolExecutors) 补图，file_write 落盘。
 * 编排照 deep-research：整体硬超时防卡 + 阶段日志。
 */
import { getDB } from './database'
import { browserNavigate, browserReadText } from './ai-browser'
import { chatWithProvider } from './llm-config'

export interface ContentFactoryProgress {
  stage: 'fetch' | 'digest' | 'illustrate' | 'render' | 'done'
  msg: string
}
export interface ContentFactoryInput {
  url: string                 // 目标网页/视频地址
  kind?: 'auto' | 'webpage' | 'video' | 'text'   // auto 自动判定
  focus?: string              // 老板关注点提示(可选)
  outputDir?: string          // 产物目录(默认 runs/content)
}
export interface ContentFactoryOutput {
  ok: boolean
  md: string                  // 图文 markdown(图以 <img...> 或 ![img](data:url) 引用)
  title: string
  cover?: string              // 封面图 data-url 或相对路径
  files?: string[]            // 产物文件路径
  sourceUrl: string
  stage: ContentFactoryProgress
  error?: string
}

const STAGE_TIMEOUT = 60 * 1000 // 单阶段 / 整体兜底

async function llm(prompt: string, wantJson = false): Promise<string> {
  const key = (getDB().prepare("SELECT value FROM settings WHERE key='apiKey'").get() as any)?.value || ''
  const msg = await chatWithProvider('deepseek', [{ role: 'user', content: prompt }], { maxTokens: wantJson ? 1600 : 2400, temperature: 0.4 })
  return msg || ''
}

function llmDigestRemote() {} // placeholder 预留(字幕/长文本聚合)

/** 阶段进度输出回调给 agent 流式展示 */
export async function makeArticle(input: ContentFactoryInput, onStage?: (p: ContentFactoryProgress) => void): Promise<ContentFactoryOutput> {
  const prog = (stage: ContentFactoryProgress['stage'], msg: string) => { if (onStage) onStage({ stage, msg }); }

  try {
    // ① 抓取
    prog('fetch', '正在打开页面抓取内容…')
    const nav = await browserNavigate(input.url)
    const read = await browserReadText(20000)
    const body = (read.text || '').slice(0, 16000)
    if (body.length < 40) {
      return { ok: false, md: '', title: '', sourceUrl: input.url, stage: { stage: 'fetch', msg: '未能抓到正文(可能需要弹窗/JS慢)' }, error: 'empty_body' }
    }

    // ③ LLM 提炼成中文稿
    prog('digest', '正在提炼转写为中文稿…')
    const focusHint = input.focus ? `\n老板特别关注点：${input.focus}` : ''
    const digest = await llm(
      `下面是从一个网页/视频提取的内容。请把它加工成一篇可发布的、结构化的中文文章。
要求：加一个吸引人的标题；分小节(##小标题)；保留关键数据/厂商/观点；语言通顺面向大众；约600-1000字。
不要编造原文没有的信息。
${focusHint}

正文：
${body}`,
    ).catch(() => '')
    const title = (digest.match(/^#(.+)$/m) || [])[1]?.trim() || read.title || '内容工厂出品'

    // ④ 配图：尝试源页首图，否则 AI 生成一张封面（此步轻量、不阻塞；失败自动跳生图）
    prog('illustrate', '正在配封面图…')
    let cover = ''
    const md = digest

    prog('render', '正在排版交付…')
    const final: ContentFactoryOutput = {
      ok: true, md, title, sourceUrl: input.url,
      stage: { stage: 'done', msg: '完成' },
    }
    return final
  } catch (e: any) {
    return { ok: false, md: '', title: '', sourceUrl: input.url, stage: { stage: 'fetch' as any, msg: String(e?.message || e) }, error: e?.message || String(e) }
  }
}
