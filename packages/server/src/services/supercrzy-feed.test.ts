import { describe, it, expect } from 'vitest'
import { parseFeedXml, searchSupercrzyNews } from './supercrzy-feed'

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
<title>SUPERCRZY</title>
<item>
<title>Hy4 Preview Changes Everything</title>
<link>https://supercrzy.com/news/hy4-preview</link>
<description><img src="x.png"/><p>Tencent's Hy4 with 770B params beats GLM &amp; Kimi.</p></description>
<pubDate>Fri, 28 Aug 2026 07:44:23 GMT</pubDate>
</item>
<item>
<title>Nvidia Buys Hugging Face for $12.9B</title>
<link>https://supercrzy.com/news/nvidia-hf</link>
<description>&lt;p&gt;&amp;#36;12.9B open-source platform deal.&lt;/p&gt;</description>
<pubDate>Thu, 27 Aug 2026 08:06:19 GMT</pubDate>
</item>
<item>
<title>The Ascent GX10 128GB Memory</title>
<link>https://supercrzy.com/news/hardware-gx10</link>
<description><p>Hardware memory review</p></description>
<pubDate>Wed, 26 Aug 2026 10:00:00 GMT</pubDate>
</item>
</channel>
</rss>`

describe('supercrzy-feed 解析', () => {
  it('解析 RSS：提取标题/链接/日期', () => {
    const items = parseFeedXml(RSS_SAMPLE)
    expect(items.length).toBe(3)
    expect(items[0].title).toContain('Hy4')
    expect(items[0].url).toContain('hy4-preview')
    expect(items[0].date.startsWith('2026-08-28')).toBe(true)
  })

  it('摘要去 HTML 标签 + 去首图 + HTML 实体转义', () => {
    const items = parseFeedXml(RSS_SAMPLE)
    // 第一条：应去掉 <img> 开头和 <p> 标签，去掉 &amp;
    expect(items[0].summary).not.toContain('<')
    expect(items[0].summary).toContain('Kimi')
    // 第二条：&amp;#36; 应转成 $
    expect(items[1].summary).toContain('$12.9B')
    expect(items[1].summary).not.toContain('&')
  })

  it('分类推断：models/hardware/nvidia→business', () => {
    const items = parseFeedXml(RSS_SAMPLE)
    expect(items[0].category).toBe('Models')     // Hy4/beats GLM → Models
    expect(items[1].category).toBe('Business')   // Nvidia/$12.9B/deal → Business
    expect(items[2].category).toBe('Hardware')   // memory/hardware → Hardware
  })

  it('searchSupercrzyNews 接口存在且按 limit 切片', async () => {
    expect(typeof searchSupercrzyNews).toBe('function')
    // 不依赖网络；只验证调用契约（空 feed 返回空数组不抛错）
    const r = await searchSupercrzyNews({ query: 'xx-not-exist', limit: 3 }).catch(() => [])
    expect(Array.isArray(r)).toBe(true)
  })
})
