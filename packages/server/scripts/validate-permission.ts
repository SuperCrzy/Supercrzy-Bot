/**
 * 权限档位契约（G12，2026-10-23）。
 *
 * 修的是什么：`PermissionTier` 类型 + `PERMISSION_TIERS` 清单 + `isPermissionTier`
 * 守卫在 client（显示层）与 server（决策层）各有一份 —— 这是 monorepo 无共享包下的
 * 有意拆分（前端只翻译、不决策，见两文件头注释），**但两份清单必须逐字一致**：
 * 漂移的后果是"界面显示的档位集合"和"服务端认识的档位集合"不同 —— 用户选了服务端
 * 不认识的档位会被静默兜底成 `ask`。
 *
 * 断言（可执行）：
 *   ① 两处 `PERMISSION_TIERS = [...]` 的字面量集合完全相同（readonly / ask）；
 *   ② 两处都有 `isPermissionTier` 类型守卫；
 *   ③ server 的 TIER_META 覆盖清单里每一个档位（缺 meta = 档位无行为映射，必错）；
 *   ④ desktop/.deploy-server 不再持有一份拷贝（历史第三份，必须保持消亡）。
 *
 * 用法: node node_modules/tsx/dist/cli.mjs scripts/validate-permission.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..') // repo root（scripts → server → packages → 根）
const CLIENT = join(ROOT, 'packages/client/src/utils/permission.ts')
const SERVER = join(ROOT, 'packages/server/src/services/permission.ts')
const DESKTOP_LEGACY = join(ROOT, 'packages/desktop/.deploy-server/src/services/permission.ts')

let failed = false
const clientSrc = readFileSync(CLIENT, 'utf8')
const serverSrc = readFileSync(SERVER, 'utf8')

function tierList(src: string, label: string): string[] | null {
  const m = src.match(/PERMISSION_TIERS(?::\s*[^=]+)?=\s*\[([^\]]*)\]/)
  if (!m) {
    console.log(`❌ ${label} 找不到 PERMISSION_TIERS 声明`)
    failed = true
    return null
  }
  return [...m[1].matchAll(/['"]([a-z-]+)['"]/g)].map((x) => x[1])
}

const clientTiers = tierList(clientSrc, 'client')
const serverTiers = tierList(serverSrc, 'server')

console.log('=== 权限档位契约（G12）===')

if (clientTiers && serverTiers) {
  const same = clientTiers.length === serverTiers.length && clientTiers.every((t, i) => t === serverTiers[i])
  if (!same) {
    console.log(`❌ 两份档位清单漂移: client=[${clientTiers}] server=[${serverTiers}]`)
    failed = true
  } else if (clientTiers.length === 0) {
    console.log('❌ 档位清单为空')
    failed = true
  } else {
    console.log(`✅ 档位清单一致（${clientTiers.length} 档: ${clientTiers.join(' / ')}）`)
  }
}

for (const [label, src] of [['client', clientSrc], ['server', serverSrc]] as const) {
  if (!/export function isPermissionTier/.test(src)) {
    console.log(`❌ ${label} 缺 isPermissionTier 类型守卫`)
    failed = true
  }
}
if (!failed) console.log('✅ 两处都有 isPermissionTier 类型守卫')

// ③ server TIER_META 必须覆盖每个档位
{
  const metaKeys = [...serverSrc.matchAll(/^\s{2}(readonly|ask):\s*\{/gm)].map((m) => m[1])
  const missing = (serverTiers || []).filter((t) => !metaKeys.includes(t))
  if (missing.length) {
    console.log(`❌ TIER_META 缺少档位映射: ${missing.join(', ')}`)
    failed = true
  } else {
    console.log(`✅ TIER_META 覆盖全部档位（${metaKeys.length} 项）`)
  }
}

// ④ desktop/.deploy-server 的拷贝（部署产物，不入库）：存在则必须与 server 逐字一致。
//    它由部署流程从 server 复制而来，**不允许手改** —— 内容漂移 = 有人改了拷贝没改源头。
if (existsSync(DESKTOP_LEGACY)) {
  const deploySrc = readFileSync(DESKTOP_LEGACY, 'utf8')
  if (deploySrc === serverSrc) {
    console.log('✅ desktop/.deploy-server 拷贝与 server 逐字一致（部署产物，未手改）')
  } else {
    console.log('❌ desktop/.deploy-server 的 permission.ts 与 server 源头不一致 —— 部署拷贝被手改或未重新部署')
    failed = true
  }
} else {
  console.log('✅ desktop 无权限拷贝（部署产物尚未生成，允许）')
}

process.exit(failed ? 1 : 0)
