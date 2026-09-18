/**
 * 按需工具名册 + 常驻上限 + 定义目录（P1-03 残余迁移，2026-09-18）
 *
 * 为什么单独成文件：`tool_search` 要迁到 tools/tool-search.ts，它需要读
 * DEFERRED_TOOLS 与"全部工具定义"。但全部定义装配在 services/tools.ts，
 * 若直接 import 会形成
 *     services/tools.ts → tools/registry.ts → tools/tool-search.ts → services/tools.ts
 * 的运行时循环。故把这两样数据下沉到本文件（无反向依赖），
 * 定义目录用"装配后注入"的方式拿到，tool-search 侧只通过 getToolCatalog() 惰性读取。
 *
 * 依赖方向：tools/* → tools/deferred（叶子），services/tools.ts → tools/deferred（注入者）。
 */

/**
 * 按需工具集合（不常驻 schema，模型先 tool_search 发现再调用）。
 * 取舍依据见 services/tools.ts 常驻契约注释。
 */
export const DEFERRED_TOOLS = new Set<string>([
  // ---- 重型生成类：参数多、调用少，最该按需 ----
  'generate_image',
  'video_edit',
  'make_article',
  'draw_diagram',
  // ---- 交互式外部环境：需要 Chrome / 桌面权限，且是长流程 ----
  'browser',
  'computer_use',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  // ---- 扩展能力：技能与记忆（记忆已自动注入上下文，显式检索属按需） ----
  'skill_list', 'skill_search', 'skill_view', 'skill_install',
  'memory_store', 'memory_recall', 'memory_list',
  // ---- 仓库操作：git 三件套（带风险/低频） ----
  'git_status', 'git_diff', 'git_commit',
  // ---- 补充调查类：不作为主干（web_search 已常驻） ----
  'news_search',
  'read_me',
  // ---- 文件辅助：容易被 file_read/file_write/shell_exec 覆盖 ----
  'file_exists', 'file_delete', 'lint_file',
  // ---- 计划辅助：create_plan/task_create/task_update 已常驻，其余按需 ----
  'get_goal', 'task_list',
  // ---- 提问：与常驻的 ask_user 语义重复（同一条前端提问链路），按需即可 ----
  'ask_question',
])

/**
 * 常驻工具数上限（报告指标：普通任务默认注入工具数 ≤ 12）。
 * 改 DEFERRED_TOOLS 时若把常驻数顶超，validateAlwaysOnContract 会直接报错。
 */
export const MAX_ALWAYS_ON_TOOLS = 12

/** 定义目录条目：tool_search 只用到 name + description */
export interface CatalogEntry {
  name: string
  description?: string
}

let catalog: CatalogEntry[] = []

/** 由 services/tools.ts 在装配完 toolDefinitions 后调用（模块初始化末尾） */
export function setToolCatalog(defs: CatalogEntry[]): void {
  catalog = defs
}

/** 惰性读取定义目录（不再 import services/tools.ts，避免循环依赖） */
export function getToolCatalog(): CatalogEntry[] {
  return catalog
}
