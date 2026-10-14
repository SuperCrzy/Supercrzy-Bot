import { describe, it, expect } from 'vitest'
import { parseFeedXml, filterNews } from './supercrzy-feed'

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

  // 2026-09-20 重写：原来是 `expect(Array.isArray(r)).toBe(true)` —— 恒真断言，
  // 而且 `.catch(() => [])` 保证它永远绿，同时还真去打了网络。改为对纯函数 filterNews 做离线断言。
  it('关键词检索：命中标题或摘要，大小写不敏感', () => {
    const items = parseFeedXml(RSS_SAMPLE)
    const hit = filterNews(items, { query: 'nvidia' })
    expect(hit.length).toBe(1)
    expect(hit[0].title).toContain('Nvidia')
    // 大小写不敏感
    expect(filterNews(items, { query: 'NVIDIA' }).length).toBe(1)
    // 摘要命中也算（第二条摘要里有 12.9B，标题里没有）
    expect(filterNews(items, { query: '12.9B' }).map(n => n.title)).toContain('Nvidia Buys Hugging Face for $12.9B')
    // 查不到就是空，不是原样返回
    expect(filterNews(items, { query: 'zzz-not-exist' }).length).toBe(0)
  })

  it('分类过滤：只留该分类（或标题含该词）的条目', () => {
    const items = parseFeedXml(RSS_SAMPLE)
    const hw = filterNews(items, { category: 'Hardware' })
    expect(hw.length).toBe(1)
    expect(hw[0].category).toBe('Hardware')
    expect(filterNews(items, { category: 'Models' }).length).toBe(1)
  })

  it('按日期倒序 + limit 切片：取到的必须是最新的 N 条', () => {
    const items = parseFeedXml(RSS_SAMPLE)
    const top2 = filterNews(items, { limit: 2 })
    expect(top2.length).toBe(2)
    expect(top2[0].date.startsWith('2026-08-28')).toBe(true)
    expect(top2[1].date.startsWith('2026-08-27')).toBe(true)
    // 默认 limit=10 → 全量 3 条
    expect(filterNews(items, {}).length).toBe(3)
  })

  it('不修改入参（过滤/排序都作用在新数组上）', () => {
    const items = parseFeedXml(RSS_SAMPLE)
    const before = items.map(n => n.title)
    filterNews(items, { query: 'nvidia', limit: 1 })
    filterNews(items, { limit: 1 })
    expect(items.map(n => n.title)).toEqual(before)
    expect(items.length).toBe(3)
  })
})
