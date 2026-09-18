/**
 * 工具共享辅助（P1-03 残余迁移的前置步骤，2026-09-18）
 *
 * 背景：services/tools.ts 里的 9 个辅助函数原本是文件内私有函数，被"仍留在 tools.ts 的
 * 18 个工具执行器"使用。这些执行器要迁到 tools/*.ts 独立文件，辅助函数就必须先变成
 * 可跨文件 import 的模块，否则迁移只能靠复制粘贴（那等于制造新的双写）。
 *
 * 本文件是纯粹的位置移动：函数体逐字未改，行为完全一致。
 * 依赖方向 tools/* → tools/shared → services/*，不反向依赖 services/tools.ts，
 * 避免循环 import。
 */
import { getDB } from '../services/database'
import { upsertMemory } from '../services/memory-service'
import { WORKSPACE_ROOT } from '../services/sandbox'
import { exec } from 'child_process'
import { readdirSync, statSync } from 'fs'
import { basename, join } from 'path'

/** 读取 settings 表配置（如 tavilyApiKey），空值返回 '' */
export function readSetting(key: string): string {
  try {
    const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row?.value ? String(row.value).trim() : ''
  } catch {
    return ''
  }
}

/**
 * ffmpeg 滤镜路径转义（字幕等路径含冒号/引号需转义，避免被 ffmpeg 解析成 URL/参数）
 */
export function escapeFfPath(p: string): string {
  return String(p).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * 扫描目录下文件快照（深度 ≤2，跳过 node_modules/.git/dist 等）：
 * 用于 shell 执行前后对比，识别命令产生/修改的文件
 */
export function scanDirFiles(root: string): Map<string, { mtime: number; size: number }> {
  const out = new Map<string, { mtime: number; size: number }>()
  const skip = new Set(['node_modules', '.git', 'dist', '.next', '.cache', '.turbo'])
  const walk = (dir: string, depth: number) => {
    if (depth > 2) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(full, depth + 1)
      } else if (e.isFile()) {
        try {
          const st = statSync(full)
          out.set(full, { mtime: st.mtimeMs, size: st.size })
        } catch {}
      }
    }
  }
  walk(root, 0)
  return out
}

/** 对比两次快照，返回新增/修改的文件 */
export function diffFileSnapshots(
  before: Map<string, { mtime: number; size: number }>,
  after: Map<string, { mtime: number; size: number }>
): Array<{ name: string; path: string; action: 'created' | 'updated'; size: number }> {
  const arts: Array<{ name: string; path: string; action: 'created' | 'updated'; size: number }> = []
  for (const [p, info] of after) {
    const b = before.get(p)
    if (!b) {
      arts.push({ name: basename(p), path: p, action: 'created', size: info.size })
    } else if (Math.abs(b.mtime - info.mtime) > 100 || b.size !== info.size) {
      arts.push({ name: basename(p), path: p, action: 'updated', size: info.size })
    }
  }
  return arts.slice(0, 20)
}

/**
 * 解析文件工具路径：相对路径基于会话工作目录（或默认工作区）解析成绝对路径
 */
export function resolvePath(p: string, cwd?: string): string {
  if (!p) return p
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return p
  return join(cwd || WORKSPACE_ROOT, p)
}

/**
 * 记忆内容敏感凭据模式：命中即拒绝明文入库。
 * 覆盖 API Key / Secret / 密码 / 私钥 / Bearer 等常见凭据形态，
 * 刻意不含裸 "token"（避免误伤 "token 数/用量" 等合法语境）。
 */
export const SENSITIVE_MEMORY_PATTERN =
  /(app[_-]?secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|password|passwd|passphrase|私钥|密钥|auth(?:orization)?\s*[:=]\s*bearer|BEGIN\s+[A-Z\s]*PRIVATE\s+KEY)/i

/** 执行 git 命令（工作目录执行，输出截断防刷屏；学 Grok AgenticGitAction 的 git 工具封装） */
export function runGit(cmd: string, cwd: string | undefined, label: string): Promise<string> {
  return new Promise((resolve) => {
    const dir = cwd || WORKSPACE_ROOT
    exec(cmd, { cwd: dir, timeout: 15000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      const out = (stdout || '').trim()
      const err = (stderr || '').trim()
      if (error) {
        resolve(`❌ ${label}失败: ${err || error.message || 'unknown'} `.slice(0, 400))
        return
      }
      resolve(`${label}完成:\n${(out || err || '(无输出)').slice(0, 800)}`)
    })
  })
}

