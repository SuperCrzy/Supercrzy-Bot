import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { config } from '../config'

let db: Database.Database

export function initDatabase() {
  const dbDir = dirname(config.db.path)
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  db = new Database(config.db.path)

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      model TEXT NOT NULL DEFAULT 'deepseek-chat',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL DEFAULT '',
      token_count INTEGER,
      cost REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_memory (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      importance INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_memory_category ON agent_memory(category);
    CREATE INDEX IF NOT EXISTS idx_agent_memory_key ON agent_memory(key);

    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_uploads_session_id ON uploads(session_id);

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general',
      enabled INTEGER NOT NULL DEFAULT 1,
      trigger_keywords TEXT NOT NULL DEFAULT '',
      prompt_template TEXT NOT NULL DEFAULT '',
      tools TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
    CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      subject TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      parent_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      blocked_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      schedule_type TEXT NOT NULL DEFAULT 'recurring',
      rrule TEXT NOT NULL DEFAULT '',
      scheduled_at TEXT,
      next_run_at INTEGER,
      last_run_at INTEGER,
      valid_from TEXT,
      valid_until TEXT,
      model_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_automations_status ON automations(status);
    CREATE INDEX IF NOT EXISTS idx_automations_next_run ON automations(next_run_at);

    -- Add attachments column to messages if not exists (SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we try/catch)
    -- We'll handle this in migration below

    CREATE TABLE IF NOT EXISTS custom_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_key TEXT NOT NULL UNIQUE,
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      models TEXT NOT NULL DEFAULT '[]',
      capabilities TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_preset INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS custom_models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES custom_providers(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_custom_models_provider ON custom_models(provider_id);
    CREATE INDEX IF NOT EXISTS idx_custom_providers_key ON custom_providers(provider_key);

    -- 经验库（Playbook）：Agent 任务执行复盘，供同类任务注入
    CREATE TABLE IF NOT EXISTS playbook (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL DEFAULT '',
      lesson TEXT NOT NULL DEFAULT '',
      tools_used TEXT NOT NULL DEFAULT '[]',
      turns INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT 'completed',
      session_id TEXT,
      checkpoint_id TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_playbook_task_type ON playbook(task_type);
    CREATE INDEX IF NOT EXISTS idx_playbook_created ON playbook(created_at);

    -- 专家角色（角色化 Agent）：任务按类型自动分发到对应角色
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      task_keywords TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_roles_enabled ON roles(enabled);

    -- Insert default roles (5 expert roles + default fallback)
    INSERT OR IGNORE INTO roles (id, name, task_keywords, system_prompt, enabled, is_default, sort_order) VALUES
      ('role-design', '设计', '设计,UI,UX,视觉,页面,界面,海报,logo,品牌,创意,草图,原型,配色,字体,布局,交互,figma,sketch,设计稿,切图', 'You are Crzy, the design expert of SUPERCRZY BOT. You excel at UI/UX design, visual design, brand identity, layout, typography, color systems, and creative ideation. When given a design task, think like a senior designer: clarify intent, propose a clear visual direction, and deliver concrete design outputs (structure, copy suggestions, visual specs, or implementation guidance). Use web search to research current design trends when needed. Respect the brand''s original-design principle and avoid emoji-based UI.', 1, 0, 10),
      ('role-dev', '开发', '代码,开发,编程,修复,bug,报错,error,debug,前端,后端,接口,api,数据库,算法,脚本,函数,类,部署,构建,编译,测试,重构,优化,git,commit,push,pull,typescript,javascript,python,vue,node,koa,sql', 'You are the engineering expert of SUPERCRZY BOT. You excel at writing, debugging, and refactoring code, system architecture, and technical problem solving. When given a coding task: analyze the requirement, check existing code first (file_read), implement end-to-end, verify it runs, and report real output. Follow the project''s conventions: pnpm monorepo, TypeScript strict, no emoji in UI. Never fabricate results — run and show.', 1, 0, 20),
      ('role-data', '数据分析', '数据,分析,统计,报表,图表,excel,表格,月报,复盘,业绩,销售额,预算,roi,转化率,趋势,指标,kpi,可视化,透视,汇总,同比,环比', 'You are the data analyst of SUPERCRZY BOT. You excel at analyzing data, building reports, spotting trends, and turning numbers into actionable insights. When given a data task: locate the data source (files, exports, or uploads), clean it, analyze with concrete numbers, and present findings in structured tables. Always back conclusions with specific figures — never vague generalizations.', 1, 0, 30),
      ('role-copy', '文案', '文案,写作,文章,报告,文档,方案,邮件,演讲稿,标题,广告语,简介,总结,润色,翻译,营销,brief,策划,脚本,内容', 'You are the copywriting expert of SUPERCRZY BOT. You excel at writing, editing, and polishing content: reports, articles, marketing copy, briefs, emails, and structured documents. When given a writing task: understand the audience first, use a clear structure (headings, tables, lists), match the required tone, and deliver complete polished output ready to use. Write in the user''s language unless specified.', 1, 0, 40),
      ('role-general', '通用', '', 'You are a helpful assistant powered by SUPERCRZY BOT.', 1, 1, 99);

    -- Insert default settings
    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('apiKey', ''),
      ('model', ''),
      ('systemPrompt', 'You are a helpful assistant powered by SUPERCRZY BOT.'),
      ('temperature', '0.7'),
      ('maxTokens', '8192');

    -- Insert preset providers (14 channels, synced with client PREDEFINED)
    INSERT OR IGNORE INTO custom_providers (id, name, provider_key, base_url, api_key, models, capabilities, is_preset, sort_order) VALUES
      ('preset-ollama', 'Ollama (本地)', 'ollama', 'http://localhost:11434/v1', '', '[]', '["chat"]', 1, 0),
      ('preset-meta', 'Meta Llama', 'meta', 'https://api.groq.com/openai/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 1),
      ('preset-nvidia', 'NVIDIA NIM', 'nvidia', 'https://integrate.api.nvidia.com/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 2),
      ('preset-qwen', '阿里 Qwen', 'qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 3),
      ('preset-deepseek', 'DeepSeek', 'deepseek', 'https://api.deepseek.com', '', '[]', '["chat","reasoning","tool-calling"]', 1, 4),
      ('preset-openai', 'OpenAI', 'openai', 'https://api.openai.com/v1', '', '[]', '["chat","reasoning","tool-calling","vision"]', 1, 5),
      ('preset-openrouter', 'OpenRouter', 'openrouter', 'https://openrouter.ai/api/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 6),
      ('preset-anthropic', 'Anthropic', 'anthropic', 'https://api.anthropic.com', '', '[]', '["chat","reasoning","tool-calling","vision"]', 1, 7),
      ('preset-grok', 'xAI Grok', 'grok', 'https://api.x.ai/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 8),
      ('preset-gemini', 'Google Gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta', '', '[]', '["chat","reasoning","vision"]', 1, 9),
      ('preset-mistral', 'Mistral', 'mistral', 'https://api.mistral.ai/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 10),
      ('preset-zhipu', '智谱 GLM', 'zhipu', 'https://open.bigmodel.cn/api/paas/v4', '', '[]', '["chat","reasoning","tool-calling","vision"]', 1, 11),
      ('preset-kimi', 'Kimi / Moonshot', 'kimi', 'https://api.moonshot.cn/v1', '', '[]', '["chat","tool-calling"]', 1, 12),
      ('preset-mimo', '小米 MiMo', 'mimo', 'https://api.xiaomimimo.com/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 13);
  `)

  // Migration: add attachments column to messages
  try {
    db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT")
  } catch { /* already exists */ }

  // Migration: add source column to sessions
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'Default'")
  } catch { /* already exists */ }

  // Migration: add started_at column to tasks
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN started_at TEXT")
  } catch { /* already exists */ }

  // Migration: add custom_providers & custom_models if created by newer code on old DB
  try {
    db.exec("CREATE TABLE IF NOT EXISTS custom_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_key TEXT NOT NULL UNIQUE, base_url TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '', models TEXT NOT NULL DEFAULT '[]', capabilities TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, is_preset INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))")
    db.exec("CREATE TABLE IF NOT EXISTS custom_models (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES custom_providers(id) ON DELETE CASCADE, model_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))")
    db.exec("CREATE INDEX IF NOT EXISTS idx_custom_models_provider ON custom_models(provider_id)")
    db.exec("CREATE INDEX IF NOT EXISTS idx_custom_providers_key ON custom_providers(provider_key)")
  } catch { /* already exists */ }

  // Migration: add notify_channel column to automations
  try {
    db.exec("ALTER TABLE automations ADD COLUMN notify_channel TEXT NOT NULL DEFAULT ''")
  } catch { /* already exists */ }

  // Migration: add role_id column to agent_memory (role-scoped memory isolation)
  try {
    db.exec("ALTER TABLE agent_memory ADD COLUMN role_id TEXT")
  } catch { /* already exists */ }

  // Migration: add role_name column to playbook (record which role executed the task)
  try {
    db.exec("ALTER TABLE playbook ADD COLUMN role_name TEXT DEFAULT ''")
  } catch { /* already exists */ }

  console.log('✅ Database initialized')
}

export function getDB(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.')
  return db
}
