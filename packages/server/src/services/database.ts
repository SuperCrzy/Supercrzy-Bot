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

    -- Insert default settings
    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('apiKey', ''),
      ('model', 'deepseek-v4-pro'),
      ('systemPrompt', 'You are a helpful assistant powered by SuperCrzy.'),
      ('temperature', '0.7'),
      ('maxTokens', '8192');

    -- Insert preset providers
    INSERT OR IGNORE INTO custom_providers (id, name, provider_key, base_url, api_key, models, capabilities, is_preset, sort_order) VALUES
      ('preset-deepseek', 'DeepSeek', 'deepseek', 'https://api.deepseek.com', '', '["deepseek-v4-pro","deepseek-v4-flash","deepseek-v3.2","deepseek-v3.2-speciale","deepseek-chat","deepseek-r1","deepseek-r1-0528"]', '["chat","reasoning","tool-calling"]', 1, 0),
      ('preset-openai', 'OpenAI', 'openai', 'https://api.openai.com/v1', '', '["gpt-4o","gpt-4o-mini","gpt-4.1","o4-mini","o3"]', '["chat","reasoning","tool-calling","vision"]', 1, 1),
      ('preset-anthropic', 'Anthropic', 'anthropic', 'https://api.anthropic.com', '', '["claude-sonnet-4-20250514","claude-opus-4-20250514","claude-haiku-3.5"]', '["chat","reasoning","tool-calling","vision"]', 1, 2),
      ('preset-glm', '智谱 GLM', 'glm', 'https://open.bigmodel.cn/api/paas/v4', '', '["glm-4.7","glm-4-plus","glm-4-flash"]', '["chat","reasoning","tool-calling","vision"]', 1, 3),
      ('preset-kimi', 'Kimi / Moonshot', 'kimi', 'https://api.moonshot.cn/v1', '', '["moonshot-v1-8k","moonshot-v1-32k","moonshot-v1-128k"]', '["chat","tool-calling"]', 1, 4),
      ('preset-minimax', 'MiniMax', 'minimax', 'https://api.minimax.chat/v1', '', '["abab7-chat","abab6.5s-chat"]', '["chat","reasoning","tool-calling"]', 1, 5),
      ('preset-hunyuan', '腾讯混元', 'hunyuan', 'https://api.hunyuan.cloud.tencent.com/v1', '', '["hunyuan-turbos-latest","hunyuan-pro","hunyuan-lite"]', '["chat","tool-calling"]', 1, 6),
      ('preset-ollama', 'Ollama (本地)', 'ollama', 'http://localhost:11434/v1', '', '[]', '["chat"]', 1, 7),
      ('preset-custom', '自定义 API', 'custom', '', '', '[]', '["chat"]', 1, 8);
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

  console.log('✅ Database initialized')
}

export function getDB(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.')
  return db
}
