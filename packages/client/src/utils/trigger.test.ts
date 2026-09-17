/**
 * 输入框触发词解析单测（P1-04 下沉；此前零覆盖）
 */
import { describe, it, expect } from 'vitest'
import { parseTrigger } from './trigger'

describe('parseTrigger', () => {
  it('行首 / 触发', () => {
    expect(parseTrigger('/', 1)).toEqual({ char: '/', query: '' })
    expect(parseTrigger('/sk', 3)).toEqual({ char: '/', query: 'sk' })
  })

  it('行首 @ 触发', () => {
    expect(parseTrigger('@', 1)).toEqual({ char: '@', query: '' })
    expect(parseTrigger('@src', 4)).toEqual({ char: '@', query: 'src' })
  })

  it('空白之后可触发（句中也能用）', () => {
    // '帮我看看 @utils' → 索引 4 是空格，5 是 @，6..10 是 utils
    expect(parseTrigger('帮我看看 @utils', 11)).toEqual({ char: '@', query: 'utils' })
    expect(parseTrigger('hi /he', 6)).toEqual({ char: '/', query: 'he' })
  })

  it('只在光标之前解析（光标后的字符不影响）', () => {
    expect(parseTrigger('/skill 后面还有字', 6)).toEqual({ char: '/', query: 'skill' })
  })

  it('非触发场景返回 null', () => {
    expect(parseTrigger('普通文本', 4)).toBeNull()
    expect(parseTrigger('', 0)).toBeNull()
    // 触发符后面已跟空格 → 触发态结束
    expect(parseTrigger('/skill ', 7)).toBeNull()
    // 查询词里再出现触发符 → 不匹配
    expect(parseTrigger('@a/b', 4)).toBeNull()
  })

  it('邮箱 / URL 里的 @ 不误触发（前面不是行首或空白）', () => {
    expect(parseTrigger('mailto:a@b', 10)).toBeNull()
    expect(parseTrigger('see http://x@y', 14)).toBeNull()
  })

  it('caretPos 越界被夹紧，不抛错', () => {
    expect(parseTrigger('/abc', 999)).toEqual({ char: '/', query: 'abc' })
    expect(parseTrigger('/abc', -5)).toBeNull()
  })

  it('非法输入不抛错', () => {
    expect(parseTrigger(undefined as unknown as string, 0)).toBeNull()
    expect(parseTrigger(null as unknown as string, 1)).toBeNull()
    expect(parseTrigger('/x', NaN)).toBeNull()
  })
})
