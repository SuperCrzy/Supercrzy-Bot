import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  DEFAULT_REASONING_MODE,
  REASONING_MODE_KEY,
  normalizeReasoningMode,
  readReasoningMode,
  writeReasoningMode,
  defaultLiveOpen,
  defaultCompletedOpen,
  nextReasoningMode,
  setReasoningStorage,
  useReasoningDisplay,
} from './reasoning-display'

/** 内存 Storage 替身（不污染 jsdom 全局） */
function memStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init))
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    _dump: () => Object.fromEntries(map),
  }
}

describe('reasoning-display 思考过程展示策略（阶段三-⑤）', () => {
  it('默认档位是 folded（首屏只呈现结论 + 关键动作）', () => {
    expect(DEFAULT_REASONING_MODE).toBe('folded')
  })

  it('localStorage key 遵守 supercrzy: 前缀约定', () => {
    expect(REASONING_MODE_KEY.startsWith('supercrzy:')).toBe(true)
  })

  describe('normalizeReasoningMode 容错', () => {
    it('合法值原样返回', () => {
      expect(normalizeReasoningMode('folded')).toBe('folded')
      expect(normalizeReasoningMode('expanded')).toBe('expanded')
    })

    it('非法值/空值/旧数据一律回落默认（不抛错、不产生第三态）', () => {
      for (const bad of [null, undefined, '', 'EXPANDED', 'true', 0, 1, {}, []]) {
        expect(normalizeReasoningMode(bad)).toBe(DEFAULT_REASONING_MODE)
      }
    })
  })

  describe('读写偏好', () => {
    it('空 storage → 默认 folded', () => {
      expect(readReasoningMode(memStorage())).toBe('folded')
    })

    it('写入后读回一致', () => {
      const s = memStorage()
      writeReasoningMode('expanded', s)
      expect(readReasoningMode(s)).toBe('expanded')
      writeReasoningMode('folded', s)
      expect(readReasoningMode(s)).toBe('folded')
    })

    it('storage 已存非法值 → 读回默认（不把脏值带进渲染）', () => {
      expect(readReasoningMode(memStorage({ [REASONING_MODE_KEY]: 'garbage' }))).toBe('folded')
    })

    it('写入非法值会被归一后再落盘（脏值进不了 storage）', () => {
      const s = memStorage()
      writeReasoningMode('nonsense' as never, s)
      expect(s.getItem(REASONING_MODE_KEY)).toBe('folded')
    })

    it('storage 抛异常（隐私模式/配额满）→ 读走默认、写不抛', () => {
      const boom = {
        getItem() { throw new Error('blocked') },
        setItem() { throw new Error('quota') },
      }
      expect(readReasoningMode(boom)).toBe('folded')
      expect(() => writeReasoningMode('expanded', boom)).not.toThrow()
    })
  })

  describe('默认展开策略', () => {
    it('folded 档：流式思考默认不展开', () => {
      expect(defaultLiveOpen('folded')).toBe(false)
    })

    it('expanded 档：流式思考默认展开（保留 2026-08-21 老板决定的可见性）', () => {
      expect(defaultLiveOpen('expanded')).toBe(true)
    })

    it('完成态恒折叠——与档位无关（首屏不因历史推理变长）', () => {
      expect(defaultCompletedOpen()).toBe(false)
      // 无论偏好怎么设，完成态都不展开
      expect(defaultLiveOpen('expanded') && defaultCompletedOpen()).toBe(false)
    })

    it('defaultLiveOpen 只依赖档位：同输入同输出（纯函数，无隐式状态）', () => {
      expect(defaultLiveOpen('expanded')).toBe(defaultLiveOpen('expanded'))
      expect(defaultLiveOpen('folded')).toBe(defaultLiveOpen('folded'))
      expect(defaultLiveOpen('folded')).not.toBe(defaultLiveOpen('expanded'))
    })
  })

  describe('循环切换', () => {
    it('nextReasoningMode 在两档间往返', () => {
      expect(nextReasoningMode('folded')).toBe('expanded')
      expect(nextReasoningMode('expanded')).toBe('folded')
      expect(nextReasoningMode('folded' as never)).toBe('expanded')
    })

    it('非法输入按默认档折算，不产生第三态', () => {
      expect(nextReasoningMode('' as never)).toBe('expanded') // 默认 folded → next = expanded
      expect(nextReasoningMode(null as never)).toBe('expanded')
    })
  })

  describe('单例偏好（设置页写入 → 面板即时生效）', () => {
    let store: ReturnType<typeof memStorage>
    beforeEach(() => {
      // 客户端单测运行在 node 环境（无 localStorage）→ 注入内存存储替身
      store = memStorage()
      setReasoningStorage(() => store)
      useReasoningDisplay().setLiveExpanded(false)
    })
    afterEach(() => setReasoningStorage(undefined))

    it('默认 false（折叠）', () => {
      expect(useReasoningDisplay().liveExpanded.value).toBe(false)
    })

    it('setLiveExpanded 同时更新响应式 ref 与持久化', () => {
      const { liveExpanded, setLiveExpanded } = useReasoningDisplay()
      setLiveExpanded(true)
      expect(liveExpanded.value).toBe(true)
      expect(readReasoningMode()).toBe('expanded')
      expect(store.getItem(REASONING_MODE_KEY)).toBe('expanded')
      setLiveExpanded(false)
      expect(liveExpanded.value).toBe(false)
      expect(readReasoningMode()).toBe('folded')
      expect(store.getItem(REASONING_MODE_KEY)).toBe('folded')
    })

    it('多个调用方共享同一份状态（不是每处一份副本）', () => {
      const a = useReasoningDisplay()
      const b = useReasoningDisplay()
      a.setLiveExpanded(true)
      expect(b.liveExpanded.value).toBe(true)
      expect(b.liveExpanded).toBe(a.liveExpanded)
    })
  })

  describe('存储注入缝', () => {
    afterEach(() => setReasoningStorage(undefined))

    it('未注入时为默认探测（node 下无 localStorage → 读回默认、写入不抛）', () => {
      setReasoningStorage(undefined)
      expect(readReasoningMode()).toBe(DEFAULT_REASONING_MODE)
      expect(() => writeReasoningMode('expanded')).not.toThrow()
    })

    it('注入后 read/write 都走注入实现', () => {
      const store = memStorage()
      setReasoningStorage(() => store)
      writeReasoningMode('expanded')
      expect(store.getItem(REASONING_MODE_KEY)).toBe('expanded')
      expect(readReasoningMode()).toBe('expanded')
    })
  })
})
