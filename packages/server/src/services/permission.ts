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

// =============================================================
// 授权决策（**唯一实现**，2026-09-24/I14 收敛）
//
// 修掉的 bug：`agent.ts` 里四档各写一遍分支，其中
//   ① `auto` 档**完全不读**会话白名单 → 点过「本会话全部允许」照样逐个弹窗（老板报的正是这个）
//   ② `accept-edits` 档 `loadSessionApprovals()` 调了但**从不使用**返回值（死调用）
//   ③ 只有 `prompt` 档读白名单 → 同一个按钮在不同档位行为不一致
// ⇒ 收敛成一个纯函数 + 一张真值表（`tool-auto-permission.test.ts` 逐格断言）。
// =============================================================

export type ApprovalAction = 'allow' | 'confirm' | 'deny'

/** 工具分类结果（= services/tools.ts 的 classifySensitiveTool 返回值，注入以免循环依赖） */
export type ToolRisk = 'allow' | 'ask' | 'block'

export interface ApprovalContext {
  /** 生效内部档位 */
  mode: LegacyApprovalMode
  /** 会话权限档（workspace-only / sandbox / full） */
  permissionLevel?: string | null
  /** 本会话是否已点过「本会话全部允许」 */
  sessionApproved: boolean
  /**
   * 本会话是否已对某个 block 类工具**显式允许过**（"拦一次后记住"，老板 2026-09-24 17:57 裁决）。
   * 只在用户对 block 类点了「允许」时记录；点「拒绝」不记。
   */
  sessionBlockApproved?: boolean
  /** 工具分类器（注入） */
  classify: (toolName: string, args: string) => ToolRisk
}

/**
 * 敏感工具的授权决策（纯函数，可逐格单测）。
 *
 * 判定顺序（顺序本身是承诺，改动前先看断言）：
 *   1. `deny`（= 仅查看档）→ 一律拒绝，任何记住/白名单都不能推翻
 *   2. `block` 已被本会话**显式允许过一次** → 放行（"拦一次后记住"）
 *   3. `block`（不可逆/高危：删除、磁盘、凭据、系统路径写入…）→ 一律**确认**
 *      —— 普通会话白名单（「本会话全部允许」）**不**覆盖 block
 *   4. 会话白名单 → **放行**（这是「本会话全部允许」的语义：除 block 外全放行）
 *   5. `auto` 档 / `full` 权限 → 放行
 *   6. `accept-edits` 档 → 文件编辑放行，其余确认
 *   7. 其余（`prompt` = 执行前询问档）→ 确认
 *
 * ⚠️ `mode === 'auto'` 下 `ask` 类**直接放行**（"除删除外全放行"）；想要"未知命令也问"，
 *    请把档位调回 ask（执行前询问）—— 那才是该档的承诺。
 */
export function decideToolApproval(
  toolName: string,
  args: string,
  ctx: ApprovalContext,
): ApprovalAction {
  if (ctx.mode === 'deny') return 'deny'

  const risk = ctx.classify(toolName, args)

  // 🔴 2026-10-18 老板裁决（「3. 删除类永远必问」）：**删除任何档位都不被"记住"放行**。
  //
  //   改前：`if (ctx.sessionBlockApproved) return 'allow'` 排在 block 判断之前，
  //         意味着只要用户在本会话对**任意** block 类工具点过一次「允许」，
  //         之后 `file_delete` 也不再询问 —— 删文件静默执行。
  //   删除是唯一真正不可逆的操作（文件内容无法从应用内恢复），
  //   必须每次单独确认，不能继承任何会话级记忆。
  const isDelete = toolName === 'file_delete' || risk === 'block' && /(^|_)delete$/.test(toolName)
  if (isDelete) return 'confirm'

  // "拦一次后记住"：本会话已对 block 类显式允许过 → 不再拦（deny 档除外；删除类已在上方排除）
  if (ctx.sessionBlockApproved) return 'allow'
  // block 恒拦：**放在普通白名单之前**，会话级"全部允许"不能推翻不可逆操作
  if (risk === 'block') return 'confirm'

  if (ctx.sessionApproved) return 'allow'
  if (ctx.mode === 'auto') return 'allow'
  if (ctx.permissionLevel === 'full') return 'allow'
  if (ctx.mode === 'accept-edits' && (toolName === 'file_write' || toolName === 'multi_edit')) return 'allow'
  return 'confirm'
}

