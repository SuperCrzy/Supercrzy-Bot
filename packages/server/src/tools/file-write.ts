/**
 * file_write — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import { open, rename, rm } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import type { ToolDef } from './types'
import { readFile } from 'fs/promises'
import { assertSafeFilePath } from '../services/sandbox'
import { resolvePath, diffLines } from './shared'
import { registerArtifact } from './write-artifact'

/**
 * Write a file so that a crash leaves either the old content or the new one.
 *
 * A plain writeFile truncates first and then writes the new bytes, so a crash or a
 * kill mid-write leaves a partially written file — the original is already gone. The
 * fix is the standard one: write a sibling temp file, flush it to disk, then rename
 * over the target. rename(2) within a filesystem is atomic, so readers see one
 * version or the other, never a half-written file.
 *
 * fsync matters: without it the rename can be durable while the data is not, which
 * on a power loss yields an empty file with the right name.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const staged = `${path}.${randomUUID().slice(0, 8)}.tmp`
  const handle = await open(staged, 'w', 0o600)
  try {
    await handle.writeFile(data, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(staged, path)
  } catch (error) {
    // A stray temp file would be litter, and on a failed rename the original is
    // still intact — drop the staged copy and report the real error.
    await rm(staged, { force: true }).catch(() => {})
    throw error
  }
}

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
    // Validate before touching the filesystem. Coercing a missing value to an
    // empty string used to truncate existing files and only then report failure.
    if (!args || typeof args.path !== 'string' || !args.path.trim() || typeof args.content !== 'string') {
      return '❌ 写入文件失败：必须提供文件路径和文本内容（空字符串可用于清空文件）。'
    }
    const path = resolvePath(args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    try {
      // 变更对比：写入前读旧内容（存在则 diff 显示"修改"，不存在则是"新增"）
      let oldContent = ''
      let existedBefore: boolean | undefined
      try { oldContent = await readFile(path, 'utf-8'); existedBefore = true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') existedBefore = false; else throw error }
      // 写文件格式化（P2-3，主流实现 formatters 同款）：JSON 自动规范化缩进（无依赖安全；JS/TS 等需 prettier 暂缓）
      let toWrite = String(args.content ?? '')
      if (/\.json$/i.test(path)) {
        try { toWrite = JSON.stringify(JSON.parse(toWrite), null, 2) + '\n' } catch { /* 非法 JSON 保持原样 */ }
      }
      const toWriteStr = String(toWrite ?? '')
      const totalLines = toWriteStr.split('\n').length
      const { added: addedFinal, deleted } = diffLines(oldContent, toWriteStr)
      if (ctx?.shouldStop?.()) return '❌ 已请求停止，文件未写入。'
      // One write removes the deliberate delays that previously left the file
      // truncated between chunks. This does not make a disk write crash-atomic.
      await writeFileAtomic(path, toWriteStr)
      // Report actual completion; display failures cannot undo a successful write.
      try {
        ctx?.onProgress?.('', { added: addedFinal, deleted, done: totalLines, total: totalLines, phase: existedBefore ? 'edit' : 'create' })
      } catch { /* progress is presentation only */ }
      if (ctx?.onOutput && totalLines > 1) {
        const preview = toWriteStr.slice(0, 1024 * 1024)
        for (let idx = 0; idx < preview.length; idx += 16_000) {
          try { ctx.onOutput('', `\`\`\`\n${preview.slice(idx, idx + 16_000)}\n\`\`\`\n`) } catch { break }
        }
        if (toWriteStr.length > preview.length) {
          try { ctx.onOutput('', '\n[输出已截断，完整内容已写入文件]\n') } catch { /* display only */ }
        }
      }
      const warnings: string[] = []
      // Once the write has succeeded, notification failures must not make the
      // caller think that the file was untouched and retry it blindly.
      if (ctx?.onPreview && /\.(html?|css|js)$/i.test(path)) {
        try { ctx.onPreview(path, toWriteStr.slice(0, 200000)) } catch { warnings.push('预览通知失败') }
      }
      if (ctx?.onFileChange) {
        try { ctx.onFileChange(path, oldContent, toWriteStr, existedBefore) } catch { warnings.push('变更记录通知失败') }
      }
      // Register only after the write succeeds.
      registerArtifact(ctx, path, {
        action: existedBefore ? 'updated' : 'created',
        size: Buffer.byteLength(toWriteStr, 'utf8'),
      })
      // 行数统计（主流实现 addedLines/deletedLines 同款）：diff 新增/删除行
      // ⚠️ addedFinal/deleted 已在流式推送前算好，此处直接复用，不重复计算；
      //    过程里 countAdded 累出来的 addedSoFar 末尾恒等于 addedFinal
      const result = existedBefore
        ? `✅ 文件已更新：${path} (${args.content.length} 字符, +${addedFinal}/-${deleted} 行)`
        : `✅ 文件已创建：${path} (${args.content.length} 字符, ${addedFinal} 行)`
      return warnings.length ? `${result}\n⚠️ ${warnings.join('；')}，请检查相关面板。` : result
    } catch (err: any) {
      return `❌ 写入文件失败：${err.message}`
    }
  },
}

export default tool
