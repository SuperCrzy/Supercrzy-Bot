/**
 * 用户面向的三档权限（P0-04，客户端侧）
 *
 * 与 server 的 services/permission.ts 保持同一套定义（monorepo 无共享包，故此处镜像）。
 * 若改档位语义，**两处都要改**。
 */

export type PermissionTier = 'readonly' | 'ask' | 'auto'

export const PERMISSION_TIERS: readonly PermissionTier[] = ['readonly', 'ask', 'auto']

export function isPermissionTier(v: unknown): v is PermissionTier {
  return typeof v === 'string' && (PERMISSION_TIERS as readonly string[]).includes(v)
}

/**
 * 历史配置 → 三档。
 * accept-edits（编辑自动批准、命令仍询问）在用户视角属"执行前询问"档的细分 → ask。
 */
export function resolvePermissionTier(
  legacyMode?: string | null,
  permissionLevel?: string | null,
): PermissionTier {
  const m = String(legacyMode || '').trim()
  if (m === 'deny') return 'readonly'
  if (m === 'auto') return 'auto'
  if (m === 'prompt' || m === 'accept-edits') return 'ask'
  if (permissionLevel === 'workspace-only') return 'readonly'
  if (permissionLevel === 'full') return 'auto'
  return 'ask'
}

/** 三档 → i18n key（标签 / 说明） */
export const TIER_I18N: Record<PermissionTier, { label: string; desc: string }> = {
  readonly: { label: 'settings.permTierReadonly', desc: 'settings.permTierReadonlyDesc' },
  ask: { label: 'settings.permTierAsk', desc: 'settings.permTierAskDesc' },
  auto: { label: 'settings.permTierAuto', desc: 'settings.permTierAutoDesc' },
}
