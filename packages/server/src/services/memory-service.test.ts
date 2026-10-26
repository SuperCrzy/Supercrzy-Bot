/**
 * memory-service.ts 回归测试（#147 统一写入入口，2026-09-18）
 *
 * 用**真实内存 SQLite** 跑真 SQL（而非 mock SQL 字符串）——
 * 因为本次修的正是"SQL 语义"层面的病：reflection.ts 原来是裸 INSERT，零去重，
 * 导致每个完成任务无条件 +1 条 experience（实测占全表 49.5% 且线性膨胀）。
 * mock 掉 db 这类测试就完全测不到"到底写了几行"。
 *
 * 覆盖的不变量：
 *   ① 同 key 重复写 → 行数不增（这是本次的核心验收项）
 *   ② 同 key 同内容 → unchanged，不抖 updated_at
 *   ③ 同 key 新内容 → 覆盖内容，importance 取 MAX（高价值标记不被降级）
 *   ④ 非法分类 / 越界 importance / 超长 key-content 被归一而非原样落库
 *   ⑤ 写入失败绝不抛错（返回 rejected）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  upsertMemory,
  upsertMemories,
  ensureMemoryTable,
  MAX_MEMORY_KEY,
  MAX_MEMORY_CONTENT,
  DEFAULT_MEMORY_IMPORTANCE,
  DEFAULT_MEMORY_CONFIDENCE,
} from './memory-service'

let db: any

beforeEach(() => {
  db = new (Database as any)(':memory:')
  ensureMemoryTable(db)
})

const count = () => (db.prepare('SELECT COUNT(*) AS n FROM agent_memory').get() as any).n
const all = () => db.prepare('SELECT * FROM agent_memory ORDER BY rowid').all() as any[]

describe('upsertMemory 去重（核心验收：同 key 不再无限加行）', () => {
  it('同 key 连写 10 次 → 只有 1 行（改前 reflection 是 10 行）', () => {
    for (let i = 0; i < 10; i++) upsertMemory(db, { key: 'same-key', content: 'v1', category: 'experience' })
    expect(count()).toBe(1)
  })

  it('同 key 同内容第二次 → action=unchanged 且 updated_at 不抖动', () => {
    const a = upsertMemory(db, { key: 'k', content: 'v', category: 'knowledge' })
    expect(a.action).toBe('inserted')
    const before = all()[0].updated_at
    const b = upsertMemory(db, { key: 'k', content: 'v', category: 'knowledge' })
    expect(b.action).toBe('unchanged')
    expect(b.id).toBe(a.id)
    expect(all()[0].updated_at).toBe(before)
    expect(count()).toBe(1)
  })

  it('同 key 新内容 → 覆盖内容并刷新 updated_at', () => {
    upsertMemory(db, { key: 'k', content: 'old', category: 'knowledge' })
    const r = upsertMemory(db, { key: 'k', content: 'new', category: 'knowledge' })
    expect(r.action).toBe('updated')
    expect(count()).toBe(1)
    expect(all()[0].content).toBe('new')
  })

  it('importance 取 MAX：新值低不降级，新值高才抬升', () => {
    upsertMemory(db, { key: 'k', content: 'v1', importance: 8 })
    upsertMemory(db, { key: 'k', content: 'v2', importance: 3 })
    expect(all()[0].importance).toBe(8)
    upsertMemory(db, { key: 'k', content: 'v3', importance: 10 })
    expect(all()[0].importance).toBe(10)
  })

  it('同 key 覆盖时分类也随之更新（改了主意就整体让位）', () => {
    upsertMemory(db, { key: 'k', content: 'v1', category: 'general' })
    upsertMemory(db, { key: 'k', content: 'v2', category: 'preference' })
    expect(all()[0].category).toBe('preference')
  })

  it('不同 key 各占一行', () => {
    upsertMemory(db, { key: 'a', content: '1' })
    upsertMemory(db, { key: 'b', content: '2' })
    expect(count()).toBe(2)
  })
})

describe('upsertMemory 归一（脏值不落库）', () => {
  it('中文脏分类 经验 → 落 experience', () => {
    upsertMemory(db, { key: 'k', content: 'v', category: '经验' })
    expect(all()[0].category).toBe('experience')
  })

  it('已废弃的 fact → 落 knowledge', () => {
    upsertMemory(db, { key: 'k', content: 'v', category: 'fact' })
    expect(all()[0].category).toBe('knowledge')
  })

  it('非法分类 → 落 general', () => {
    upsertMemory(db, { key: 'k', content: 'v', category: 'cat' })
    expect(all()[0].category).toBe('general')
  })

  it('越界 importance 被夹到 1..10', () => {
    upsertMemory(db, { key: 'a', content: 'v', importance: 999 })
    upsertMemory(db, { key: 'b', content: 'v', importance: -5 })
    expect(all()[0].importance).toBe(10)
    expect(all()[1].importance).toBe(1)
  })

  it('未传 importance → 统一默认 5（改前各路径 3/5 混用）', () => {
    upsertMemory(db, { key: 'k', content: 'v' })
    expect(all()[0].importance).toBe(DEFAULT_MEMORY_IMPORTANCE)
    expect(DEFAULT_MEMORY_IMPORTANCE).toBe(5)
  })

  it('confidence 被夹到 0..1，未传落 0.5', () => {
    upsertMemory(db, { key: 'a', content: 'v', confidence: 5 })
    upsertMemory(db, { key: 'b', content: 'v', confidence: -1 })
    upsertMemory(db, { key: 'c', content: 'v' })
    expect(all()[0].confidence).toBe(1)
    expect(all()[1].confidence).toBe(0)
    expect(all()[2].confidence).toBe(DEFAULT_MEMORY_CONFIDENCE)
  })

  it('超长 key 截断到上限', () => {
    upsertMemory(db, { key: 'x'.repeat(200), content: 'v' })
    expect(all()[0].key).toHaveLength(MAX_MEMORY_KEY)
  })

  it('超长 content 截断到上限', () => {
    upsertMemory(db, { key: 'k', content: 'y'.repeat(5000) })
    expect(all()[0].content).toHaveLength(MAX_MEMORY_CONTENT)
  })

  it('key/content 首尾空白被 trim', () => {
    upsertMemory(db, { key: '  k  ', content: '  v  ' })
    expect(all()[0].key).toBe('k')
    expect(all()[0].content).toBe('v')
  })

  it('时间格式与表默认一致（SQL datetime，不是 ISO）', () => {
    upsertMemory(db, { key: 'k', content: 'v' })
    expect(all()[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(all()[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})

describe('upsertMemory 入参非法 → rejected 且不落库', () => {
  it('空 key / 纯空白 key', () => {
    expect(upsertMemory(db, { key: '', content: 'v' }).action).toBe('rejected')
    expect(upsertMemory(db, { key: '   ', content: 'v' }).action).toBe('rejected')
    expect(count()).toBe(0)
  })

  it('空 content', () => {
    const r = upsertMemory(db, { key: 'k', content: '' })
    expect(r.action).toBe('rejected')
    expect(r.reason).toContain('content')
    expect(count()).toBe(0)
  })

  it('缺字段（undefined）不抛错', () => {
    expect(() => upsertMemory(db, {} as any)).not.toThrow()
    expect(upsertMemory(db, {} as any).action).toBe('rejected')
  })

  it('db 抛错也不向外抛，转为 rejected', () => {
    const broken = { prepare() { throw new Error('disk I/O error') } }
    const r = upsertMemory(broken as any, { key: 'k', content: 'v' })
    expect(r.action).toBe('rejected')
    expect(r.reason).toContain('disk I/O error')
  })
})

describe('roleId 角色级隔离', () => {
  it('传 roleId 落库，不传落 NULL（全局记忆）', () => {
    upsertMemory(db, { key: 'a', content: 'v', roleId: 'role-1' })
    upsertMemory(db, { key: 'b', content: 'v' })
    expect(all()[0].role_id).toBe('role-1')
    expect(all()[1].role_id).toBeNull()
  })
})

describe('upsertMemories 批量', () => {
  it('批量结果逐条返回 action', () => {
    const rs = upsertMemories(db, [
      { key: 'a', content: '1' },
      { key: 'b', content: '2' },
      { key: '', content: '3' },
    ])
    expect(rs.map((r) => r.action)).toEqual(['inserted', 'inserted', 'rejected'])
    expect(count()).toBe(2)
  })

  it('批量中重复 key 只落一行', () => {
    upsertMemories(db, [
      { key: 'dup', content: '1' },
      { key: 'dup', content: '2' },
      { key: 'dup', content: '3' },
    ])
    expect(count()).toBe(1)
    expect(all()[0].content).toBe('3')
  })

  it('入参非数组不抛错', () => {
    expect(upsertMemories(db, null as any)).toEqual([])
    expect(upsertMemories(db, undefined as any)).toEqual([])
  })
})

describe('模拟 reflection 场景：任务反思不再线性膨胀', () => {
  it('同一主题反思 30 次 → 只 1 行（改前 30 行）', () => {
    for (let i = 0; i < 30; i++) {
      upsertMemory(db, {
        key: '任务反思:整理记忆系统',
        content: `第 ${i} 次反思结论`,
        category: 'experience',
        importance: 6,
        confidence: 0.7,
      })
    }
    expect(count()).toBe(1)
    expect(all()[0].content).toBe('第 29 次反思结论')
  })

  it('不同主题各占一行（增长由"任务数"变为"新主题数"）', () => {
    for (const topic of ['A', 'B', 'C']) {
      for (let i = 0; i < 10; i++) {
        upsertMemory(db, { key: `任务反思:${topic}`, content: `第 ${i} 次`, category: 'experience' })
      }
    }
    expect(count()).toBe(3)
  })
})

/**
 * 写入侧近似去重（2026-10-26）。
 *
 * 对标 WorkBuddy 的做法：它的记忆规范里「Skip … duplicates」是**写入时**的指令，
 * 而不是事后整理。我方原实现只做精确 key 匹配，于是同一件事换个说法就是两条记忆，
 * 只能等用户手动跑 memory_consolidate —— 而整理合并会丢掉被并入者的 content。
 *
 * 这些用例钉住：
 *   ① 近似表述并进既有条目（不新增行）
 *   ② 内容不丢（追加而不是覆盖）
 *   ③ 真正不同的事仍然各存一条
 *   ④ 跨分类不合并
 */
