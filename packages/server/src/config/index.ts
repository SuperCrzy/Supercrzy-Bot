import { config as loadEnv } from 'dotenv'
import { existsSync } from 'fs'
import { dirname, resolve, join } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '../../../..')
const packageRoot = resolve(__dirname, '../..')
const nodeEnv = process.env.NODE_ENV || 'development'
const preferredEnv = nodeEnv === 'production' ? '.env.production' : '.env'
const envCandidates = [
  resolve(repoRoot, preferredEnv),
  resolve(packageRoot, preferredEnv),
  resolve(repoRoot, '.env'),
  resolve(packageRoot, '.env')
]

for (const envPath of envCandidates) {
  if (existsSync(envPath)) {
    loadEnv({ path: envPath, override: false })
    break
  }
}

/**
 * 统一用户数据目录 DB 路径（2026-08-26：让 Web 后端 与 Electron 内嵌后端 同机共享同一份 SQLite）：
 * - 显式设置绝对 DB_PATH → 尊重（自定义场景）
 * - 否则统一到 ~/.supercrzy/data/supercrzy.db（用户目录），App(内嵌) 与 Web(dev/生产) 都从此读写 → 数据互通
 * - 绝对路径才当"用户指定"；相对路径(如 .env 的 ./data/...)会被提升到用户目录，避免 App/Web 因 cwd 不同分裂
 */
function resolveDbPath(): string {
  const p = process.env.DB_PATH
  if (p && (p.startsWith('/') || p.startsWith('~'))) {
    return p.replace(/^~/, homedir())
  }
  return join(homedir(), '.supercrzy', 'data', 'supercrzy.db')
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  deepseek: {
    apiKey: process.env.OPENAI_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    defaultModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
  },
  db: {
    path: resolveDbPath(),
  },
  workspaceDir: process.env.WORKSPACE_DIR || process.cwd(),
  // 隧道默认关闭：纯本地运行，只有显式设置 TUNNEL_ENABLED=true 才开启公网穿透
  tunnel: {
    enabled: process.env.TUNNEL_ENABLED === 'true',
    subdomain: process.env.TUNNEL_SUBDOMAIN || '',
  },
}
