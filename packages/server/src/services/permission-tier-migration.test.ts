/**
 * 权限档位「三档 → 两档」的存量迁移（2026-10-22）
 *
 * 为什么单独测：迁移写在 `initDatabase()` 里就只能靠真库验证，而"SQL 跑在错误的表/列上"
 * 这类错误在真库上看不出差异（值本来就不是 auto 时，坏 SQL 与好 SQL 结果一样）。
 * 这里用内存库精确制造 `permissionTier='auto'`，跑完再看它是否真的落到 `ask`。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// config 在模块加载时读 env —— 必须先设
process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'supercrzy-tier-ws-'))
process.env.DB_PATH = join(tmpdir(), `supercrzy-tier-${Date.now()}.db`)

// 只需要构造函数签名（避免 better-sqlite3 的 namespace/default 互操作类型体操）
let Database: new (path: string) => any
let retireAutoPermissionTier: typeof import('./database').retireAutoPermissionTier

beforeAll(async () => {
  Database = (await import('better-sqlite3') as any).default
  retireAutoPermissionTier = (await import('./database')).retireAutoPermissionTier
})

function freshDb() {
  const mem = new Database(':memory:')
  mem.exec(`CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  return mem
}

function setValue(mem: any, key: string, value: string) {
  mem.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}
function getValue(mem: any, key: string): string | undefined {
  return (mem.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value
}

describe('retireAutoPermissionTier', () => {
  it('🔴 permissionTier=auto 会被改写成 ask，并返回改写行数', () => {
    const mem = freshDb()
    setValue(mem, 'permissionTier', 'auto')
    expect(retireAutoPermissionTier(mem)).toBe(1)
    expect(getValue(mem, 'permissionTier')).toBe('ask')
    mem.close()
  })

  it('readonly / ask 原样不动', () => {
    const mem = freshDb()
    setValue(mem, 'permissionTier', 'readonly')
    expect(retireAutoPermissionTier(mem)).toBe(0)
    expect(getValue(mem, 'permissionTier')).toBe('readonly')

    setValue(mem, 'permissionTier', 'ask')
    expect(retireAutoPermissionTier(mem)).toBe(0)
    expect(getValue(mem, 'permissionTier')).toBe('ask')
    mem.close()
  })

  it('历史内部键 toolApprovalMode 故意不动（旧包回滚要对得上）', () => {
    const mem = freshDb()
    setValue(mem, 'toolApprovalMode', 'auto')
    expect(retireAutoPermissionTier(mem)).toBe(0)
    expect(getValue(mem, 'toolApprovalMode')).toBe('auto')
    mem.close()
  })

  it('幂等：连跑两次第二次改 0 行', () => {
    const mem = freshDb()
    setValue(mem, 'permissionTier', 'auto')
    expect(retireAutoPermissionTier(mem)).toBe(1)
    expect(retireAutoPermissionTier(mem)).toBe(0)
    mem.close()
  })

  it('settings 表不存在时不抛异常（返回 0）', () => {
    const mem = new Database(':memory:')
    expect(() => retireAutoPermissionTier(mem)).not.toThrow()
    expect(retireAutoPermissionTier(mem)).toBe(0)
    mem.close()
  })
})
