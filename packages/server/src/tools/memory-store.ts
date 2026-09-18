/**
 * memory_store — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'
import { SENSITIVE_MEMORY_PATTERN, storeMemory } from './shared'
import { MEMORY_CATEGORIES } from '../services/memory-category'

const tool: ToolDef = {
  name: 'memory_store',
  description: '存储一条长期记忆。当你学到关于用户的重要信息时使用。',
  category: 'memory',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '记忆标识，如"用户名"、"偏好语言"。同一 key 会覆盖旧值，请用稳定的 key' },
      content: { type: 'string', description: '记忆内容' },
      category: {
        // 2026-09-18（#147）：原 enum 是 ['general','preference','fact','rule'] —— 这是第 6 套词表：
        // 含已废弃的 `fact`，又缺 experience/topic/user/knowledge，模型照它填的值全被判成脏值。
        // 现直接引用权威枚举，从此不可能再漂移。
        type: 'string',
        enum: [...MEMORY_CATEGORIES],
        description: '记忆分类：user 用户身份/个人事实，preference 用户偏好，rule 约定与教训，knowledge 项目事实与技术决策，topic 长期关注方向，experience 任务经验，general 兜底',
      },
      importance: { type: 'number', description: '重要性 1-10（5 = 普通，8+ = 高价值可复用）', minimum: 1, maximum: 10 },
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