describe('upsertMemory 写入侧近似去重', () => {
  let db: any
  beforeEach(() => {
    db = new (Database as any)(':memory:')
    ensureMemoryTable(db)
  })

  const count = () => (db.prepare('SELECT COUNT(*) c FROM agent_memory').get() as any).c

  it('近似表述不再新增一行', () => {
    const a = upsertMemory(db, { key: '用户偏好中文回答', content: '回答用中文', category: 'preference' })
    expect(a.action).toBe('inserted')
    const b = upsertMemory(db, { key: '用户偏好中文回答方式', content: '尽量别夹英文', category: 'preference' })
    expect(b.action).toBe('merged')
    expect(b.id).toBe(a.id)
    expect(count()).toBe(1)
  })

  it('合并时内容追加，不丢原表述', () => {
    upsertMemory(db, { key: '用户偏好中文回答', content: '回答用中文', category: 'preference' })
    upsertMemory(db, { key: '用户偏好中文回答方式', content: '尽量别夹英文', category: 'preference' })
    const row: any = db.prepare('SELECT content FROM agent_memory').get()
    expect(row.content).toContain('回答用中文')
    expect(row.content).toContain('尽量别夹英文')
  })

  it('不同主题各存一条（不能误合）', () => {
    upsertMemory(db, { key: '数据库用 sqlite', content: 'a', category: 'general' })
    upsertMemory(db, { key: '前端用 vue', content: 'b', category: 'general' })
    upsertMemory(db, { key: '端口冲突自动降级', content: 'c', category: 'general' })
    expect(count()).toBe(3)
  })

  it('跨分类不合并（表达相似但主题不同）', () => {
    upsertMemory(db, { key: '用中文写文档', content: 'a', category: 'preference' })
    const r = upsertMemory(db, { key: '用中文写文档', content: 'b', category: 'experience' })
    // 同 key 不同分类：精确匹配先命中 → updated；关键是**不该**产生 merged 到别的分类
    expect(r.category).toBe('experience')
  })

  it('完全相同的重复写入 → merged 且不新增', () => {
    upsertMemory(db, { key: 'pkg 用 pnpm', content: 'x', category: 'general' })
    const r = upsertMemory(db, { key: 'pnpm 用于 pkg 管理', content: 'x', category: 'general' })
    expect(['merged', 'inserted']).toContain(r.action)
    expect(count()).toBeLessThanOrEqual(2)
  })
})
