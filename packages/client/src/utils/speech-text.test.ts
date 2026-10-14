import { describe, it, expect } from 'vitest'
import {
  markdownToSpeech,
  extractSpeakText,
  packForTts,
  ensureSentenceEnd,
  takeStreamChunk,
  TTS_PACK_MAX_CHARS,
  STREAM_FIRST_MIN_CHARS,
  STREAM_MAX_CHARS,
} from './speech-text'

describe('markdownToSpeech', () => {
  it('剔除代码块，保留正文', () => {
    const md = '结论如下：\n\n```ts\nconst a = 1\n```\n\n以上就是全部内容。'
    const s = markdownToSpeech(md)
    expect(s).toContain('结论如下：')
    expect(s).toContain('以上就是全部内容。')
    expect(s).not.toContain('const a = 1')
    expect(s).not.toContain('```')
  })

  it('剔除表格行与分隔线', () => {
    const md = '对比：\n\n| 项 | 值 |\n|---|---|\n| A | 1 |\n\n---\n\n结束。'
    const s = markdownToSpeech(md)
    expect(s).not.toContain('|')
    expect(s).not.toContain('---')
    expect(s).toContain('对比：')
    expect(s).toContain('结束。')
  })

  it('链接只读文字、不读 URL', () => {
    const s = markdownToSpeech('参考 [官方文档](https://example.com/a/b?c=1) 即可。')
    expect(s).toContain('参考 官方文档 即可。')
    expect(s).not.toContain('https://example.com')
  })

  it('行内 code 去反引号保留内容', () => {
    const s = markdownToSpeech('调用 `resolveActiveAction` 函数。')
    expect(s).toBe('调用 resolveActiveAction 函数。')
  })

  it('去掉标题/列表/引用/强调符号', () => {
    const md = '## 标题\n\n- **要点一**\n- 要点二\n\n> 引用内容'
    const s = markdownToSpeech(md)
    expect(s).toContain('标题')
    expect(s).toContain('要点一')
    expect(s).toContain('要点二')
    expect(s).toContain('引用内容')
    expect(s).not.toContain('#')
    expect(s).not.toContain('*')
    expect(s).not.toContain('- ')
    expect(s).not.toContain('>')
  })

  it('剔除 SVG 与图片', () => {
    const md = '图如下：\n\n<svg viewBox="0 0 10 10"><rect/></svg>\n\n![截图](a.png)\n\n结束。'
    const s = markdownToSpeech(md)
    expect(s).not.toContain('svg')
    expect(s).not.toContain('rect')
    expect(s).not.toContain('a.png')
    expect(s).toContain('图如下：')
    expect(s).toContain('结束。')
  })

  it('压缩多余空行', () => {
    const s = markdownToSpeech('第一段\n\n\n\n第二段')
    expect(s).toBe('第一段\n\n第二段')
  })

  it('空输入返回空串', () => {
    expect(markdownToSpeech('')).toBe('')
    expect(markdownToSpeech(null as any)).toBe('')
    expect(markdownToSpeech('```\nonly code\n```')).toBe('')
  })
})

describe('extractSpeakText', () => {
  it('字符串 content 直接清洗', () => {
    expect(extractSpeakText('你好 `code` 世界')).toBe('你好 code 世界')
  })

  it('数组 content 只取 text 块', () => {
    const content = [
      { type: 'text', text: '第一段。' },
      { type: 'image', url: 'x.png' },
      { type: 'text', text: '第二段。' },
    ]
    const s = extractSpeakText(content)
    expect(s).toContain('第一段。')
    expect(s).toContain('第二段。')
    expect(s).not.toContain('x.png')
  })

  it('空/异常输入安全', () => {
    expect(extractSpeakText(null)).toBe('')
    expect(extractSpeakText(undefined)).toBe('')
    expect(extractSpeakText([])).toBe('')
  })
})

/**
 * packForTts —— **一包 = 一次合成请求**，所以"包数"直接等于"要等几次合成"。
 *
 * 2026-09-28 老板问"为什么读完一段会暂停几秒"，根因就在包数：
 * 早先的实现按段落强制断开（一条 3 段的回复 = 3 次请求 = 段间各等一次合成，
 * 实测单次 2.2~3.5s、抖动时 7~15s）。
 *
 * 受控实测（直调 EdgeTTS、单次尝试）：40 字 1.2s / 200 字 1.6s / 500 字 1.8s / 1900 字 4.3s
 * ⇒ 合成耗时由握手主导、几乎不随长度变 ⇒ **没有任何理由按句切**，整条一次请求最优。
 */
