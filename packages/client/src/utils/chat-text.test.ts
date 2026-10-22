import { describe, it, expect } from 'vitest'
import { resolveRealTime, actorMeta, ACTOR_META, createChatText } from './chat-text'

const mk = (isZh = true, msgs: any[] = []) => createChatText({
  isZh: () => isZh,
  visibleMessages: () => msgs,
  t: (k: string) => `__${k}__`,
})

describe('resolveRealTime', () => {
  it('SQLite 的无时区 UTC 字符串按 UTC 解析（补 Z），不能落到本地时区', () => {
    // 这是真出过的 bug：不补 Z 会整体差 8 小时，长会话的日期分隔线会错一天
    const d = resolveRealTime('2026-05-07 06:44:42')!
    expect(d.toISOString()).toBe('2026-05-07T06:44:42.000Z')
  })

  it('已带时区标记的字符串不被二次加工', () => {
    expect(resolveRealTime('2026-05-07T06:44:42Z')!.toISOString()).toBe('2026-05-07T06:44:42.000Z')
  })

  it('id 内嵌 13 位时间戳：比 dateStr 小才采信（取小值防污染）', () => {
    const idTs = 1746590682000 // 2025-05-07
    const d = resolveRealTime('2026-05-07 06:44:42', `msg_${idTs}`)!
    expect(d.getTime()).toBe(idTs)
  })

  it('id 内嵌时间戳比 dateStr 大 → 不采信（避免用未来时间污染排序）', () => {
    const future = Date.now() + 86400000
    const d = resolveRealTime('2026-05-07 06:44:42', `msg_${future}`)!
    expect(d.toISOString()).toBe('2026-05-07T06:44:42.000Z')
  })

  it('两边都取不到 → null（不是 Invalid Date）', () => {
    expect(resolveRealTime('')).toBeNull()
    expect(resolveRealTime('not-a-date')).toBeNull()
    expect(resolveRealTime('', 'no-timestamp-here')).toBeNull()
  })
})

describe('actorMeta', () => {
  it('已知发言人命中固定外观', () => {
    expect(actorMeta('执行AI')).toEqual(ACTOR_META['执行AI'])
  })

  it('未知发言人兜底：名字原样 + 首字当图标（不能渲染成空白）', () => {
    const m = actorMeta('外部AI')!
    expect(m.label).toBe('外部AI')
    expect(m.icon).toBe('外')
  })

  it('无 actor → null（单 AI 场景走默认渲染路径）', () => {
    expect(actorMeta()).toBeNull()
    expect(actorMeta('')).toBeNull()
  })
})

describe('createChatText', () => {
  it('messageRoleLabel：user 取 i18n，actor 取元数据 label，无 actor 取助手 i18n', () => {
    const c = mk()
    expect(c.messageRoleLabel({ role: 'user' })).toBe('__chat.roleUser__')
    expect(c.messageRoleLabel({ role: 'assistant', actor: '质检AI' })).toBe('质检 AI')
    expect(c.messageRoleLabel({ role: 'assistant' })).toBe('__chat.roleAssistant__')
  })

  it('formatCurrency 不跟随语言：落库是人民币，换符号等于把金额除以汇率', () => {
    // 2026-10-22 修：以前 en 界面把 ¥12.50 显示成 $12.50（数值不变、符号变），
    // 等于把人民币当美元报，少算 7.2 倍。现在只认存储口径。
    expect(mk(true).formatCurrency(12.5)).toBe('¥12.50')
    expect(mk(false).formatCurrency(12.5)).toBe('¥12.50')
  })

  it('msgDayKey 按**本地日期**分组（resolveRealTime 按 UTC 解析，跨日判定必须回到本地日）', () => {
    // 测试环境时区不定，所以期望值也用同一个 Date 的本地字段算出来，不写死字符串
    const localKey = (iso: string) => {
      const d = new Date(iso)
      return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    }
    const c = mk()
    expect(c.msgDayKey({ timestamp: '2026-05-07 06:44:42' })).toBe(localKey('2026-05-07T06:44:42Z'))
    // 同一天内相隔一秒 → 必须落同一组，否则长会话里每条消息都会插一条日期分隔线
    expect(c.msgDayKey({ timestamp: '2026-05-07 06:44:42' }))
      .toBe(c.msgDayKey({ timestamp: '2026-05-07 06:44:43' }))
    expect(c.msgDayKey({})).toBe('the-same-day')
    expect(c.msgDayKey({})).toBe(c.msgDayKey({})) // 两条无效时间必须同组
  })

  it('showDayDivider：首条不画、同天不画、跨天画、越界不画', () => {
    const msgs = [
      { id: 'a', timestamp: '2026-05-07 06:00:00' },
      { id: 'b', timestamp: '2026-05-07 07:00:00' },
      { id: 'c', timestamp: '2026-05-08 07:00:00' },
    ]
    const c = mk(true, msgs)
    expect(c.showDayDivider(0)).toBe(false)
    expect(c.showDayDivider(1)).toBe(false)
    expect(c.showDayDivider(2)).toBe(true)
    expect(c.showDayDivider(3)).toBe(false) // 越界不能抛
  })

  it('dayLabel：今天 / 昨天 / 更早；取不到时间 → 空串', () => {
    const now = new Date()
    const iso = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19)
    const today = new Date(now)
    const yest = new Date(now.getTime() - 86400000)
    const c = mk(true, [
      { id: 't', timestamp: iso(today) },
      { id: 'y', timestamp: iso(yest) },
      { id: 'n', timestamp: '' },
    ])
    expect(c.dayLabel(0)).toBe('今天')
    expect(c.dayLabel(1)).toBe('昨天')
    expect(c.dayLabel(2)).toBe('')
  })

  it('formatTime：取不到时间 → 空串（不渲染 undefined）', () => {
    const c = mk()
    expect(c.formatTime('')).toBe('')
    expect(c.formatTime('garbage')).toBe('')
  })

  it('依赖是 getter：语言切换后无需重建实例即可生效', () => {
    // 用 formatTime 做载体：它真的按语言换格式（货币已改成不跟随语言）
    let zh = false
    const c = createChatText({ isZh: () => zh, visibleMessages: () => [], t: (k) => k })
    const yesterday = new Date(Date.now() - 86400000).toISOString()
    expect(c.formatTime(yesterday)).toMatch(/^Yesterday /)
    zh = true
    expect(c.formatTime(yesterday)).toMatch(/^昨天 /)
  })
})
