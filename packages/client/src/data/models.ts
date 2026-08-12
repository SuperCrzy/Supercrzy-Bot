/**
 * DeepSeek 完整模型列表
 * 按系列分组，涵盖 V1～V4、R1推理、蒸馏模型、专项模型
 * 数据来源：OpenRouter / DeepSeek 官方 / 社区
 * 最后更新：2026-05-06
 */

export interface ModelInfo {
  id: string
  name: string
  series: string          // V1 | V2 | V3 | V3.1 | V3.2 | V4 | R1 | Distill | Special
  description: string
  contextWindow: number   // tokens
  maxOutputTokens?: number
  inputPrice: number      // USD per 1M tokens, 0 if free/open-source pricing varies
  outputPrice: number     // USD per 1M tokens
  releasedAt?: string
  recommended: boolean
  tier: 'flagship' | 'standard' | 'budget' | 'specialized'
  tags: string[]
  available: boolean      // 是否通过官方API可用（vs 仅OpenRouter/开源）
  thinkingCapable?: boolean // 是否支持 thinking/reasoning 模式
}

export interface ModelSeries {
  id: string
  name: string
  emoji: string
  description: string
  models: ModelInfo[]
}

/**
 * 所有模型数据
 */
export const allModels: ModelInfo[] = [
  // ========================
  // V4 系列（2026 旗舰）
  // ========================
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    series: 'V4',
    description: '万亿级多模态 MoE，1.6T 总参数 / 49B 激活。面向高级推理、编程、长周期 Agent 工作流。支持 high/xhigh 推理模式。',
    contextWindow: 1_048_576, // 1.05M
    inputPrice: 0.435,
    outputPrice: 0.87,
    releasedAt: '2026-04-24',
    recommended: true,
    tier: 'flagship',
    tags: ['推理', '编程', 'Agent', '多模态'],
    available: true,
    thinkingCapable: true,
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    series: 'V4',
    description: '低延迟 V4 变体，284B 总参数 / 13B 激活。面向实时聊天、高吞吐自动化、草稿迭代。极致性价比。',
    contextWindow: 1_048_576,
    inputPrice: 0.14,
    outputPrice: 0.28,
    releasedAt: '2026-04-24',
    recommended: true,
    tier: 'budget',
    tags: ['快速', '聊天', '高吞吐', '低成本'],
    available: true,
    thinkingCapable: false,
  },

  // ========================
  // V3.2 系列
  // ========================
  {
    id: 'deepseek-v3.2-speciale',
    name: 'DeepSeek V3.2 Speciale',
    series: 'V3.2',
    description: '高计算变体，强化学习后训练极限推理。在困难推理任务上据称超越 GPT-5，与 Gemini 3.0 Pro 相当。',
    contextWindow: 164_000,
    inputPrice: 0.40,
    outputPrice: 1.20,
    releasedAt: '2025-12-01',
    recommended: false,
    tier: 'flagship',
    tags: ['深度推理', '数学', '编程竞赛'],
    available: true,
    thinkingCapable: true,
  },
  {
    id: 'deepseek-v3.2',
    name: 'DeepSeek V3.2',
    series: 'V3.2',
    description: '引入 DeepSeek Sparse Attention (DSA)，GPT-5 级别性能。2025 IMO 和 IOI 金牌。支持 reasoning 模式。',
    contextWindow: 131_000,
    inputPrice: 0.252,
    outputPrice: 0.378,
    releasedAt: '2025-12-01',
    recommended: true,
    tier: 'standard',
    tags: ['DSA', 'GPT-5级', '通用', 'IMO金牌'],
    available: true,
    thinkingCapable: true,
  },
  {
    id: 'deepseek-v3.2-exp',
    name: 'DeepSeek V3.2 Exp',
    series: 'V3.2',
    description: 'V3.2 实验版本，用于验证 DSA 架构在长上下文场景下的效率优化。研究导向。',
    contextWindow: 164_000,
    inputPrice: 0.27,
    outputPrice: 0.41,
    releasedAt: '2025-09-29',
    recommended: false,
    tier: 'standard',
    tags: ['实验', '研究', '长上下文'],
    available: true,
    thinkingCapable: true,
  },

  // ========================
  // V3.1 系列
  // ========================
  {
    id: 'deepseek-v3.1-terminus',
    name: 'DeepSeek V3.1 Terminus',
    series: 'V3.1',
    description: 'V3.1 修复更新版，解决语言一致性和 Agent 能力问题。671B/37B激活，支持思维/非思维双模式。优化编程和搜索 Agent。',
    contextWindow: 164_000,
    inputPrice: 0.27,
    outputPrice: 0.95,
    releasedAt: '2025-09-22',
    recommended: false,
    tier: 'standard',
    tags: ['Agent优化', '双模式', '编程', '搜索'],
    available: true,
    thinkingCapable: true,
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek V3.1 (Chat)',
    series: 'V3.1',
    description: '混合推理模型，支持 thinking/non-thinking 模式。性能与 R1 相当但响应更快。支持结构化工具调用和代码 Agent。官方默认聊天模型。',
    contextWindow: 33_000,
    inputPrice: 0.15,
    outputPrice: 0.75,
    releasedAt: '2025-08-21',
    recommended: true,
    tier: 'standard',
    tags: ['官方默认', '混合推理', '快速', '工具调用'],
    available: true,
    thinkingCapable: true,
  },

  // ========================
  // V3 系列
  // ========================
  {
    id: 'deepseek-chat-v3-0324',
    name: 'DeepSeek V3 0324',
    series: 'V3',
    description: '685B 参数旗舰聊天模型，V3 系列最新迭代。通用能力强，稳定可靠。',
    contextWindow: 164_000,
    inputPrice: 0.20,
    outputPrice: 0.77,
    releasedAt: '2025-03-24',
    recommended: false,
    tier: 'standard',
    tags: ['稳定', '通用', 'V3系列'],
    available: true,
    thinkingCapable: false,
  },

  // ========================
  // V2.5 系列
  // ========================
  {
    id: 'deepseek-chat-v2.5',
    name: 'DeepSeek V2.5',
    series: 'V2.5',
    description: '融合 DeepSeek-V2-Chat 和 DeepSeek-Coder-V2-Instruct，通用与编程能力兼顾。',
    contextWindow: 128_000,
    inputPrice: 0,
    outputPrice: 0, // 已不单独定价，被V3替代
    releasedAt: '2024-05-14',
    recommended: false,
    tier: 'standard',
    tags: ['经典', '通用+编程', 'V2系列'],
    available: false, // 可能已下线
    thinkingCapable: false,
  },

  // ========================
  // R1 推理系列
  // ========================
  {
    id: 'deepseek-r1',
    name: 'DeepSeek R1',
    series: 'R1',
    description: '旗舰推理模型，性能与 OpenAI o1 持平。671B/37B激活，完全开源 MIT 许可。通过强化学习优化多步逻辑、数学与复杂规划。',
    contextWindow: 64_000,
    inputPrice: 0.70,
    outputPrice: 2.50,
    releasedAt: '2025-01-20',
    recommended: true,
    tier: 'flagship',
    tags: ['推理', '数学', '开源', 'MIT'],
    available: true,
    thinkingCapable: true,
  },
  {
    id: 'deepseek-r1-0528',
    name: 'DeepSeek R1 0528',
    series: 'R1',
    description: 'R1 升级版（2025年5月），增加计算量和后训练技巧，推理能力逼近 O3 和 Gemini 2.5 Pro。',
    contextWindow: 164_000,
    inputPrice: 0.50,
    outputPrice: 2.15,
    releasedAt: '2025-05-28',
    recommended: false,
    tier: 'flagship',
    tags: ['推理升级', 'O3级', '长上下文'],
    available: true,
    thinkingCapable: true,
  },
  {
    id: 'deepseek-r1-zero',
    name: 'DeepSeek R1 Zero',
    series: 'R1',
    description: '纯强化学习训练（无 SFT），展示自发推理行为。研究价值高但存在可读性问题。',
    contextWindow: 164_000,
    inputPrice: 0,
    outputPrice: 0,
    releasedAt: '2025-03-06',
    recommended: false,
    tier: 'specialized',
    tags: ['纯RL', '研究', '自发推理'],
    available: true,
    thinkingCapable: true,
  },

  // ========================
  // R1 蒸馏系列
  // ========================
  {
    id: 'deepseek-r1-distill-qwen-32b',
    name: 'R1 Distill Qwen 32B',
    series: 'Distill',
    description: '稠密模型新 SOTA，超越 o1-mini。AIME 2024: 72.6%, MATH-500: 94.3%, Codeforces: 1691。',
    contextWindow: 33_000,
    inputPrice: 0.29,
    outputPrice: 0.29,
    releasedAt: '2025-01-29',
    recommended: true,
    tier: 'budget',
    tags: ['蒸馏', '高性价比', '开源', '本地部署'],
    available: true,
    thinkingCapable: true,
  },
  {
    id: 'deepseek-r1-distill-qwen-14b',
    name: 'R1 Distill Qwen 14B',
    series: 'Distill',
    description: '超越 o1-mini。AIME 2024: 69.7%, MATH-500: 93.9%, Codeforces: 1481。轻量级推理模型。',
    contextWindow: 131_000,
    inputPrice: 0,
    outputPrice: 0,
    releasedAt: '2025-01-29',
    recommended: false,
    tier: 'budget',
    tags: ['蒸馏', '轻量', '开源', '本地部署'],
    available: true,
    thinkingCapable: true,
  },
  {
    id: 'deepseek-r1-distill-llama-70b',
    name: 'R1 Distill Llama 70B',
    series: 'Distill',
    description: '基于 Llama-3.3-70B-Instruct。AIME 2024: 70.0%, MATH-500: 94.5%, Codeforces: 1633。',
    contextWindow: 131_000,
    inputPrice: 0.70,
    outputPrice: 0.80,
    releasedAt: '2025-01-23',
    recommended: false,
    tier: 'standard',
    tags: ['蒸馏', 'Llama', '开源'],
    available: true,
    thinkingCapable: true,
  },

  // ========================
  // 专项模型
  // ========================
  {
    id: 'deepseek-prover-v2',
    name: 'DeepSeek Prover V2',
    series: 'Special',
    description: '形式化推理与定理证明专用模型。671B 参数，163K 上下文。面向数学、逻辑、形式化验证。',
    contextWindow: 163_000,
    inputPrice: 0,
    outputPrice: 0,
    releasedAt: '2025-04-30',
    recommended: false,
    tier: 'specialized',
    tags: ['定理证明', '形式化推理', '数学'],
    available: true,
    thinkingCapable: true,
  },
]

