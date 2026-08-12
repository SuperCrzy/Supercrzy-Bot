import { config as loadEnv } from 'dotenv'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
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

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  deepseek: {
    apiKey: process.env.OPENAI_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    defaultModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
  },
  db: {
    path: process.env.DB_PATH || './data/supercrzy.db',
  },
  workspaceDir: process.env.WORKSPACE_DIR || process.cwd(),
  // 隧道默认关闭：纯本地运行，只有显式设置 TUNNEL_ENABLED=true 才开启公网穿透
  tunnel: {
    enabled: process.env.TUNNEL_ENABLED === 'true',
    subdomain: process.env.TUNNEL_SUBDOMAIN || '',
  },
}
