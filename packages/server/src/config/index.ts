import 'dotenv/config'

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    defaultModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
  },
  db: {
    path: process.env.DB_PATH || './data/deepseek-agent.db',
  },
}