/**
 * 按系列分组的模型列表
 */
export const modelSeries: ModelSeries[] = [
  {
    id: 'V4',
    name: 'V4 系列',
    emoji: '🚀',
    description: '2026 旗舰多模态 MoE，万亿参数级',
    models: allModels.filter((m) => m.series === 'V4'),
  },
  {
    id: 'V3.2',
    name: 'V3.2 系列',
    emoji: '⚡',
    description: 'DSA 架构，GPT-5 级别性能',
    models: allModels.filter((m) => m.series === 'V3.2'),
  },
  {
    id: 'V3.1',
    name: 'V3.1 系列',
    emoji: '🔧',
    description: 'Agent 优化版，混合推理双模式',
    models: allModels.filter((m) => m.series === 'V3.1'),
  },
  {
    id: 'V3',
    name: 'V3 系列',
    emoji: '📦',
    description: '经典大规模 MoE，稳定可靠',
    models: allModels.filter((m) => m.series === 'V3'),
  },
  {
    id: 'V2.5',
    name: 'V2.5',
    emoji: '📚',
    description: '经典通用+编程模型',
    models: allModels.filter((m) => m.series === 'V2.5'),
  },
  {
    id: 'R1',
    name: 'R1 推理系列',
    emoji: '🧠',
    description: '强化学习推理，多步逻辑与数学',
    models: allModels.filter((m) => m.series === 'R1'),
  },
  {
    id: 'Distill',
    name: 'R1 蒸馏系列',
    emoji: '💎',
    description: '轻量推理模型，开源本地部署',
    models: allModels.filter((m) => m.series === 'Distill'),
  },
  {
    id: 'Special',
    name: '专项模型',
    emoji: '🎯',
    description: '定理证明、数学等垂直领域',
    models: allModels.filter((m) => m.series === 'Special'),
  },
]

