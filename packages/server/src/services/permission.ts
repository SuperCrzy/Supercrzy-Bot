/**
 * 用户面向的两档权限（P0-04 2026-09-17 立，2026-10-22 合并为两档）
 *
 * 背景：权限概念对普通用户过多——历史上并存两套轴：
 *   ① settings.toolApprovalMode（全局 4 档裸概念）：auto / accept-edits / prompt / deny
 *   ② session.permissionLevel（会话级 3 档）：workspace-only / sandbox / full
 * 用户既不知道 accept-edits 和 prompt 差在哪，也不知道该配哪一层。
 *
 * 🔴 2026-10-22 老板裁决（第二次）：**三档合并成两档**。
 *   原因：同日把弹窗阈值抬到 `block` 之后，`prompt` / `accept-edits` / `auto` 三者行为
 *   **完全等价**（只差 `deny`），设置页上"执行前询问"和"自动执行"是两个一样的选择，
 *   留着等于让用户做无意义的选择。
 *
 * 现在的两档：
 *   readonly 仅查看   —— 只读，不执行任何写/删/命令类敏感操作（内部 = deny）
 *   ask      执行前询问 —— 只在**不可逆**操作前提问；改文件与普通命令直接执行（内部 = prompt）
 *
 * 设计原则：
 *   - **收敛只发生在呈现层**。两档在内部仍映射回历史 4 档，历史配置不会被破坏
 *     （旧的 accept-edits / auto 一律投影到 ask，行为不变：它们本来就等价）。
 *   - 存量 `permissionTier='auto'` 由 `database.ts` 的迁移改成 `ask`，行为零变化。
 */

/** 用户面向的两档 */
export type PermissionTier = 'readonly' | 'ask'

/** 历史内部档位（保持原语义，勿删） */
export type LegacyApprovalMode = 'auto' | 'accept-edits' | 'prompt' | 'deny'

export const PERMISSION_TIERS: readonly PermissionTier[] = ['readonly', 'ask']

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
    description: '只在不可逆操作前提问（删除、覆盖系统文件、装可执行代码、操作本机）；改文件与普通命令直接执行',
    legacy: 'prompt',
  },
}

export function isPermissionTier(v: unknown): v is PermissionTier {
  return typeof v === 'string' && (PERMISSION_TIERS as readonly string[]).includes(v)
}

/**
 * 把历史配置投影成用户面向的两档。
 * `auto` / `accept-edits` / `prompt` 三者行为已等价 ⇒ 一律投影到 `ask`。
 * ⚠️ 这意味着旧配置里的 `auto` **不再是一个独立档位**，读回来就是 `ask`。
 */
export function resolvePermissionTier(
  legacyMode?: string | null,
  permissionLevel?: string | null,
): PermissionTier {
  const m = String(legacyMode || '').trim()
  if (m === 'deny') return 'readonly'
  if (m === 'auto' || m === 'prompt' || m === 'accept-edits') return 'ask'
  // 未配置历史档位时，按会话权限档兜底
  if (permissionLevel === 'workspace-only') return 'readonly'
  if (permissionLevel === 'full') return 'ask'
  return 'ask'
}

/** 三档 → 历史内部档位（决定实际执行行为） */
export function tierToLegacyMode(tier: PermissionTier): LegacyApprovalMode {
  return TIER_META[tier]?.legacy || 'prompt'
}

/** 历史四档（同一组值既可能存在于 `toolApprovalMode`，也可能残留在 `permissionTier` 列里） */
const LEGACY_MODES: readonly LegacyApprovalMode[] = ['auto', 'accept-edits', 'prompt', 'deny']

/** 值是不是历史四档之一；不是则返回 null */
function asLegacyMode(v: unknown): LegacyApprovalMode | null {
  const s = String(v ?? '').trim()
  return (LEGACY_MODES as readonly string[]).includes(s) ? (s as LegacyApprovalMode) : null
}

/**
 * 存库的档位值 → 用户可见档位（**唯一决策点**，2026-10-22 D4）。
 *
 * 为什么要有它：库里 `permissionTier` 的值可能是
 *   ① 合法两档（readonly / ask）；
 *   ② 历史四档（auto / accept-edits / prompt / deny）—— 4 档时代的遗留，
 *      `database.ts` 的迁移只把 `auto` 改成了 `ask`，其余三种可能还在；
 *   ③ 压根没有（全新安装，只有历史 `toolApprovalMode`）。
 * 这个"该显示哪一档"的判断以前**前端也抄了一份**（`client/src/utils/permission.ts`），
 * 两份一旦漂移，UI 显示"仅查看"而实际按"执行前询问"跑 —— 用户以为锁上了，其实没锁。
 * 所以决策只留服务端这一处，前端只负责翻译成标签。
 *
 * ⚠️ 历史值**写在 `permissionTier` 列里**时优先于 `legacyMode` 参数：
 *    它才是用户当时在那个位置上做的选择。只有该列不是任何已知档位时，才回退到
 *    `toolApprovalMode`。（`deny` 尤其重要：回退到别的列等于悄悄把用户的"仅查看"解开。）
 */