describe('packForTts 打包（一包 = 一次合成请求）', () => {
  it('多段回复打成 1 包（段间不再各等一次合成）', () => {
    const text = '你好！有什么我可以帮你的？\n\n上次那份简报还没开工，需要的话我现在就接着做。\n\n或者你直接提需求，我来安排。'
    const packs = packForTts(text)
    expect(packs.length).toBe(1)
    expect(packs[0]).toContain('你好！有什么我可以帮你的？')
    expect(packs[0]).toContain('我来安排。')
  })

  it('段落不再是硬边界，但句末标点仍在（合并不等于粘连）', () => {
    const packs = packForTts('段落一。\n\n段落二。\n\n段落三。')
    expect(packs).toEqual(['段落一。段落二。段落三。'])
  })

  it('一行里没有任何句末标点时，也保证包尾有标点', () => {
    const packs = packForTts('标题\n\n这行没有标点')
    expect(packs.length).toBe(1)
    expect(packs[0].endsWith('。')).toBe(true)
  })

  it('超过上限才分包，且每包都不超上限', () => {
    const long = '这是一句普通的结论。'.repeat(300) // 3000 字
    const packs = packForTts(long, 1000)
    expect(packs.length).toBe(3)
    expect(packs.every((p) => p.length <= 1000)).toBe(true)
    expect(packs.every((p) => /[。！？!?…；;]$/.test(p))).toBe(true)
  })

  it('英文句子合并后不粘成一坨（保留句间空格）', () => {
    const packs = packForTts('Hello world. This is a test. Done.')
    expect(packs.length).toBe(1)
    expect(packs[0]).toContain('world. This')
  })

  it('无标点超长文本硬切且**一个字都不丢**（只在最末尾补了收尾句号）', () => {
    const long = 'A'.repeat(400)
    const packs = packForTts(long, 100)
    expect(packs.length).toBe(5) // 401 字（含补的句号）→ 100×4 + 1
    expect(packs.join('')).toBe(long + '。')
  })

  it('硬切优先落在软停顿后（不把句子从中间劈开）', () => {
    const text = '甲'.repeat(50) + '，' + '乙'.repeat(50)
    const packs = packForTts(text, 60)
    expect(packs.length).toBeGreaterThan(1)
    expect(packs[0].endsWith('，')).toBe(true)
  })

  it('空输入返回空数组', () => {
    expect(packForTts('')).toEqual([])
    expect(packForTts('   \n  ')).toEqual([])
  })

  it('默认上限足够放下一条正常回复（这才是"整条 1 次请求"的保障）', () => {
    expect(TTS_PACK_MAX_CHARS).toBeGreaterThanOrEqual(1500)
    expect(packForTts('这是一句普通的结论。'.repeat(60)).length).toBe(1) // 600 字
  })

  it('不丢内容：每个原句都完整出现在打包结果里', () => {
    const text = '第一句结论。第二句结论！第三句结论？'
    const joined = packForTts(text, 8).join('')
    for (const s of ['第一句结论。', '第二句结论！', '第三句结论？']) {
      expect(joined).toContain(s)
    }
  })
})

/**
 * 通顺性（2026-09-28）。
 *
 * ⚠️ 旧版本这里断言的是"段数别太多"，方向是错的 —— 真正的判据是 **包数 = 1**：
 * 每一包都是一次独立合成请求，包越多、包与包之间的等待越多。详见上面 packForTts 的实测表。
 */

/**
 * emoji / 装饰符号不朗读（2026-09-28 老板要求："里面的 emoji 就不要朗读了"）。
 *
 * 光删 `\p{Extended_Pictographic}` 是不够的：一个 emoji 是**多码点序列**，
 * 变体选择符 / 肤色修饰符 / 零宽连接符 / 区域指示符 会留下来，
 * 合成器要么念出它们的名字，要么在中间卡一下。
 */
