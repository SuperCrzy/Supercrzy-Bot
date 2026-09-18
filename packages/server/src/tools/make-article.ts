/**
 * make_article — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'

const tool: ToolDef = {
    name: 'make_article',
    description: '内容工厂：给定一个 URL（网页/文章/视频页），自动 抓正文→提炼成结构化中文文稿→输出图文成品，一次跑完，无需你分步操作。适合"把这个链接整理成文章/转成中文稿/做摘要长文"。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要加工的网页/文章/视频的完整 URL' },
        focus: { type: 'string', description: '（可选）你特别关注的要点/角度' },
      },
      required: ['url'],
    },
  async execute(args, ctx) {
    const url = String(args.url || '').trim()
    if (!url) return '❌ make_article 需要 url 参数'
    try {
      const { makeArticle } = await import('../services/content-factory')
      const stream = (m: string) => { if (ctx?.onOutput) ctx.onOutput('', `[内容工厂] ${m}\n`) }
      const r = await makeArticle({ url, focus: args.focus }, (p) => stream(`（${p.msg}）`))
      if (!r.ok) return `❌ 内容工厂未能完成: ${r.stage?.msg || r.error}`
      // 产物返回 markdown；若前端支持大文本将走 onOutput 已流式
      return `${r.title}\n\n${r.md}`
    } catch (e: any) {
      return `❌ 内容工厂调用失败: ${e.message}`
    }
  },
}

export default tool
