import Database from 'better-sqlite3'
import { existsSync, mkdirSync, copyFileSync } from 'fs'
import { dirname } from 'path'
import { config } from '../config'

let db: Database.Database

export function initDatabase() {
  const dbDir = dirname(config.db.path)
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  // 2026-08-26：数据迁移——若统一用户目录 DB 不存在，但旧的仓库内 data/supercrzy.db 有数据，则首次启动搬运一次。
  // 保证 Web 历史数据无缝过度到 ~/.supercrzy（App/Web 同机共享同一份）。
  if (!existsSync(config.db.path)) {
    const legacyCandidates = [
      // 仓库内旧位置（dev 相对 cwd 曾落在这）
      'data/supercrzy.db',
    ]
    for (const leg of legacyCandidates) {
      if (existsSync(leg)) {
        try {
          copyFileSync(leg, config.db.path)
          break
        } catch {}
      }
    }
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
      workspace_dir TEXT DEFAULT '',
      permission_level TEXT DEFAULT 'sandbox',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 工作区索引：最近打开的工作区（参考 WorkBuddy workspaces 表）
    CREATE TABLE IF NOT EXISTS workspaces (
      path TEXT PRIMARY KEY,
      last_opened_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL DEFAULT '',
      token_count INTEGER,
      cost REAL,
      elapsed_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      mime TEXT DEFAULT 'text/plain',
      size INTEGER DEFAULT 0,
      action TEXT DEFAULT 'created',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at);

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
      name_en TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      description_en TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general',
      enabled INTEGER NOT NULL DEFAULT 1,
      trigger_keywords TEXT NOT NULL DEFAULT '',
      prompt_template TEXT NOT NULL DEFAULT '',
      tools TEXT NOT NULL DEFAULT '[]',
      globs TEXT NOT NULL DEFAULT '[]',
      environments TEXT NOT NULL DEFAULT '',
      scoped_to TEXT NOT NULL DEFAULT '',
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
      event_trigger TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_automations_status ON automations(status);
    CREATE INDEX IF NOT EXISTS idx_automations_next_run ON automations(next_run_at);

    -- 例程（Routine）：把一次跑通的任务保存为可复用流程，一键重放（学 Grok"演示一次就学会"）
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL DEFAULT '[]',
      source_session_id TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_routines_name ON routines(name);

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
      name_en TEXT NOT NULL DEFAULT '',
      task_keywords TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_roles_enabled ON roles(enabled);

    -- MCP 连接器（用户自定义 MCP server：stdio 命令或 SSE/HTTP URL）
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'stdio',
      command TEXT NOT NULL DEFAULT '',
      args TEXT NOT NULL DEFAULT '[]',
      env TEXT NOT NULL DEFAULT '{}',
      url TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 渠道接入（原建在 routes/gateway.ts，2026-08-25 归位统一建表；旧库缺 error_message 列由 gateway initChannelsTable 的 ALTER 迁移）
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER DEFAULT 0, config TEXT DEFAULT '{}',
      status TEXT DEFAULT 'disconnected',
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Insert default settings
    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('apiKey', ''),
      ('model', ''),
      ('systemPrompt', 'You are a helpful assistant powered by SUPERCRZY BOT.'),
      ('temperature', '0.7'),
      ('maxTokens', '8192');

    -- Insert preset providers (13 channels, synced with client PREDEFINED)
    INSERT OR IGNORE INTO custom_providers (id, name, provider_key, base_url, api_key, models, capabilities, is_preset, sort_order) VALUES
      ('preset-ollama', 'Ollama (本地)', 'ollama', 'http://localhost:11434/v1', '', '[]', '["chat"]', 1, 0),
      ('preset-nvidia', 'NVIDIA NIM', 'nvidia', 'https://integrate.api.nvidia.com/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 1),
      ('preset-qwen', '阿里 Qwen', 'qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 2),
      ('preset-deepseek', 'DeepSeek', 'deepseek', 'https://api.deepseek.com', '', '[]', '["chat","reasoning","tool-calling"]', 1, 3),
      ('preset-openai', 'OpenAI', 'openai', 'https://api.openai.com/v1', '', '[]', '["chat","reasoning","tool-calling","vision"]', 1, 4),
      ('preset-openrouter', 'OpenRouter', 'openrouter', 'https://openrouter.ai/api/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 5),
      ('preset-anthropic', 'Anthropic', 'anthropic', 'https://api.anthropic.com', '', '[]', '["chat","reasoning","tool-calling","vision"]', 1, 6),
      ('preset-grok', 'xAI Grok', 'grok', 'https://api.x.ai/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 7),
      ('preset-gemini', 'Google Gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta', '', '[]', '["chat","reasoning","vision"]', 1, 8),
      ('preset-mistral', 'Mistral', 'mistral', 'https://api.mistral.ai/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 9),
      ('preset-zhipu', '智谱 GLM', 'zhipu', 'https://open.bigmodel.cn/api/paas/v4', '', '[]', '["chat","reasoning","tool-calling","vision"]', 1, 10),
      ('preset-kimi', 'Kimi / Moonshot', 'kimi', 'https://api.moonshot.cn/v1', '', '[]', '["chat","tool-calling"]', 1, 11),
      ('preset-mimo', '小米 MiMo', 'mimo', 'https://api.xiaomimimo.com/v1', '', '[]', '["chat","reasoning","tool-calling"]', 1, 12);
  `)

  // Migration: add attachments column to messages
  try {
    db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT")
  } catch { /* already exists */ }

  // Migration: add elapsed_ms column to messages（任务完成耗时，前端 done 事件写入）
  try {
    db.exec("ALTER TABLE messages ADD COLUMN elapsed_ms INTEGER")
  } catch { /* already exists */ }

  // Migration: add feedback column to messages（消息点赞/点踩，'up'/'down'/NULL）
  try {
    db.exec("ALTER TABLE messages ADD COLUMN feedback TEXT")
  } catch { /* already exists */ }

  // Migration: add source column to sessions
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'Default'")
  } catch { /* already exists */ }

  // Migration: add workspace_dir column to sessions（会话级工作目录）
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN workspace_dir TEXT DEFAULT ''")
  } catch { /* already exists */ }
  // Migration: add is_playground column to sessions（临时任务标记：新建对话=1，指定工作区=0）
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN is_playground INTEGER NOT NULL DEFAULT 0")
  } catch { /* already exists */ }
  // Migration: add permission_level column to sessions（默认权限三档：workspace-only/sandbox/full）
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN permission_level TEXT DEFAULT 'sandbox'")
  } catch { /* already exists */ }
  // Migration: add archived column to sessions（归档会话：移出主列表可恢复，对齐 GPT archiveConversation）
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
  } catch { /* already exists */ }
  // Migration: 超级协作平台——会话标记协作模式（NULL=普通对话，'semi'|'senate'=超级协作任务）
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN collab_mode TEXT")
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

  // Migration: add context_window column to custom_models（体验补强 1：上下文窗口按模型动态配置）
  try {
    db.exec("ALTER TABLE custom_models ADD COLUMN context_window INTEGER NOT NULL DEFAULT 128000")
  } catch { /* already exists */ }

  // Migration: add role_name column to playbook (record which role executed the task)
  try {
    db.exec("ALTER TABLE playbook ADD COLUMN role_name TEXT DEFAULT ''")
  } catch { /* already exists */ }

  // Migration: add name_en column to roles（角色英文名，供英文界面显示）
  try {
    db.exec("ALTER TABLE roles ADD COLUMN name_en TEXT NOT NULL DEFAULT ''")
  } catch { /* already exists */ }
  // Insert default roles (5 expert roles + default fallback) — 放迁移后执行，确保 name_en 列已存在
  try {
    db.exec(`INSERT OR IGNORE INTO roles (id, name, name_en, task_keywords, system_prompt, enabled, is_default, sort_order) VALUES
      ('role-design', '设计', 'Design', '设计,UI,UX,视觉,页面,界面,海报,logo,品牌,创意,草图,原型,配色,字体,布局,交互,figma,sketch,设计稿,切图', 'You are Crzy, the design expert of SUPERCRZY BOT. You excel at UI/UX design, visual design, brand identity, layout, typography, color systems, and creative ideation. When given a design task, think like a senior designer: clarify intent, propose a clear visual direction, and deliver concrete design outputs (structure, copy suggestions, visual specs, or implementation guidance). Use web search to research current design trends when needed. Respect the brand''s original-design principle and avoid emoji-based UI.', 1, 0, 10),
      ('role-dev', '开发', 'Development', '代码,开发,编程,修复,bug,报错,error,debug,前端,后端,接口,api,数据库,算法,脚本,函数,类,部署,构建,编译,测试,重构,优化,git,commit,push,pull,typescript,javascript,python,vue,node,koa,sql', 'You are the engineering expert of SUPERCRZY BOT. You excel at writing, debugging, and refactoring code, system architecture, and technical problem solving. When given a coding task: analyze the requirement, check existing code first (file_read), implement end-to-end, verify it runs, and report real output. Follow the project''s conventions: pnpm monorepo, TypeScript strict, no emoji in UI. Never fabricate results — run and show.', 1, 0, 20),
      ('role-data', '数据分析', 'Data Analysis', '数据,分析,统计,报表,图表,excel,表格,月报,复盘,业绩,销售额,预算,roi,转化率,趋势,指标,kpi,可视化,透视,汇总,同比,环比', 'You are the data analyst of SUPERCRZY BOT. You excel at analyzing data, building reports, spotting trends, and turning numbers into actionable insights. When given a data task: locate the data source (files, exports, or uploads), clean it, analyze with concrete numbers, and present findings in structured tables. Always back conclusions with specific figures — never vague generalizations.', 1, 0, 30),
      ('role-copy', '文案', 'Copywriting', '文案,写作,文章,报告,文档,方案,邮件,演讲稿,标题,广告语,简介,总结,润色,翻译,营销,brief,策划,脚本,内容', 'You are the copywriting expert of SUPERCRZY BOT. You excel at writing, editing, and polishing content: reports, articles, marketing copy, briefs, emails, and structured documents. When given a writing task: understand the audience first, use a clear structure (headings, tables, lists), match the required tone, and deliver complete polished output ready to use. Write in the user''s language unless specified.', 1, 0, 40),
      ('role-general', '通用', 'General', '', 'You are a helpful assistant powered by SUPERCRZY BOT.', 1, 1, 99)`)
  } catch { /* already exists */ }
  // 旧库补内置角色英文名（仅当 name_en 为空时）
  try {
    db.exec(`UPDATE roles SET name_en = CASE id
      WHEN 'role-design' THEN 'Design'
      WHEN 'role-dev' THEN 'Development'
      WHEN 'role-data' THEN 'Data Analysis'
      WHEN 'role-copy' THEN 'Copywriting'
      WHEN 'role-general' THEN 'General'
      ELSE name_en END
      WHERE name_en = ''`)
  } catch { /* ignore */ }

  // Migration: add name_en/description_en columns to skills（内置技能双语名，供英文界面显示）
  try {
    db.exec("ALTER TABLE skills ADD COLUMN name_en TEXT NOT NULL DEFAULT ''")
  } catch { /* already exists */ }
  try {
    db.exec("ALTER TABLE skills ADD COLUMN description_en TEXT NOT NULL DEFAULT ''")
  } catch { /* already exists */ }
  // Migration: P2 Skill Generation —— usage_count/last_used（180 天未用自动停用依据）
  try {
    db.exec("ALTER TABLE skills ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0")
  } catch { /* already exists */ }
  try {
    db.exec("ALTER TABLE skills ADD COLUMN last_used TEXT")
  } catch { /* already exists */ }
  // Migration: add globs/environments/scoped_to to skills（学 Grok AgentSkillMetadata）
  // globs=文件匹配模式（JSON 数组，命中当前工作区文件才激活）；environments=适用环境（node/python/all）；scoped_to=限定目录
  try {
    db.exec("ALTER TABLE skills ADD COLUMN globs TEXT NOT NULL DEFAULT '[]'")
  } catch { /* already exists */ }
  try {
    db.exec("ALTER TABLE skills ADD COLUMN environments TEXT NOT NULL DEFAULT ''")
  } catch { /* already exists */ }
  try {
    db.exec("ALTER TABLE skills ADD COLUMN scoped_to TEXT NOT NULL DEFAULT ''")
  } catch { /* already exists */ }
  // 旧库补内置技能英文名/描述（按中文名匹配）
  try {
    db.exec(`UPDATE skills SET
      name_en = CASE name
        WHEN '代码生成' THEN 'Code Generation'
        WHEN '文件操作' THEN 'File Operations'
        WHEN '网络搜索' THEN 'Web Search'
        WHEN 'Shell 执行' THEN 'Shell Execution'
        WHEN '浏览器自动化' THEN 'Browser Automation'
        WHEN '数据可视化' THEN 'Data Visualization'
        WHEN '文档写作' THEN 'Document Writing'
        WHEN '记忆管理' THEN 'Memory Management'
        ELSE name_en END,
      description_en = CASE name
        WHEN '代码生成' THEN 'Generate code from natural language descriptions, supporting multiple programming languages'
        WHEN '文件操作' THEN 'Read and write local files, manage project file structure'
        WHEN '网络搜索' THEN 'Search the internet for the latest information and resources'
        WHEN 'Shell 执行' THEN 'Execute shell commands to complete system tasks'
        WHEN '浏览器自动化' THEN 'Control the browser for web interaction and data collection'
        WHEN '数据可视化' THEN 'Convert data into charts and visualization reports'
        WHEN '文档写作' THEN 'Write technical documentation, README, API docs, etc.'
        WHEN '记忆管理' THEN 'Manage and query the agent long-term memory'
        ELSE description_en END
      WHERE name_en = ''`)
  } catch { /* ignore */ }
  // 旧库补内置技能 globs/environments（学 Grok AgentSkillMetadata：文件模式激活技能）
  try {
    db.exec(`UPDATE skills SET
      globs = CASE name
        WHEN '代码生成' THEN '["*.js","*.ts","*.py","*.go","*.rs","*.java","*.vue"]'
        WHEN '数据可视化' THEN '["*.csv","*.xlsx","*.json"]'
        WHEN '文档写作' THEN '["*.md","*.txt","README*"]'
        ELSE globs END,
      environments = CASE name
        WHEN '代码生成' THEN 'node,all'
        ELSE 'all' END
      WHERE globs = '[]' OR globs = ''`)
  } catch { /* ignore */ }

  // Migration: add event_trigger column to automations（事件触发自动化，学 Grok runAutomationForEvent）
  try {
    db.exec("ALTER TABLE automations ADD COLUMN event_trigger TEXT NOT NULL DEFAULT ''")
  } catch { /* already exists */ }

  // ===== P0.1 Memory FTS5 + Retrieval Ranking（2026-08-23 定稿规格）=====
  // 三列：confidence 置信度 / usage_count 使用次数 / last_used 最后使用（服务检索排序 + 淘汰 + Skill 升级）
  try {
    db.exec("ALTER TABLE agent_memory ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5")
  } catch { /* already exists */ }
  try {
    db.exec("ALTER TABLE agent_memory ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0")
  } catch { /* already exists */ }
  try {
    db.exec("ALTER TABLE agent_memory ADD COLUMN last_used TEXT")
  } catch { /* already exists */ }
  // 旧数据语义归类：fact → knowledge（FTS5 时代 category 四语义：general/user/knowledge/experience）
  try {
    db.exec("UPDATE agent_memory SET category = 'knowledge' WHERE category = 'fact'")
  } catch { /* ignore */ }
  // FTS5 虚拟表（content 表 + rowid + trigram 中文友好）与同步触发器
  // 每次启动 DROP 重建保证一致性（记忆量小，重建成本可忽略，避免 'delete' 回填的 malformed 风险）
  try {
    db.exec("DROP TRIGGER IF EXISTS agent_memory_fts_ai")
    db.exec("DROP TRIGGER IF EXISTS agent_memory_fts_ad")
    db.exec("DROP TRIGGER IF EXISTS agent_memory_fts_au")
    db.exec("DROP TABLE IF EXISTS agent_memory_fts")
    db.exec(`CREATE VIRTUAL TABLE agent_memory_fts USING fts5(
      key, content,
      content='agent_memory', content_rowid='rowid',
      tokenize='trigram'
    )`)
    db.exec(`CREATE TRIGGER agent_memory_fts_ai AFTER INSERT ON agent_memory BEGIN
      INSERT INTO agent_memory_fts(rowid, key, content) VALUES (new.rowid, new.key, new.content);
    END`)
    db.exec(`CREATE TRIGGER agent_memory_fts_ad AFTER DELETE ON agent_memory BEGIN
      INSERT INTO agent_memory_fts(agent_memory_fts, rowid, key, content) VALUES ('delete', old.rowid, old.key, old.content);
    END`)
    db.exec(`CREATE TRIGGER agent_memory_fts_au AFTER UPDATE ON agent_memory BEGIN
      INSERT INTO agent_memory_fts(agent_memory_fts, rowid, key, content) VALUES ('delete', old.rowid, old.key, old.content);
      INSERT INTO agent_memory_fts(rowid, key, content) VALUES (new.rowid, new.key, new.content);
    END`)
    // 全量回填已有数据到 FTS 索引
    db.exec("INSERT INTO agent_memory_fts(rowid, key, content) SELECT rowid, key, content FROM agent_memory")
  } catch (e: any) {
    console.warn('[db] FTS5 memory index init skipped:', e?.message || e)
  }
  // Migration: add scoped_to to skills（限定目录）已在上方 skills 迁移中处理

  console.log('✅ Database initialized')
}

export function getDB(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.')
  return db
}
