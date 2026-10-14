/**
 * AI 浏览器 — key 命名空间的纯逻辑回归（不启动 Chrome，不联网）
 *
 * 背景（2026-09-23）：右栏看不到 AI 操作画面的根因是**两套 key 不相交** ——
 * 路由侧拼 `'wb:' + sid`，AI 工具侧走便捷导出硬编码 `'default'`。
 * 现在两侧都调 browserKey()，本文件锁住"它们必然相等"这个不变量。
 */
import { describe, it, expect } from 'vitest'
import { browserKey, normalizeUrl, BROWSER_KEY_PREFIX } from './ai-browser'

describe('browserKey — 路由侧与工具侧必须解析出同一个 key', () => {
  it('会话 id → 带前缀的 key', () => {
    expect(browserKey('sess-1')).toBe('wb:sess-1')
  })

  it('幂等：传已带前缀的 key 不二次拼接（这是两侧能对上对的关键性质）', () => {
    // 路由传 'wb:sess-1'、工具传 'sess-1' —— 必须落到同一个实例
    expect(browserKey('wb:sess-1')).toBe(browserKey('sess-1'))
    expect(browserKey(browserKey('sess-1'))).toBe(browserKey('sess-1'))
  })

  it('缺省/空值落到兼容桶 wb:default，且不等于裸 default', () => {
    expect(browserKey()).toBe('wb:default')
    expect(browserKey(null)).toBe('wb:default')
    expect(browserKey('')).toBe('wb:default')
    // 关键：工具侧的 key 必须是 namespace 后的 'wb:default'，
    // 不能是裸 'default' —— 否则又会和后台服务共用实例，回到老 bug
    expect(browserKey('default')).not.toBe('default')
    expect(browserKey('default')).toBe(`${BROWSER_KEY_PREFIX}default`)
  })

  it('超长会话 id 截断到 64 字符（防异常 key 撑爆实例桶）', () => {
    const k = browserKey('x'.repeat(200))
    expect(k).toBe(BROWSER_KEY_PREFIX + 'x'.repeat(64))
  })

  it('不同会话必然落到不同实例（隔离性）', () => {
    expect(browserKey('a')).not.toBe(browserKey('b'))
  })
})

/**
 * normalizeUrl — 地址栏裸域名的白屏回归
 *
 * 背景（2026-09-23）：老板在地址栏输入 `baidu.com` → 白屏。实测对照：
 * `baidu.com`/`example.com` → about:blank（6KB 白图）；
 * `https://www.baidu.com`/`https://example.com` → 正常。
 * 根因是 `page.goto('baidu.com')` 抛 "Cannot navigate to invalid URL" 且被静默吞掉。
 */
describe('normalizeUrl — 裸域名必须补上协议', () => {
  it('裸域名补 https（这就是白屏的直接原因）', () => {
    expect(normalizeUrl('baidu.com')).toBe('https://baidu.com')
    expect(normalizeUrl('www.baidu.com')).toBe('https://www.baidu.com')
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('example.com/a/b?c=1#d')).toBe('https://example.com/a/b?c=1#d')
  })

  it('已带协议的原样返回，不重复拼接', () => {
    expect(normalizeUrl('https://www.baidu.com')).toBe('https://www.baidu.com')
    expect(normalizeUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeUrl('file:///tmp/a.html')).toBe('file:///tmp/a.html')
  })

  it('本地 / 内网 / 裸 IP / 非 443 端口走 http', () => {
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeUrl('127.0.0.1:3000/api')).toBe('http://127.0.0.1:3000/api')
    expect(normalizeUrl('192.168.1.10')).toBe('http://192.168.1.10')
    expect(normalizeUrl('example.com:8080')).toBe('http://example.com:8080')
    // 显式 443 仍按 https
    expect(normalizeUrl('example.com:443')).toBe('https://example.com:443')
  })

  it('浏览器内部页 / 特殊协议原样返回（别把 about:blank 拼成 https://about:blank）', () => {
    expect(normalizeUrl('about:blank')).toBe('about:blank')
    expect(normalizeUrl('mailto:a@b.com')).toBe('mailto:a@b.com')
    expect(normalizeUrl('data:text/html,hi')).toBe('data:text/html,hi')
  })

  it('空输入落到 about:blank（而不是 https:// 这种半成品）', () => {
    expect(normalizeUrl('')).toBe('about:blank')
    expect(normalizeUrl('   ')).toBe('about:blank')
    expect(normalizeUrl(undefined as unknown as string)).toBe('about:blank')
  })
})