/**
 * 记忆入库核心（工具侧入口）。
 *
 * 2026-09-18：去重/归一/时间格式的实现**全部下沉到 `services/memory-service.upsertMemory`**，
 * 本函数只负责把结构化结果翻译成工具给模型看的中文反馈。
 * 此前这里是独立的一份实现（同 key 同内容跳过 / 同 key 覆盖），与 memory-sync、reflection、
 * agent 正则抽取各写一套，彼此行为不一致（默认 importance 3 vs 5、category 不归一）。
 */
export function storeMemory(db: any, key: string, content: string, category?: string, importance?: number): string {
  const r = upsertMemory(db, { key, content, category, importance })
  switch (r.action) {
    case 'inserted':
      return `✅ 记忆已存储：${r.key}`
    case 'updated':
      return `✅ 记忆已更新（同 key 覆盖旧值）：${r.key}`
    case 'unchanged':
      return `✅ 记忆已存在（同 key 同内容），自动去重跳过：${r.key}`
    default:
      return `⛔ 记忆未存储：${r.reason || '入参非法'}`
  }
}

/** lint_file 静态检查规则：危险模式 / 凭据 / 括号配对粗检（复用技能安全扫描思路） */
export function lintContent(content: string, filePath: string): Array<{ severity: 'error' | 'warning'; line: number; message: string }> {
  const lines = content.split('\n')
  const diags: Array<{ severity: 'error' | 'warning'; line: number; message: string }> = []
  const push = (line: number, severity: 'error' | 'warning', message: string) => {
    diags.push({ severity, line: line + 1, message })
  }
  // 高危：删除根目录/家目录、远程脚本管道执行、反弹 shell、磁盘覆写
  const DANGER: Array<[RegExp, string]> = [
    [/rm\s+-(r|rf|fr)[^|\n]*\s+(\/|\$HOME|~)/, '删除根目录或家目录'],
    [/curl[^|\n]*\|\s*(ba|da)?sh\b/, 'curl 管道执行远程脚本'],
    [/wget[^|\n]*\|\s*(ba|da)?sh\b/, 'wget 管道执行远程脚本'],
    [/base64\s*-d[^|\n]*\|\s*(ba|da)?sh\b/, 'base64 解码后管道执行'],
    [/nc\s+-[^|\n]*\s*-e\b/, 'netcat 反弹 shell'],
    [/mkfs|dd\s+if=.*of=\/dev\//, '格式化/覆写磁盘'],
    [/chmod\s+777\s+(\/|\$HOME|~)/, '对根目录/家目录放权'],
  ]
  // 中危：凭据/待办/权限
  const WARN: Array<[RegExp, string]> = [
    [/sudo\s+rm/, 'sudo 删除（高风险）'],
    [/chmod\s+777\b/, '权限放宽 chmod 777'],
    [/\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASS)\}?/i, '引用环境变量凭据'],
    [/['"][A-Za-z0-9_-]{24,}['"]/, '疑似硬编码密钥/Token'],
    [/TODO|FIXME|HACK/, '遗留待办标记'],
    [/console\.log/, '遗留调试日志 console.log'],
  ]
  lines.forEach((l, i) => {
    for (const [re, msg] of DANGER) if (re.test(l)) push(i, 'error', msg)
    for (const [re, msg] of WARN) if (re.test(l)) push(i, 'warning', msg)
  })
  // 括号配对粗检（js/ts/py 等代码文件；字符串内括号可能误报，仅提示）
  const ext = (filePath.split('.').pop() || '').toLowerCase()
  if (['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'vue', 'py', 'go', 'rs', 'java', 'c', 'cpp'].includes(ext)) {
    const pairs: Array<[string, string, string]> = [
      ['(', ')', '圆括号'],
      ['{', '}', '花括号'],
      ['[', ']', '方括号'],
    ]
    for (const [open, close, name] of pairs) {
      let depth = 0
      for (let i = 0; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === open) depth++
          else if (ch === close) depth--
          if (depth < 0) {
            push(i, 'error', `多余的${name}闭合`)
            depth = 0
          }
        }
      }
      if (depth > 0) push(Math.max(0, lines.length - 1), 'warning', `${name}未闭合（剩余 ${depth} 个）`)
    }
  }
  return diags.slice(0, 50)
}

// 行数 diff：对比新旧文本，返回新增/删除行数（WorkBuddy addedLines/deletedLines 同款算法）
export function diffLines(oldTxt: string, newTxt: string): { added: number; deleted: number } {
  const a = oldTxt ? oldTxt.split('\n') : []
  const b = newTxt ? newTxt.split('\n') : []
  const counter = new Map<string, number>()
  for (const l of a) counter.set(l, (counter.get(l) || 0) + 1)
  let common = 0
  for (const l of b) {
    const c = counter.get(l) || 0
    if (c > 0) { common++; counter.set(l, c - 1) }
  }
  return { added: Math.max(0, b.length - common), deleted: Math.max(0, a.length - common) }
}
