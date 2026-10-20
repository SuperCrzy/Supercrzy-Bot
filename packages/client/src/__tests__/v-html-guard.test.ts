/**
 * `v-html` 站点守卫（I3 配套，2026-09-24）
 *
 * I3 修的不是"某一行"，而是"AI 内容不许未经清洗进 `v-html`"这条**规则**。
 * 规则要能防住下一次才叫修住 —— 否则今天补了 3 个点，明天新加第 4 个点照样漏。
 *
 * 做法：把全 client 的 `v-html` 表达式抓出来，**逐个必须能归到已知类别**。
 * 归不进去就失败 → 逼着新增站点的人显式做一次分类判断（并在这里登记），
 * 而不是靠 review 时恰好有人想起来。
 *
 * 已知类别（改动本文件时同步维护）：
 *  - `sanitizeSvg(...)`            —— AI 产出的 SVG，**必须**走这里
 *  - markdown 渲染调用             —— 5 个 markdown-it 实例全为 `html: false`（裸 HTML 被转义）
 *  - `reasoningHtml`               —— ThinkingBlock 的 computed，值 = `reasoningMd.render(...)`，
 *                                     而 `reasoningMd` 是 `html: false`（由下面第 4 条断言兜住）
 *  - 自有静态图标常量              —— DetailPanel 的 `tab.icon` / `tb.icon`，值写死在 `tabs` 数组里
 */
import { describe, it, expect } from 'vitest'

import flowRenderer from '../components/chat/MessageFlowRenderer.vue?raw'
import chatView from '../views/ChatView.vue?raw'
import detailPanel from '../components/layout/DetailPanel.vue?raw'
import previewPane from '../components/layout/PreviewPane.vue?raw'
import thinkingBlock from '../components/chat/ThinkingBlock.vue?raw'
import collabWorkbench from '../views/CollabWorkbenchView.vue?raw'
import compareResult from '../components/chat/CompareResult.vue?raw'

const FILES: Array<{ name: string; src: string }> = [
  { name: 'components/chat/MessageFlowRenderer.vue', src: flowRenderer },
  { name: 'views/ChatView.vue', src: chatView },
  { name: 'components/layout/DetailPanel.vue', src: detailPanel },
  // 2026-10-20：右栏 preview tab 的内容渲染器（markdown 走 renderMarkdown，html:false）
  { name: 'components/layout/PreviewPane.vue', src: previewPane },
  { name: 'components/chat/ThinkingBlock.vue', src: thinkingBlock },
  { name: 'views/CollabWorkbenchView.vue', src: collabWorkbench },
  { name: 'components/chat/CompareResult.vue', src: compareResult },
]

/** 表达式 → 类别。返回 null = 未分类（测试失败）。 */
function classify(expr: string): string | null {
  if (expr.includes('sanitizeSvg(')) return 'sanitizeSvg'
  if (/renderMarkdown\(|renderMd\(|\.render\(/.test(expr)) return 'markdown(html:false)'
  if (expr === 'reasoningHtml') return 'markdown(html:false) 的 computed'
  if (/^(tab|tb)\.icon$/.test(expr.trim())) return '自有静态图标常量'
  return null
}

/** 抓 `<template>` 段里的 v-html（避开注释里的说明文字） */
function vHtmlBindings(src: string): string[] {
  const tpl = src.slice(0, src.indexOf('<script'))
  const out: string[] = []
  const re = /v-html="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tpl)) !== null) out.push(m[1].trim())
  return out
}

describe('v-html 站点守卫', () => {
  it('每个 v-html 表达式都能归入已知类别（新增站点必须显式分类）', () => {
    const unclassified: string[] = []
    for (const { name, src } of FILES) {
      for (const expr of vHtmlBindings(src)) {
        if (classify(expr) === null) unclassified.push(`${name}: v-html="${expr}"`)
      }
    }
    expect(
      unclassified,
      '这些 v-html 没有被分类。若渲染的是 AI/外部内容，必须用 sanitizeSvg 或用 html:false 的 markdown 渲染；' +
        '若确实是自有可信内容，请在本文件的 classify() 里登记并说明理由。',
    ).toEqual([])
  })

  it('AI 产出 SVG 的三处站点确实走了 sanitizeSvg（I3 的落地断言）', () => {
    // 逐个文件断言，避免"别处碰巧有一个 sanitizeSvg 就算过"
    expect(vHtmlBindings(flowRenderer).some((e) => e.includes('sanitizeSvg(')), 'MessageFlowRenderer 的图未清洗').toBe(true)
    expect(vHtmlBindings(chatView).some((e) => e.includes('sanitizeSvg(')), 'ChatView 的图未清洗').toBe(true)
    expect(vHtmlBindings(detailPanel).some((e) => e.includes('sanitizeSvg(')), 'DetailPanel 的图未清洗').toBe(true)
  })

  it('已无裸 SVG 直出（反例守卫：确认这类写法真的清零了）', () => {
    const naked: string[] = []
    for (const { name, src } of FILES) {
      for (const expr of vHtmlBindings(src)) {
        if (/(^|\.)(svg|node\.svg|expandedDiagramSvg)$/.test(expr.trim())) naked.push(`${name}: ${expr}`)
      }
    }
    expect(naked, '又出现了未清洗的 SVG 直出').toEqual([])
  })

  it('markdown 渲染调用都保持 html:false（否则上一条的豁免就不成立）', () => {
    // 标记豁免的前提是"裸 HTML 会被转义"。有人把 html 改成 true，豁免就必须撤销。
    for (const { name, src } of FILES) {
      const hits = [...src.matchAll(/new MarkdownIt\(\{([\s\S]*?)\}\)/g)]
      for (const h of hits) {
        expect(/html:\s*false/.test(h[1]), `${name} 的 MarkdownIt 未显式 html:false —— v-html 豁免失效`).toBe(true)
      }
    }
  })
})