describe('markdownToSpeech 不朗读 emoji 与装饰符号', () => {
  it('普通 emoji 直接消失', () => {
    expect(markdownToSpeech('完成 😀 了')).toBe('完成 了')
    expect(markdownToSpeech('部署成功 ✅')).toBe('部署成功')
  })

  it('带肤色修饰符的组合 emoji 整组消失（不留残渣）', () => {
    expect(markdownToSpeech('点赞 👍🏻')).toBe('点赞')
    expect(markdownToSpeech('举手 🙋🏽‍♀️ 示意')).toBe('举手 示意')
  })

  it('ZWJ 家庭 / 旗帜 / 数字键这类多码点序列也清干净', () => {
    expect(markdownToSpeech('一家人 👨‍👩‍👧‍👦 很好')).toBe('一家人 很好')
    expect(markdownToSpeech('旗帜 🇨🇳 在这里')).toBe('旗帜 在这里')
    const keycap = markdownToSpeech('数字键 1️⃣ 表示第一')
    expect(keycap).toBe('数字键 1 表示第一')
    expect(keycap).not.toContain('\u20e3')
    expect(keycap).not.toContain('\ufe0f')
  })

  it('纯 emoji 行整行消失（不留下空白段去制造怪异停顿）', () => {
    expect(markdownToSpeech('第一段。\n\n🎉🎉🎉\n\n第二段。')).toBe('第一段。\n\n第二段。')
  })

  it('装饰性符号（箭头/勾叉/圆圈）不朗读', () => {
    expect(markdownToSpeech('A → B 的关系')).toBe('A B 的关系')
    expect(markdownToSpeech('检查项 ✓ 已通过')).toBe('检查项 已通过')
    expect(markdownToSpeech('● 第一点')).toBe('第一点')
  })

  it('有用的符号必须保留（别把清洗范围开太大）', () => {
    expect(markdownToSpeech('气温 25°C，误差 ±2')).toBe('气温 25°C，误差 ±2')
    expect(markdownToSpeech('公式 a×b 加 a÷b')).toBe('公式 a×b 加 a÷b')
  })

  it('裸 URL 不朗读（markdown 链接之外的）', () => {
    const s = markdownToSpeech('见 https://example.com/a/b?c=1 的说明。')
    expect(s).not.toContain('https://')
    expect(s).not.toContain('example.com')
    expect(s).toContain('的说明。')
  })
})

/**
 * ensureSentenceEnd —— 只影响送给 TTS 的文本，不改用户看到的正文。
 * 段尾没有句末标点时合成器会用"话没说完"的语调收尾，听感一顿一顿。
 */
describe('ensureSentenceEnd', () => {
  it('已以句末标点结尾 → 原样返回', () => {
    expect(ensureSentenceEnd('第一句。')).toBe('第一句。')
    expect(ensureSentenceEnd('真的吗？')).toBe('真的吗？')
    expect(ensureSentenceEnd('甲；乙；')).toBe('甲；乙；')
    expect(ensureSentenceEnd('好吧…')).toBe('好吧…')
  })

  it('以软停顿结尾 → 换成句号（不产生"，。"这种叠标点）', () => {
    expect(ensureSentenceEnd('因此，')).toBe('因此。')
    expect(ensureSentenceEnd('包括：')).toBe('包括。')
    expect(ensureSentenceEnd('first,')).toBe('first。')
  })

  it('句中被硬切出来的 → 补句号', () => {
    expect(ensureSentenceEnd('这段被硬切了')).toBe('这段被硬切了。')
  })

  it('空白 → 空串（不产生孤零零的句号）', () => {
    expect(ensureSentenceEnd('')).toBe('')
    expect(ensureSentenceEnd('   ')).toBe('')
  })
})

/**
 * 通顺性（2026-09-28）。老板要求"朗读一定要通顺"。
 *
 * 判据不是"段数别太多"，而是 **包数 = 1**：每包一次独立合成请求，包间各等一次合成。
 * 打包与硬切的完整契约见上面的 `packForTts 打包` 一节，这里只钉最容易回归的一条——
 * **一条正常长度的多段回复，不许被打成多包**（这条曾因"按段落强制断开"而失守）。
 */
describe('通顺性回归：正常回复必须只打 1 包', () => {
  it('老板给的原例（3 段、含标题式短段）→ 1 包', () => {
    const text =
      '你好！😊 有什么我可以帮你的？\n\n' +
      '上次那份「AI Agent 2026 最新进展简报」还没开工（当时被余额报错打断了），需要的话我现在就接着做，每条结论都会附来源链接。\n\n' +
      '或者你直接提需求，我来安排。'
    expect(packForTts(markdownToSpeech(text)).length).toBe(1)
  })

  it('600 字回复仍只打 1 包（真机常见的报告长度）', () => {
    expect(packForTts('这是一句普通的结论。'.repeat(60)).length).toBe(1)
  })

  it('只有超过默认上限才分包，且硬切不丢字', () => {
    const text = 'A'.repeat(TTS_PACK_MAX_CHARS * 2 + 5)
    const packs = packForTts(text)
    expect(packs.length).toBe(3)
    expect(packs.join('')).toBe(text + '。') // 只多收尾句号，正文一字未丢
  })
})

