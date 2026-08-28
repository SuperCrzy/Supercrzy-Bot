/**
 * 工具渲染器注册表（WorkBuddy toolRendererRegistry + matchPriority 同款）。
 *
 * 目标：工具名 → 渲染分支 key 的单一事实来源。新增工具渲染只需注册一行，
 * 不再改 ToolCallBlock 的 v-if 链。匹配顺序：EXACT（精确名）→ PREFIX（前缀长优先）→ MATCH（函数）→ generic。
 *
 * 对齐 WorkBuddy ToolMatchPriority：NONE=0 / DEFAULT=1 / EXACT=10。
 */

/** 渲染分支 key（ToolCallBlock 模板按 key 分发到对应渲染器组件） */
export type ToolRendererKey =
  | 'command'     // shell_exec 命令卡片（终端图标 + 输出）
  | 'lint'        // lint_file / read_lints 诊断列表
  | 'read-me'     // read_me 可视化指南卡片（VisualizerReadMeCard）
  | 'web-fetch'   // web_fetch 网页卡片（WebFetchCard，一行 header + 结构化展开）
  | 'multi-edit'  // multi_edit 多文件编辑（MultiEditDiffViewer）
  | 'read-file'   // 读文件（文件名可点击定位行号）
  | 'write-file'  // 写/编辑文件（动词推导 + diff 视图）
  | 'generic'     // 通用兜底（参数 + 结果折叠展示）

interface RegistryEntry {
  key: ToolRendererKey
  /** 精确匹配工具名（camelCase + snake_case 都登记，对齐 WorkBuddy toolIconEntries） */
  names?: string[]
  /** 前缀匹配（如 Supabase* / mcp__*） */
  prefixes?: string[]
  /** 自定义函数匹配（返回 true 命中） */
  match?: (name: string) => boolean
}

const REGISTRY: RegistryEntry[] = [
  {
    key: 'command',
    names: ['shell_exec', 'bash', 'powershell', 'execute_command', 'run_command', 'run_terminal_cmd', 'Bash', 'PowerShell'],
  },
  {
    key: 'lint',
    names: ['lint_file', 'read_lints'],
  },
  {
    key: 'read-me',
    names: ['read_me', 'visualize:read_me', 'visualizer:read_me', 'visualizer:read_me_tool'],
  },
  {
    key: 'web-fetch',
    names: ['web_fetch', 'webfetch', 'WebFetch', 'fetch_web_page'],
  },
  {
    key: 'multi-edit',
    names: ['multi_edit', 'MultiEdit'],
  },
  {
    key: 'read-file',
    names: ['file_read', 'read_file', 'fileread', 'read', 'Read', 'notebook_read'],
  },
  {
    key: 'write-file',
    names: ['file_write', 'file_edit', 'write_to_file', 'replace_in_file', 'append_to_file', 'filewrite', 'fileedit', 'Write', 'Edit'],
  },
]

/** 归一化工具名（小写 + 去分隔符，对齐 WorkBuddy normalizeName） */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.:]/g, '')
}

/** 精确匹配表：normalize 后工具名 → key */
const EXACT_MAP: Map<string, ToolRendererKey> = new Map()
for (const entry of REGISTRY) {
  for (const n of entry.names || []) EXACT_MAP.set(normalizeName(n), entry.key)
}

/** 前缀匹配表（长前缀优先） */
const PREFIX_LIST: Array<{ prefix: string; key: ToolRendererKey }> = []
for (const entry of REGISTRY) {
  for (const p of entry.prefixes || []) PREFIX_LIST.push({ prefix: normalizeName(p), key: entry.key })
}
PREFIX_LIST.sort((a, b) => b.prefix.length - a.prefix.length)

/**
 * 解析工具名 → 渲染分支 key。
 * 命中顺序：精确（EXACT）→ 前缀（长优先）→ 函数匹配 → generic 兜底。
 */
export function resolveToolRendererKey(toolName: string): ToolRendererKey {
  const name = toolName || ''
  const norm = normalizeName(name)
  if (norm) {
    const exact = EXACT_MAP.get(norm)
    if (exact) return exact
    for (const { prefix, key } of PREFIX_LIST) {
      if (norm.startsWith(prefix)) return key
    }
  }
  for (const entry of REGISTRY) {
    if (entry.match?.(name)) return entry.key
  }
  return 'generic'
}

/** 是否读文件类（语义判定：header 状态词/行号定位用，不依赖渲染分支） */
export function isReadFileTool(toolName: string): boolean {
  return ['file_read', 'file_exists', 'read', 'Read', 'fileread'].includes(toolName || '')
}

/** 是否写/编辑文件类（语义判定：动词推导/行数统计/diff 用） */
export function isWriteFileTool(toolName: string): boolean {
  return ['file_write', 'file_edit', 'write_to_file', 'replace_in_file', 'append_to_file', 'filewrite', 'fileedit'].includes(toolName || '')
}

/** 写文件是否新建（file_write/append → 生成；file_edit/replace/multi_edit → 修改） */
export function isWriteNewTool(toolName: string): boolean {
  return ['file_write', 'append_to_file'].includes(toolName || '')
}
