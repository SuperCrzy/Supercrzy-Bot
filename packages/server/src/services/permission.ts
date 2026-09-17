/**
 * 用户面向的三档权限（P0-04，2026-09-17）
 *
 * 背景：权限概念对普通用户过多——历史上并存两套轴：
 *   ① settings.toolApprovalMode（全局 4 档裸概念）：auto / accept-edits / prompt / deny
 *   ② session.permissionLevel（会话级 3 档）：workspace-only / sandbox / full
 * 用户既不知道 accept-edits 和 prompt 差在哪，也不知道该配哪一层。
 *
 * 本模块把「用户能理解的」收敛为三档：
 *   readonly 仅查看   —— 只读，不执行任何写/删/命令类敏感操作
 *   ask      执行前询问 —— 每个敏感操作都先确认（默认）
 *   auto     自动执行   —— 安全操作自动放行，危险操作仍会确认
 *
 * 设计原则：
 *   - **收敛只发生在呈现层**。三档在内部映射回历史 4 档，行为完全不变，
 *     历史配置不会被破坏（旧的 accept-edits 仍走 accept-edits 分支，只是 UI 归入"执行前询问"）。
 *   - 三档恒等价或更安全：accept-edits → ask 方向是"问得更多"，不会静默放宽权限。
 */

/** 用户面向的三档 */
export type PermissionTier = 'readonly' | 'ask' | 'auto'

/** 历史内部档位（保持原语义，勿删） */
export type LegacyApprovalMode = 'auto' | 'accept-edits' | 'prompt' | 'deny'

export const PERMISSION_TIERS: readonly PermissionTier[] = ['readonly', 'ask', 'auto']

export interface TierMeta {
  tier: PermissionTier
  /** 用户可读名称 */
  label: string
  /** 一句话说明（告诉用户"会发生什么"） */
  description: string
  /** 映射到的历史内部档位（决定实际执行行为） */
  legacy: LegacyApprovalMode
}

export const TIER_META: Record<PermissionTier, TierMeta> = {
  readonly: {
    tier: 'readonly',
    label: '仅查看',
    description: '只读取和查看，不写入文件、不执行命令',
    legacy: 'deny',
  },
  ask: {
    tier: 'ask',
    label: '执行前询问',
    description: '每次要改文件或执行命令前先问你（默认，最稳妥）',
    legacy: 'prompt',
  },
  auto: {
    tier: 'auto',
    label: '自动执行',
    description: '安全操作自动执行，危险操作仍会先确认',
    legacy: 'auto',
  },
}

export function isPermissionTier(v: unknown): v is PermissionTier {
  return typeof v === 'string' && (PERMISSION_TIERS as readonly string[]).includes(v)
}

/**
 * 把历史配置投影成用户面向的三档。
 * 注意 accept-edits → ask：它本质是"编辑自动批准、命令仍询问"，
 * 在用户视角属于"执行前询问"档的细分，故归入 ask（问得更多，不会放宽）。
 */
export function resolvePermissionTier(
  legacyMode?: string | null,
  permissionLevel?: string | null,
): PermissionTier {
  const m = String(legacyMode || '').trim()
  if (m === 'deny') return 'readonly'
  if (m === 'auto') return 'auto'
  if (m === 'prompt' || m === 'accept-edits') return 'ask'
  // 未配置历史档位时，按会话权限档兜底
  if (permissionLevel === 'workspace-only') return 'readonly'
  if (permissionLevel === 'full') return 'auto'
  return 'ask'
}

/** 三档 → 历史内部档位（决定实际执行行为） */
export function tierToLegacyMode(tier: PermissionTier): LegacyApprovalMode {
  return TIER_META[tier]?.legacy || 'prompt'
}

/**
 * 解析最终生效的内部档位：三档设置优先，缺失时回退历史四档。
 * agent.ts 用它决定敏感工具的实际授权行为。
 */
export function resolveApprovalMode(
  tierSetting?: string | null,
  legacyModeSetting?: string | null,
  permissionLevel?: string | null,
): LegacyApprovalMode {
  if (isPermissionTier(tierSetting)) return tierToLegacyMode(tierSetting)
  const m = String(legacyModeSetting || '').trim()
  if (m === 'auto' || m === 'accept-edits' || m === 'prompt' || m === 'deny') return m as LegacyApprovalMode
  // 都没有 → 从会话权限档推导
  return tierToLegacyMode(resolvePermissionTier(null, permissionLevel))
}
