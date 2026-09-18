/**
 * file_write — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { readFile, writeFile, appendFile } from 'fs/promises'
import { assertSafeFilePath } from '../services/sandbox'
import { resolvePath, diffLines } from './shared'

const tool: ToolDef = {
  name: 'file_write',
  description: '写入/创建文件到本地磁盘（支持流式行数进度显示）。**写文件必须使用本工具**——不要用 shell_exec 通过 echo/cat/heredoc 等命令写文件；shell_exec 只用于执行命令。',
  category: 'file',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      content: { type: 'string', description: '要写入的内容' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const path = resolvePath(args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    try {
      // 变更对比：写入前读旧内容（存在则 diff 显示"修改"，不存在则是"新增"）
      let oldContent = ''
      try { oldContent = await readFile(path, 'utf-8') } catch { /* 新文件 */ }
      // 写文件格式化（P2-3，WorkBuddy formatters 同款）：JSON 自动规范化缩进（无依赖安全；JS/TS 等需 prettier 暂缓）
      let toWrite = String(args.content ?? '')
      if (/\.json$/i.test(path)) {
        try { toWrite = JSON.stringify(JSON.parse(toWrite), null, 2) + '\n' } catch { /* 非法 JSON 保持原样 */ }
      }
      // 写文件流式化（ChatGPT 同款：写入过程代码实时"长出来"）：分块写入 + onOutput 推送代码内容
      // 每块 25 行 flush，推送带行号进度的代码块 → 前端工具卡片流式区显示行号代码视图（打字机滚动）
      const toWriteStr = String(toWrite ?? '')
      const totalLines = toWriteStr.split('\n').length
      const CHUNK = 12
      const linesArr = toWriteStr.split('\n')
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      // 打字节奏：按块数自适应（ChatGPT 是模型流式天然慢，我们参数一次性到达需模拟）——
      // 块数多则块间快（不拖慢大文件），块数少则块间慢（小文件肉眼可见逐块滚动）
      const numBlocks = Math.max(1, Math.ceil(totalLines / CHUNK))
      const blockDelay = Math.min(200, Math.max(45, Math.round(1400 / numBlocks)))
      // 推送一块代码（带进度头），模拟 ChatGPT 边写边显示
      const emitChunk = (chunkLines: string[], written: number, isFirst: boolean, isLast: boolean) => {
        if (!ctx?.onOutput) return
        const head = `📝 写入 ${written}/${totalLines} 行\n`
        // 代码块格式：进度行 + ``` 代码块（前端按行渲染）
        ctx.onOutput('', `${head}\`\`\`\n${chunkLines.join('\n')}\n\`\`\`\n`)
        void isFirst
        void isLast
      }
      if (linesArr.length <= CHUNK) {
        await writeFile(path, toWriteStr, 'utf-8')
        if (ctx?.onOutput && totalLines > 1) emitChunk(linesArr, totalLines, true, true)
      } else {
        // 首块：writeFile
        const first = linesArr.slice(0, CHUNK)
        await writeFile(path, first.join('\n'), 'utf-8')
        emitChunk(first, CHUNK, true, false)
        await sleep(blockDelay)
        let idx = CHUNK
        while (idx < linesArr.length) {
          const chunk = linesArr.slice(idx, idx + CHUNK).join('\n')
          await appendFile(path, '\n' + chunk, 'utf-8')
          idx += CHUNK
          const written = Math.min(idx, totalLines)
          emitChunk(linesArr.slice(Math.max(0, idx - CHUNK), idx), written, false, written >= totalLines)
          if (written < totalLines) await sleep(blockDelay)
        }
      }
      // 实时预览：写入 html/css/js → 推送给前端（前端收集文件集后内联渲染，支持配套 CSS/JS）
      if (ctx?.onPreview && /\.(html?|css|js)$/i.test(path)) {
        ctx.onPreview(path, String(args.content || '').slice(0, 200000))
      }
      // 变更数据：带 old_str 供前端 diff 对比（变更 tab 显示"改前/改后"）
      if (ctx?.onFileChange) {
        ctx.onFileChange(path, oldContent, String(args.content || ''))
      }
      // 行数统计（WorkBuddy addedLines/deletedLines 同款）：diff 新增/删除行
      const { added, deleted } = diffLines(oldContent, String(args.content || ''))
      return oldContent
        ? `✅ 文件已更新：${path} (${args.content.length} 字符, +${added}/-${deleted} 行)`
        : `✅ 文件已创建：${path} (${args.content.length} 字符, ${added} 行)`
    } catch (err: any) {
      return `❌ 写入文件失败：${err.message}`
    }
  },
}

export default tool
