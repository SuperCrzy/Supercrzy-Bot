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
  requiresApproval: true,
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
      // 净变化量：**开始时一次算好**（old 已在上面读出、new 已完整到达）——
      // 过程里随分块缓动展示，不必等写完（G5：原本只在返回值里算，过程里一个数字都没有）
      const { added: addedFinal, deleted } = diffLines(oldContent, toWriteStr)
      // 实时「新增行数」计数器：把 oldContent 的行做成**可消耗的多重集**，按写入顺序逐行匹配，
      // 没匹配上的行即"这一版新增的行"。全程 O(N)，且**单调不减**（diffLines 是"行多重集交集"
      // 算法，|b| - common 随 b 前缀增长恒不减），末尾恒等于 addedFinal。
      // 为什么不逐块直接调 diffLines(old, prefix)：那是 O(N²/CHUNK)，5000 行文件 ≈ 200 万次 Map 操作。
      // ⚠️ deleted 与 added 不对称（deleted 全程显示终值）：|old| - common 是**单调递减**的，
      //    逐块展示会先跳出"−351"再缩到"−12"，看着像在撤销。宁可不"动"也不误导。
      const oldLinePool = new Map<string, number>()
      for (const l of oldContent ? oldContent.split('\n') : []) oldLinePool.set(l, (oldLinePool.get(l) || 0) + 1)
      let addedSoFar = 0
      const countAdded = (lines: string[]): number => {
        for (const l of lines) {
          const c = oldLinePool.get(l) || 0
          if (c > 0) oldLinePool.set(l, c - 1)
          else addedSoFar++
        }
        return addedSoFar
      }
      // 推送一块：结构化进度 + 代码块流式输出，两条通道各自独立判断。
      // ⚠️ 不再往数据流里塞 "📝 写入 N/M 行" 这类中文文案 —— 前端改读 onProgress，
      //    老路是"前端正则解析中文"，后端改一个字即静默失效（G5/I13，2026-09-24）
      const emitChunk = (chunkLines: string[], written: number) => {
        ctx?.onProgress?.('', {
          added: countAdded(chunkLines),
          deleted,
          done: written,
          total: totalLines,
          // 动词机器标识（不是文案）：新建 → 前端本地化成"创建"，改已有文件 → "编辑"。
          // 对齐 WorkBuddy tool.writeFile.{creating,create} / {editing,edit} 的动态动词推导
          phase: oldContent ? 'edit' : 'create',
        })
        if (!ctx?.onOutput) return
        ctx.onOutput('', `\`\`\`\n${chunkLines.join('\n')}\n\`\`\`\n`)
      }
      if (linesArr.length <= CHUNK) {
        await writeFile(path, toWriteStr, 'utf-8')
        if (totalLines > 1) emitChunk(linesArr, totalLines)
      } else {
        // 首块：writeFile
        const first = linesArr.slice(0, CHUNK)
        await writeFile(path, first.join('\n'), 'utf-8')
        emitChunk(first, CHUNK)
        await sleep(blockDelay)
        let idx = CHUNK
        while (idx < linesArr.length) {
          const chunk = linesArr.slice(idx, idx + CHUNK).join('\n')
          await appendFile(path, '\n' + chunk, 'utf-8')
          idx += CHUNK
          const written = Math.min(idx, totalLines)
          emitChunk(linesArr.slice(Math.max(0, idx - CHUNK), idx), written)
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
      // ⚠️ addedFinal/deleted 已在流式推送前算好，此处直接复用，不重复计算；
      //    过程里 countAdded 累出来的 addedSoFar 末尾恒等于 addedFinal
      return oldContent
        ? `✅ 文件已更新：${path} (${args.content.length} 字符, +${addedFinal}/-${deleted} 行)`
        : `✅ 文件已创建：${path} (${args.content.length} 字符, ${addedFinal} 行)`
    } catch (err: any) {
      return `❌ 写入文件失败：${err.message}`
    }
  },
}

export default tool
