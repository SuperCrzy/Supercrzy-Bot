/**
 * Role Router — 专家角色路由
 * 按用户消息匹配角色 task_keywords，分发到对应专家上下文
 * 未命中时回退到默认角色（is_default=1）
 */
import { getDB } from './database'

export interface RoleDef {
  id: string
  name: string
  task_keywords: string
  system_prompt: string
  enabled: number
  is_default: number
}

const roleCache: RoleDef[] | null = null

/** 读取所有启用角色（带简单缓存，避免每次查询 DB） */
let _roles: RoleDef[] | null = null
let _rolesLoadedAt = 0
const ROLE_CACHE_TTL = 30000 // 30s

export function getRoles(): RoleDef[] {
  const now = Date.now()
  if (_roles && now - _rolesLoadedAt < ROLE_CACHE_TTL) return _roles
  try {
    _roles = getDB().prepare(
      'SELECT * FROM roles WHERE enabled = 1 ORDER BY sort_order ASC'
    ).all() as RoleDef[]
    _rolesLoadedAt = now
  } catch {
    _roles = []
  }
  return _roles
}

/** 强制刷新角色缓存（角色被修改后调用） */
export function invalidateRolesCache(): void {
  _roles = null
  _rolesLoadedAt = 0
}

/**
 * 按用户消息匹配角色
 * 关键词命中优先级：关键词越长（更具体）优先
 */
export function matchRole(userMessage: string): { role: RoleDef | null; matchedKeyword: string | null } {
  const roles = getRoles()
  if (roles.length === 0) return { role: null, matchedKeyword: null }

  const q = (userMessage || '').toLowerCase()
  let best: RoleDef | null = null
  let bestKeyword = ''
  let bestLen = 0

  for (const role of roles) {
    if (role.is_default) continue // 默认角色兜底，不参与匹配
    if (!role.task_keywords) continue
    const keywords = role.task_keywords.split(',').map((k: string) => k.trim().toLowerCase()).filter(Boolean)
    for (const kw of keywords) {
      // 关键词较长 = 更具体，优先级更高
      if (kw.length >= bestLen && q.includes(kw)) {
        best = role
        bestKeyword = kw
        bestLen = kw.length
      }
    }
  }

  return { role: best, matchedKeyword: best ? bestKeyword : null }
}

/** 获取默认角色（兜底），无则返回 null */
export function getDefaultRole(): RoleDef | null {
  const roles = getRoles()
  return roles.find(r => r.is_default === 1) || null
}

/** 根据角色 ID 获取角色 */
export function getRoleById(id: string): RoleDef | null {
  const roles = getRoles()
  return roles.find(r => r.id === id) || null
}

/** 根据角色 ID 获取系统提示（无则返回空字符串，调用方回退全局默认） */
export function getRolePrompt(id: string): string {
  const role = getRoleById(id)
  return role?.system_prompt || ''
}
