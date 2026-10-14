/**
 * multi_edit — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { readFile, writeFile } from 'fs/promises'
import { assertSafeFilePath } from '../services/sandbox'
import { resolvePath, diffLines } from './shared'

const tool: ToolDef = {
  name: 'multi_edit',
  description: '对同一文件做多处精确替换（一次调用完成多处修改，比多次 file_write 高效）。每处用 old_str 定位、new_str 替换，全部成功后统一写入。',
  category: 'file',
  requiresApproval: true,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '文件绝对路径' },
      edits: {
        type: 'array',
        description: '修改列表',
        items: {
          type: 'object',
          properties: {
            old_str: { type: 'string', description: '要查找的原文片段（必须精确匹配）' },
            new_str: { type: 'string', description: '替换后的新片段' },
          },
          required: ['old_str', 'new_str'],
        },
      },
    },
    required: ['file_path', 'edits'],
  },
  async execute(args, ctx) {
    const path = resolvePath(args.file_path || args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    const edits = Array.isArray(args.edits) ? args.edits : []
    if (edits.length === 0) return '❌ 缺少 edits 数组（[{old_str, new_str}]）'
    try {
      const oldContent = await readFile(path, 'utf-8')
      let content = oldContent
      let applied = 0
      // 累计净变化（G5，2026-09-24）：每处替换内联 diff 后累加 —— 局部 diff 比整体重算省，
      // 语义也更直白（"这一共加了多少行、删了多少行"）
      let cumAdded = 0
      let cumDeleted = 0
      const results: Array<{ old_str: string; new_str: string; status: 'applied' | 'not_found' }> = []
      for (const [i, e] of edits.entries()) {
        const oldStr = String(e.old_str ?? '')
        const newStr = String(e.new_str ?? '')
        if (!oldStr) {
          // 空 old_str = 无定位追加
          results.push({ old_str: '', new_str: newStr, status: 'applied' })
          applied++
        } else if (content.includes(oldStr)) {
          content = content.replace(oldStr, newStr)
          const d = diffLines(oldStr, newStr)
          cumAdded += d.added
          cumDeleted += d.deleted
          results.push({ old_str: oldStr, new_str: newStr, status: 'applied' })
          applied++
        } else {
          results.push({ old_str: oldStr, new_str: newStr, status: 'not_found' })
        }
        // 逐处进度（G5/I13）：让状态行实时显示 +N −M 与"第几处"。
        // 🔴 **保原子性**：此刻**尚未写盘**（下面仍是一次性 writeFile），
        //    所以进度反映的是「内存中已应用处数」，**不是「已落盘」** ——
        //    中途失败时文件仍保持原样（这是老板 2026-09-24 明确选择保留的性质）。
        ctx?.onProgress?.('', {
          added: cumAdded,
          deleted: cumDeleted,
          done: i + 1,
          count: edits.length,
          // 动词机器标识：multi_edit 恒为改已有文件
          phase: 'edit',
        })
      }
      if (applied === 0) return '❌ 所有修改片段均未找到（内容可能已变化），文件未改动'
      await writeFile(path, content, 'utf-8')
      // 推送 diff 数据（前端 FileDiffViewer 展示改前/改后）
      ctx?.onFileChange?.(path, oldContent, content)
      return `✅ 已应用 ${applied}/${edits.length} 处修改：${path}（${oldContent.length} → ${content.length} 字符，${results.filter((r) => r.status === 'applied').length} 处成功）`
    } catch (err: any) {
      return `❌ 编辑文件失败：${err.message}`
    }
  },
}

export default tool
