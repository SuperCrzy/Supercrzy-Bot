/**
 * browser — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'

const tool: ToolDef = {
    name: 'browser',
    description: 'AI 浏览器驾驶：让你能自主打开网页、看页面可点元素、点/输入/后退/滚动、读现页文本。当任务需要 核实一个网页的精确内容/看真实排版视觉(截图)/在站内做交互(点结果/填字段/翻页) 时，先用它 navigate 打开目标，再 look 看可点清单 → click/type 逐原语推进。也可 tab 右栏实时看画面。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['navigate', 'look', 'click', 'type', 'press', 'back', 'scroll', 'url', 'snapshot'], description: 'navigate(开url)/look(看可点清单+文本)/click(需text或x,y)/type(输入text,into可选焦点占位)/press(key)/back(后退)/scroll(deltaY)/url(当前地址)/snapshot(标题)' },
        url: { type: 'string', description: 'navigate 要打开的网址' },
        text: { type: 'string', description: 'click 要点的可见文本 / type 要输入的文字' },
        x: { type: 'number', description: 'click 用坐标时的 x' },
        y: { type: 'number', description: 'click 用坐标时的 y' },
        into: { type: 'string', description: 'type 要填的占位/控件名(可选)' },
        key: { type: 'string', description: 'press 的键(Enter/Escape/Backspace…)' },
        deltaY: { type: 'number', description: 'scroll 像素(默认300)' },
      },
      required: ['action'],
    },
  async execute(args, ctx) {
    const a = String(args.action || '').trim()
    try {
      const { browserNavigate, browserScreenshot, browserReadText,
        browserClickText, browserClickAt, browserTypeText, browserPressKey, browserBack, browserScroll, browserListInteractive } = await import('../services/ai-browser')
      let out: unknown = ''
      if (a === 'navigate') {
        const url = String(args.url || '').trim()
        if (!url) return '❌ browser navigate 需要 url'
        const s = await browserNavigate(url); out = `已打开 ${s.url}（${s.title || ''}）`
      } else if (a === 'look') {
        const items = await browserListInteractive().catch(() => [])
        out = '当前页可交互元素:\n' + (items.length ? items.join('\n') : '(无可点击简单页)')
        try { const t = await browserReadText(12000); if (t.text) out += `\n文本预览: ${t.text.slice(0, 400)}` } catch {}
      } else if (a === 'click') {
        const r = args.text ? await browserClickText(String(args.text)) : args.x != null ? await browserClickAt(Number(args.x), Number(args.y)) : null
        out = r ? `已点击${r.ok ? '' : '失败: ' + r.error}${r.ok && r.url ? ' → ' + r.url : ''}` : '❌ click 需 text 或 x/y'
      } else if (a === 'type') {
        const r = await browserTypeText(String(args.text || ''), args.into ? String(args.into) : undefined)
        out = r.ok ? '已输入' : '输入失败'
      } else if (a === 'press') {
        out = (await browserPressKey(String(args.key || ''))).ok ? `已按 ${args.key}` : '按键失败'
      } else if (a === 'back') {
        out = (await browserBack()).ok ? '已后退' : '后退失败'
      } else if (a === 'scroll') {
        out = (await browserScroll(Number(args.deltaY) || 300)).ok ? '已滚动' : '滚动失败'
      } else if (a === 'url') {
        const s = await browserScreenshot(); out = `当前: ${s.url}`
      } else if (a === 'snapshot') {
        const s = await browserScreenshot(); return `📄 ${s.url}\n标题: ${s.title || ''}`
      } else return '❌ browser 未知 action: ' + a
      // 动作后带回一屏缩略文本，便于 AI 自读是不是要到目标
      try { const t = await browserReadText(2000); if (t.text) out += `\n[现页可见] ${t.text.slice(0, 200)}` } catch {}
      // 页面已变化动作后补一帧截图 → 更新 lastFrame，右栏 /browser/latest 轮询即见跳转(2026-09-04)
      if (a === 'navigate' || a === 'click' || a === 'back' || a === 'scroll' || a === 'press' || a === 'type') {
        try { await browserScreenshot() } catch { /* 忽略，read 类已自带 */ }
      }
      return String(out)
    } catch (e: any) {
      return '❌ browser 失败: ' + (e?.message || e)
    }
  },
}

export default tool