export function resolveEffectiveTier(
  storedTier?: unknown,
  legacyMode?: string | null,
): PermissionTier {
  // ① `deny` 永不放宽：两列里任何一列还写着 deny，就按"仅查看"显示。
  //    否则会出现"界面显示执行前询问、agent 却一律拒绝"（或相反）的错位。
  if (asLegacyMode(storedTier) === 'deny' || asLegacyMode(legacyMode) === 'deny') return 'readonly'
  // ② 合法两档：原样返回
  if (isPermissionTier(storedTier)) return storedTier
  // ③ 历史四档残留在档位列里：它才是用户当时在那个位置做的选择
  const leftover = asLegacyMode(storedTier)
  if (leftover) return resolvePermissionTier(leftover)
  // ④ 回退历史 toolApprovalMode；都没有 → 默认档（ask，不锁）
  return resolvePermissionTier(legacyMode)
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
  // 顺序与 `resolveEffectiveTier` 一一对应（显示与执行必须同源，D4）：
  // ① deny 永不放宽 ② 合法两档 ③ 残留在档位列里的历史档 ④ 回退 toolApprovalMode ⑤ 会话权限档
  const leftoverInTier = asLegacyMode(tierSetting)
  if (leftoverInTier === 'deny' || asLegacyMode(legacyModeSetting) === 'deny') return 'deny'
  if (isPermissionTier(tierSetting)) return tierToLegacyMode(tierSetting)
  if (leftoverInTier) return leftoverInTier
  const m = asLegacyMode(legacyModeSetting)
  if (m) return m
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
 * 🔴 2026-10-22 老板裁决（对齐 WorkBuddy：**只有删除类才弹**）：
 *   把"要不要打断用户"的阈值从 `ask` 抬到 **`block`**。中风险（`ask`：sudo/chmod/kill/
 *   写工作区文件/写项目文件内容/memory_consolidate）**不再弹窗**，直接执行。
 *
 *   依据（`cli.mjs` 反查）：他们 `classifyCenterFileBlocks@4882289` 把没有命中策略规则的
 *   动作标成 `level:"unknown"`，而闸门 `hasAsk = needsApproval.some(t => "unknown" !== t.level)`
 *   （`@4880092`）**排除 unknown** ⇒ 默认不弹；写文件被 allow 规则覆盖成 `low`，
 *   删除命中 ask 规则成 `high`，于是"只有删除弹"。
 *
 * 判定顺序（顺序本身是承诺，改动前先看断言）：
 *   1. `deny`（= 仅查看档）→ 一律拒绝，任何记住/白名单都不能推翻
 *   2. 删除类（`file_delete`）→ **恒确认**，任何档位/白名单都不能跳过（2026-10-18 裁决）
 *   3. 本会话已对 block 类显式允许过 → 放行（"拦一次后记住"）
 *   4. `block`（不可逆/高危：递归删除、下载即执行、凭据、系统路径写入、装代码、操作本机）→ 确认
 *   5. 其余（`ask` / `allow`）→ **放行**
 *
 * ✅ 因此 `prompt` / `accept-edits` / `auto` 三档**行为完全一致**（只差 `deny`）。
 *    2026-10-22 已据此把用户面向的档位合并为两档（见文件头），这三者现在只是同一档的不同历史写法。
 *    `sessionApproved`（「本会话全部允许」）亦不再影响任何路径——只有
 *    `sessionBlockApproved`（对 block 类点过一次允许）还有效。
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

  // 🔴 2026-10-22：中风险（ask）不再打断 —— 这条取代了上一版"只放宽 shell_exec"的写法。
  //   分类器仍然输出 ask（它回答的是"有没有副作用"），但闸门回答的是"值不值得打断用户"。
  //   实测影响面：sudo / chmod / kill / 写工作区文件 / `echo x > src/a.ts` 不再弹。
  return 'allow'
}

/**
 * 等待用户确认的时长策略（**唯一实现**，2026-10-22）。
 *
 * 修掉的问题：`toolAutoApproveSeconds > 0` 时，此前**任何**待确认操作到了秒数
 * 都自动放行 —— 包括 `rm -rf` 和 `file_delete`。老板库实测该值为 **5**，
 * 意味着删除弹窗 5 秒没人点就**静默执行**，与 2026-10-18「删除永远必问」直接冲突。
 *
 * 规则（顺序即承诺）：
 *   1. **不可逆操作（block / 删除）永不自动放行**：忽略自动放行设置，走满超时，
 *      超时按 `timeout` 返回（下游按拒绝处理，并给出"没人确认"的文案而不是"用户拒绝"）。
 *   2. 其余情况沿用旧语义：`autoApproveSeconds > 0` → 到点自动放行；否则走满超时。
 */
export const CONFIRMATION_TIMEOUT_MS = 120_000

export interface ConfirmationWait {
  /** 到点后是否自动放行 */
  autoAllow: boolean
  /** 实际等待时长（ms） */
  effectiveMs: number
  /** 是否因为不可逆而强制走满超时 */
  irreversible: boolean
}

export function resolveConfirmationWait(
  autoApproveSeconds?: number | null,
  opts: { irreversible?: boolean; timeoutMs?: number } = {},
): ConfirmationWait {
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : CONFIRMATION_TIMEOUT_MS
  const irreversible = opts.irreversible === true
  if (irreversible) return { autoAllow: false, effectiveMs: timeoutMs, irreversible: true }
  const sec = Number(autoApproveSeconds) || 0
  const autoAllow = sec > 0
  return { autoAllow, effectiveMs: autoAllow ? Math.round(sec * 1000) : timeoutMs, irreversible: false }
}

