/**
 * memory_store — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'
import { SENSITIVE_MEMORY_PATTERN, storeMemory } from './shared'

const tool: ToolDef = {
  name: 'memory_store',
  description: '存储一条长期记忆。当你学到关于用户的重要信息时使用。',
  category: 'memory',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '记忆标识，如"用户名"、"偏好语言"' },
      content: { type: 'string', description: '记忆内容' },
      category: {
        type: 'string',
        enum: ['general', 'preference', 'fact', 'rule'],
        description: '记忆分类',
      },
      importance: { type: 'number', description: '重要性 1-5', minimum: 1, maximum: 5 },
    },
    required: ['key', 'content'],
  },
  async execute(args) {
    const db = getDB()
    const key = String(args.key || '').trim()
    const content = String(args.content || '').trim()
    if (!key || !content) return '❌ 记忆存储失败：key 和 content 不能为空'

    // 记忆开关关闭 → 拒绝存取（与 buildSystemPrompt 的"记忆未启用"一致）
    const memRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
    if (memRow && memRow.value !== 'true') {
      return '⛔ 记忆功能已关闭（设置 → 记忆 → 记忆开关）。如需使用请先开启。'
    }

    // ① 凭据类关键词拦截/脱敏：默认拦截明文密钥/密码入库；
    //    开启"脱敏 PII"设置（piiMaskingEnabled）时改为自动替换为 [REDACTED] 后入库
    if (SENSITIVE_MEMORY_PATTERN.test(content)) {
      const piiRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('piiMaskingEnabled') as any
      const piiMasking = piiRow ? piiRow.value === 'true' : false
      if (piiMasking) {
        const maskedContent = content.replace(SENSITIVE_MEMORY_PATTERN, '[REDACTED]')
        const maskedKey = key.replace(SENSITIVE_MEMORY_PATTERN, '[REDACTED]')
        return storeMemory(db, maskedKey, maskedContent, args.category, args.importance)
      }
      return '❌ 已拦截：内容疑似包含敏感凭据（API Key / Secret / 密码 / 私钥），禁止明文存储。请改用占位符（如 {{API_KEY}}）或脱敏描述。'
    }

    // ② 同 key 同内容自动去重：已存在则跳过（可更新重要性取最大值）
    return storeMemory(db, key, content, args.category, args.importance)
  },
}

export default tool
