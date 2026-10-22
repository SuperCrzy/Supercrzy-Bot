/**
 * 用户面向的两档权限 —— **显示层**（2026-10-22 D4 收敛）
 *
 * 🔴 这个文件**不再决定任何行为**。档位判定（存库值/历史值 → 生效档位）只有一处：
 *   `packages/server/src/services/permission.ts` 的 `resolveEffectiveTier`，
 *   由 `GET /api/settings` 算好后放进 `permissionTier` 返回。
 *
 * 为什么删掉前端那份 `resolvePermissionTier`：它和 server 的同名函数是两份独立实现，
 * 一旦漂移，界面显示"仅查看"而实际按"执行前询问"跑 —— 用户以为锁上了其实没锁，
 * 而且从 UI 上完全看不出来（上一版注释写着"两处都要改"，靠人记，必然漏）。
 * 现在前端只保留**翻译与顺序**：
 *   - `PERMISSION_TIERS`：单选组显示顺序（产品语义，不是后端契约）
 *   - `TIER_I18N`：档位 → i18n key
 *   - `isPermissionTier`：对服务端返回值的类型守卫（不认识就退回默认档，不崩）
 *
 * 新增档位时：server 的 `TIER_META` 与这里的三处一起加，缺 i18n key 会直接看到裸 id。
 */

export type PermissionTier = 'readonly' | 'ask'

/** 单选组显示顺序（默认档在前） */
export const PERMISSION_TIERS: readonly PermissionTier[] = ['readonly', 'ask']

/** 服务端没给/给了不认识的值时的兜底（与 server 默认档 `ask` 一致） */
export const DEFAULT_PERMISSION_TIER: PermissionTier = 'ask'

export function isPermissionTier(v: unknown): v is PermissionTier {
  return typeof v === 'string' && (PERMISSION_TIERS as readonly string[]).includes(v)
}

/** 两档 → i18n key（标签 / 说明） */
export const TIER_I18N: Record<PermissionTier, { label: string; desc: string }> = {
  readonly: { label: 'settings.permTierReadonly', desc: 'settings.permTierReadonlyDesc' },
  ask: { label: 'settings.permTierAsk', desc: 'settings.permTierAskDesc' },
}
