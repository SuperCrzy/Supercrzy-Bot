/**
 * 记忆分类单一事实源（2026-09-18，收敛 5 套互不相认的词表）
 *
 * 病灶（改动前）：分类词表散在 5 处且互不相认——
 *   - `reflection.ts`          写 `experience`
 *   - `memory-sync.ts`         校验只认 user / knowledge / general / topic
 *   - `agent.ts`（正则抽取）    写 `preference`
 *   - `routes/memory.ts`       校验只认 general / preference / fact / rule
 *   - `memory-search.ts`       权重表只覆盖 experience / user / knowledge / general
 * 实测后果（208 条真实数据）：
 *   1. 库里出现 7 个分类：experience 103 / knowledge 63 / user 22 / preference 7 / topic 7 / rule 5 / 经验 1
 *   2. `preference`（用户偏好，个性化最关键）与 `rule`（约定/教训）**只拿默认权重 1.0**，
 *      而 `experience` 是 1.5 → 越有用的越排不过任务流水
 *   3. `fact` 成了"活着的死分类"：database.ts 早已把历史 `fact` 迁成 `knowledge`，
 *      但 routes/memory.ts 的校验器仍在放行 `fact`
 *   4. `经验`（中文）是某条没走校验的路径留下的脏值，会被原样注入 system prompt
 *
 * 现在：**本文件是唯一权威**。写入路径一律经 `normalizeCategory()`，排序权重一律读 `categoryWeight()`，
 * 迁移映射一律读 `CATEGORY_ALIASES`。禁止在任何其他文件里再定义分类清单或权重表。
 */

/** 现行分类（顺序即文档顺序，不代表优先级；优先级见 CATEGORY_WEIGHT） */
export const MEMORY_CATEGORIES = [
  'user',       // 用户画像：身份 / 个人事实 / 我在做 X
  'preference', // 用户偏好：喜欢什么、怎么做事（个性化最关键）
  'rule',       // 约定 / 经验教训：违反会出错的硬规则
  'knowledge',  // 项目事实 / 技术决策 / 领域事实
  'topic',      // 长期关注方向（驱动 news_search 主动提醒）
  'experience', // 任务反思沉淀（5 问反思产出）
  'general',    // 兜底
] as const

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

/** 无法识别时的落点 */
export const DEFAULT_CATEGORY: MemoryCategory = 'general'

/**
 * 历史脏值 → 现行分类。
 * 迁移（database.ts）与运行时归一（normalizeCategory）**共用这一张表**，绝不两处各写一套
 * —— 那正是本次要根治的病。
 */
export const CATEGORY_ALIASES: Record<string, MemoryCategory> = {
  // 旧四语义时代（fact 在 database.ts 已有单条迁移，这里保留以便归一）
  fact: 'knowledge',
  // 中文脏值（实测存在「经验」1 条）
  经验: 'experience',
  事实: 'knowledge',
  知识: 'knowledge',
  偏好: 'preference',
  规则: 'rule',
  约定: 'rule',
  用户: 'user',
  关注: 'topic',
  通用: 'general',
}

/**
 * 排序权重：越高越该占 prompt 位（配合 rankMemories 的乘法分数）。
 *
 * 设计原则：**只加不削**。改动前的值原样保留（experience 1.5 / user 1.3 / knowledge 1.0 / general 0.8），
 * 只为原先落默认值 1.0 的分类补上有依据的权重，绝不反过来压低既有分类——
 * 那会让"修权重"变成一次不可预期的行为退化。
 *
 * preference / rule 给到高于 experience 的位置：它们是**低频、高信噪、持久**的，
 * 而 experience 是**高频、持续膨胀**的（103 条且每日新增），靠配额而非权重去限制它。
 */
export const CATEGORY_WEIGHT: Record<MemoryCategory, number> = {
  preference: 1.6,  // 用户偏好：个性化最关键，最高
  rule: 1.5,        // 约定/教训：违反会出错
  experience: 1.5,  // 原值，不动
  user: 1.3,        // 原值，不动
  topic: 1.1,       // 长期关注方向：驱动资讯主动提醒
  knowledge: 1.0,   // 原值，不动
  general: 0.8,     // 原值，不动
}

/** 分类校验：只认现行枚举 */
export function isMemoryCategory(v: unknown): v is MemoryCategory {
  return typeof v === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(v)
}

/**
 * 归一：合法值原样返回；别名按 CATEGORY_ALIASES 折算；其余一律落 DEFAULT_CATEGORY。
 * 大小写/空白容错（模型可能输出 "Knowledge" / " knowledge "）。
 * 绝不抛错——写入路径不能被一个脏分类字符串打断。
 */
export function normalizeCategory(raw: unknown): MemoryCategory {
  if (typeof raw !== 'string') return DEFAULT_CATEGORY
  const k = raw.trim()
  if (k === '') return DEFAULT_CATEGORY
  if (isMemoryCategory(k)) return k
  const lower = k.toLowerCase()
  if (isMemoryCategory(lower)) return lower
  return CATEGORY_ALIASES[k] ?? CATEGORY_ALIASES[lower] ?? DEFAULT_CATEGORY
}

/**
 * 排序权重。未知分类返回 1.0（**不惩罚历史数据**：归一之后理论上不该再有未知值，
 * 但真的漏了一个也不该让它直接消失）。
 */
export function categoryWeight(category: string): number {
  return isMemoryCategory(category) ? CATEGORY_WEIGHT[category] : 1.0
}

/** importance 收敛到 1..10 整数（各写入路径原先各写各的 clamp，此处统一） */
export function normalizeImportance(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n)) return 5
  return Math.min(Math.max(Math.round(n), 1), 10)
}
