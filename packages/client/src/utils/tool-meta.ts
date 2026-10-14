/**
 * 工具图标 + 友好名称注册表（对齐主流实现 tool-icon-registry / tool-name-map）
 *
 * 主流实现 原版：normalizeName（小写去下划线连字符）→ exactMatch → prefixMatch（按长度降序）→ FALLBACK
 * 图标集：Eye/Pencil/Terminal/Search/Folder/Globe/Trash/Wrench(FALLBACK) + Check/Clipboard/Cloud/Database/Debug/Grid/Image/Send/Sparkle
 * 我们：SVG 描边风格（项目设计语言），图标类型 → 组件内渲染
 */

/** 图标类型（ToolCallBlock 内按类型渲染对应 SVG） */
export type ToolIconType =
  | 'cmd' | 'read' | 'write' | 'search' | 'lint' | 'web' | 'draw'
  | 'git' | 'task' | 'skill' | 'memory' | 'ask' | 'plan' | 'computer'
  | 'folder' | 'trash' | 'image' | 'sparkle' | 'database' | 'cloud' | 'grid' | 'default'

export interface ToolMeta {
  icon: ToolIconType
  /** 友好名称 i18n key（toolName 归一化后匹配） */
  nameKey: string
}

/** 精确匹配表（key 为归一化后形式：小写去下划线连字符）——对齐主流实现 exactMatchMap */
const EXACT_MAP: Record<string, ToolMeta> = {
  // ── 读取（Eye）──
  read: { icon: 'read', nameKey: 'chat.toolRead' },
  fileread: { icon: 'read', nameKey: 'chat.toolRead' },
  fileexists: { icon: 'read', nameKey: 'chat.toolRead' },
  readlints: { icon: 'lint', nameKey: 'chat.toolLint' },
  // ── 写入/编辑（Pencil）──
  write: { icon: 'write', nameKey: 'chat.toolWrite' },
  edit: { icon: 'write', nameKey: 'chat.toolEdit' },
  filewrite: { icon: 'write', nameKey: 'chat.toolWrite' },
  replaceinfile: { icon: 'write', nameKey: 'chat.toolEdit' },
  appendtofile: { icon: 'write', nameKey: 'chat.toolWrite' },
  // ── 命令（Terminal）──
  bash: { icon: 'cmd', nameKey: 'chat.toolCmd' },
  powershell: { icon: 'cmd', nameKey: 'chat.toolCmd' },
  shellexec: { icon: 'cmd', nameKey: 'chat.toolCmd' },
  executecommand: { icon: 'cmd', nameKey: 'chat.toolCmd' },
  // ── 搜索（Search）──
  glob: { icon: 'search', nameKey: 'chat.toolSearchFile' },
  grep: { icon: 'search', nameKey: 'chat.toolSearchCode' },
  searchfiles: { icon: 'search', nameKey: 'chat.toolSearchFile' },
  codesearch: { icon: 'search', nameKey: 'chat.toolSearchCode' },
  // ── lint（调试）──
  lintfile: { icon: 'lint', nameKey: 'chat.toolLint' },
  // ── 网页（Globe）──
  websearch: { icon: 'web', nameKey: 'chat.toolWebSearch' },
  webfetch: { icon: 'web', nameKey: 'chat.toolWebFetch' },
  // ── 图表（Grid/Draw）──
  drawdiagram: { icon: 'draw', nameKey: 'chat.toolDraw' },
  // ── 提问 ──
  askquestion: { icon: 'ask', nameKey: 'chat.toolAsk' },
  askuser: { icon: 'ask', nameKey: 'chat.toolAsk' },
  // ── 计划 ──
  createplan: { icon: 'plan', nameKey: 'chat.toolPlan' },
  // ── 文件列表（Folder）──
  listfiles: { icon: 'folder', nameKey: 'chat.toolListFiles' },
  listdir: { icon: 'folder', nameKey: 'chat.toolListFiles' },
  // ── 删除（Trash）──
  deletefiles: { icon: 'trash', nameKey: 'chat.toolDeleteFile' },
  deletefile: { icon: 'trash', nameKey: 'chat.toolDeleteFile' },
  // ── 图片（Image）──
  imagegen: { icon: 'image', nameKey: 'chat.toolImageGen' },
  // ── 记忆（Database）──
  memoryrecall: { icon: 'memory', nameKey: 'chat.toolMemory' },
  // ── 技能（Sparkle）──
  skilllist: { icon: 'skill', nameKey: 'chat.toolSkill' },
}

/** 前缀匹配（归一化后 startsWith，按长度降序——长前缀优先，对齐主流实现 prefixEntries.sort） */
const PREFIX_MAP: Array<{ prefix: string; meta: ToolMeta }> = ([
  { prefix: 'shellexec', meta: { icon: 'cmd', nameKey: 'chat.toolCmd' } },
  { prefix: 'filewrite', meta: { icon: 'write', nameKey: 'chat.toolWrite' } },
  { prefix: 'fileread', meta: { icon: 'read', nameKey: 'chat.toolRead' } },
  { prefix: 'fileedit', meta: { icon: 'write', nameKey: 'chat.toolEdit' } },
  { prefix: 'filedelete', meta: { icon: 'trash', nameKey: 'chat.toolDeleteFile' } },
  { prefix: 'filesearch', meta: { icon: 'search', nameKey: 'chat.toolSearchFile' } },
  { prefix: 'file', meta: { icon: 'write', nameKey: 'chat.toolWrite' } },
  { prefix: 'web', meta: { icon: 'web', nameKey: 'chat.toolWebSearch' } },
  { prefix: 'git', meta: { icon: 'git', nameKey: 'chat.toolGit' } },
  { prefix: 'task', meta: { icon: 'task', nameKey: 'chat.toolTask' } },
  { prefix: 'skill', meta: { icon: 'skill', nameKey: 'chat.toolSkill' } },
  { prefix: 'memory', meta: { icon: 'memory', nameKey: 'chat.toolMemory' } },
  { prefix: 'computer', meta: { icon: 'computer', nameKey: 'chat.toolComputer' } },
  { prefix: 'image', meta: { icon: 'image', nameKey: 'chat.toolImageGen' } },
  { prefix: 'draw', meta: { icon: 'draw', nameKey: 'chat.toolDraw' } },
  { prefix: 'ask', meta: { icon: 'ask', nameKey: 'chat.toolAsk' } },
  { prefix: 'plan', meta: { icon: 'plan', nameKey: 'chat.toolPlan' } },
] as Array<{ prefix: string; meta: ToolMeta }>).sort((a, b) => b.prefix.length - a.prefix.length)

/** 兜底（主流实现 WrenchIcon 同款：工具图标=扳手） */
const FALLBACK: ToolMeta = { icon: 'default', nameKey: 'chat.toolUnknown' }

/** 归一化：小写 + 去除下划线/连字符（"ToolSearch"/"tool_search"/"tool-search" → "toolsearch"） */
function normalizeToolName(name: string): string {
  return (name || '').toLowerCase().replace(/[_-]/g, '')
}

/** 解析工具元信息：精确 → 前缀（长优先）→ 兜底 */
export function resolveToolMeta(toolName: string): ToolMeta {
  if (!toolName) return FALLBACK
  const normalized = normalizeToolName(toolName)
  const exact = EXACT_MAP[normalized]
  if (exact) return exact
  for (const { prefix, meta } of PREFIX_MAP) {
    if (normalized.startsWith(prefix)) return meta
  }
  return FALLBACK
}