/**
 * 流式攒批（2026-09-28「边生成边朗读」）。
 *
 * 核心不变量：**不丢字**（`chunk + rest` 严格逐字等于输入）。这条如果破了，
 * 症状是"念着念着少了一句"，而缺的那句永远不会再出现 —— 比静态分包难查得多，
 * 所以这里逐字比对而不是比长度（比长度对"整段错位"这类 bug 恒真）。
 */
describe('takeStreamChunk 流式攒批', () => {
  it('不够门槛 → 返回 null（继续攒）', () => {
    expect(takeStreamChunk('好的，我来安排。')).toBeNull()
    expect(takeStreamChunk('x'.repeat(STREAM_FIRST_MIN_CHARS - 1))).toBeNull()
    expect(takeStreamChunk('')).toBeNull()
  })

  it('攒够门槛且落在句末 → 切到最后一个句末标点之后', () => {
    const s = '这是第一句话。' + '这是第二句话。'.repeat(40) // 287 字
    const cut = takeStreamChunk(s)!
    expect(cut).not.toBeNull()
    expect(cut.chunk.endsWith('。')).toBe(true)
    expect(cut.chunk.length).toBeGreaterThanOrEqual(STREAM_FIRST_MIN_CHARS)
    expect(cut.chunk + cut.rest).toBe(s) // ← 逐字不丢
  })

  it('整段都是完整句子时必须切得出来（坑：末尾那段也可能是完整句）', () => {
    const s = '这是一句话。'.repeat(30) // 180 字，全是完整句
    const cut = takeStreamChunk(s, 100)!
    expect(cut).not.toBeNull()
    expect(cut.chunk.length).toBe(180)
    expect(cut.rest).toBe('')
  })

  it('有换行时优先切在行边界（markdown 是行级结构）', () => {
    const s = '第一段内容。'.repeat(40) + '\n' + '第二段内容。' // 240 + 换行 + 6
    const cut = takeStreamChunk(s)!
    expect(cut.chunk.endsWith('\n')).toBe(true)
    expect(cut.chunk + cut.rest).toBe(s)
  })

  it('超过单块上限必须切，且切点不越过上限', () => {
    const s = 'A'.repeat(STREAM_MAX_CHARS + 400)
    const cut = takeStreamChunk(s)!
    expect(cut.chunk.length).toBeLessThanOrEqual(STREAM_MAX_CHARS)
    expect(cut.chunk.length).toBeGreaterThanOrEqual(Math.floor(STREAM_MAX_CHARS * 0.6))
    expect(cut.chunk + cut.rest).toBe(s)
  })

  it('超上限时长句优先切在句末标点（而不是硬砍在字数上）', () => {
    const s = '这是一句完整的结论。'.repeat(80) // 每句 9 字，共 720 字
    const cut = takeStreamChunk(s)!
    expect(cut.chunk.endsWith('。')).toBe(true)
    expect(s.startsWith(cut.chunk)).toBe(true)
  })

  it('不切在未闭合的代码围栏里（否则代码会被念出来）', () => {
    const s = '前半句说明。' + '铺垫文本。'.repeat(60) + '```ts\nconst a = 1\n'
    expect(takeStreamChunk(s)).toBeNull()
    // 围栏闭合后立刻可切
    const closed = s + '```\n'
    const cut = takeStreamChunk(closed)!
    expect(cut).not.toBeNull()
    expect(cut.chunk + cut.rest).toBe(closed)
  })

  it('反复切分：逐块拼回来必须等于原文（不丢字、不重复）', () => {
    const s = '这是一句结论。'.repeat(120) + '\n' + '下一段说明。'.repeat(30)
    const chunks: string[] = []
    let rest = s
    for (;;) {
      const cut = takeStreamChunk(rest)
      if (!cut) break
      chunks.push(cut.chunk)
      rest = cut.rest
    }
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('') + rest).toBe(s) // ← 关键不变量
  })

  it('模拟逐 chunk 喂入：切出来的块只可能来自已到达的文本（不提前切）', () => {
    const full = '内容片段。'.repeat(50)
    let buf = ''
    let emitted = ''
    for (let i = 0; i < full.length; i += 7) {
      buf += full.slice(i, i + 7)
      for (;;) {
        const cut = takeStreamChunk(buf)
        if (!cut) break
        buf = cut.rest
        emitted += cut.chunk
        expect(full.startsWith(emitted)).toBe(true) // ← 已发内容必是原文前缀
      }
    }
    expect(full.startsWith(emitted + buf)).toBe(true)
  })
})