/**
 * 根据模型ID查找模型信息
 */
export function getModelById(id: string): ModelInfo | undefined {
  return allModels.find((m) => m.id === id)
}

/**
 * 获取模型显示名称（简短版）
 */
export function getModelShortName(id: string): string {
  // UUID 格式 → 自定义模型，尝试从已知映射获取名称
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (UUID_RE.test(id)) {
    // 从 localStorage 缓存的 customModels 中查找
    try {
      const cached = localStorage.getItem('supercrzy:customModels')
      if (cached) {
        const models = JSON.parse(cached)
        const cm = models.find((m: any) => m.id === id)
        if (cm) return cm.displayName || cm.modelId || id.slice(0, 8)
      }
    } catch { /* ignore */ }
    return id.slice(0, 8) + '…'
  }
  const model = getModelById(id)
  if (!model) return id
  // 提取简短名称，如 "V4 Pro", "V4 Flash", "R1" 等
  const shortMap: Record<string, string> = {
    'deepseek-v4-pro': 'V4 Pro',
    'deepseek-v4-flash': 'V4 Flash',
    'deepseek-v3.2-speciale': 'V3.2 Speciale',
    'deepseek-v3.2': 'V3.2',
    'deepseek-v3.2-exp': 'V3.2 Exp',
    'deepseek-v3.1-terminus': 'V3.1 Terminus',
    'deepseek-chat': 'V3.1 Chat',
    'deepseek-chat-v3-0324': 'V3 0324',
    'deepseek-chat-v2.5': 'V2.5',
    'deepseek-r1': 'R1',
    'deepseek-r1-0528': 'R1 0528',
    'deepseek-r1-zero': 'R1 Zero',
    'deepseek-r1-distill-qwen-32b': 'R1 Qwen 32B',
    'deepseek-r1-distill-qwen-14b': 'R1 Qwen 14B',
    'deepseek-r1-distill-llama-70b': 'R1 Llama 70B',
    'deepseek-prover-v2': 'Prover V2',
  }
  return shortMap[id] || model.name
}

/**
 * 生成 NaiveUI n-select 使用的分组选项
 */
export function getModelSelectOptions(): Array<{
  type: 'group'
  label: string
  key: string
  children: Array<{ label: string; value: string }>
}> {
  // Show all available models grouped by series
  return modelSeries
    .filter(s => s.models.some(m => m.available))
    .map(s => ({
      type: 'group' as const,
      label: `${s.emoji} ${s.name}`,
      key: s.id,
      children: s.models
        .filter(m => m.available)
        .map(m => ({
          label: `${m.name}${m.recommended ? ' ⭐' : ''}`,
          value: m.id,
        })),
    }))
}
