/**
 * shell_exec — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { rm } from 'fs/promises'
import { exec, spawn } from 'child_process'
import { resolve } from 'path'
import { scanDangerousPath, sandboxify, WORKSPACE_ROOT } from '../services/sandbox'
import { scanDirFiles, diffFileSnapshots } from './shared'

const tool: ToolDef = {
  name: 'shell_exec',
  description: '执行 Shell 命令并获取输出。仅限只读/查询类命令（查看、搜索、测试、构建）。**严禁用 echo/cat/heredoc 等命令写文件或改文件**——写文件请用 file_write 工具。输出限制 8000 字符。**必须提供 description 参数**：用一句话说明本命令要做什么（如"运行查看 deeplink.ts 实际位置"），前端用它作为命令卡片标题。',
  category: 'system',
  requiresApproval: true,
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '本命令目的的一句话说明（人类可读标题，如"查看 ChatView.vue 的滚动逻辑"）' },
      command: { type: 'string', description: '要执行的Shell命令' },
      timeout: { type: 'number', description: '超时毫秒数，默认30000' },
    },
    required: ['command', 'description'],
  },
  async execute(args, ctx) {
    // L1 危险命令黑名单：无条件拦截（即使已确认也禁止）
    const cmd = String(args.command || '').trim()
    const BLOCKED = [
      /rm\s+-rf\s+\/\s*(\s|$)/,            // 删除根目录
      /\bmkfs\b/, /\bdd\s+if=/, /\bshutdown\b/, /\breboot\b/,
      /\bsudo\b/, /\brm\s+-rf\s+~/, /\bchmod\s+-R\s+777\s+\//,
      /:[\(\|][:\|]\{/,                      // fork 炸弹
      /\b(curl|wget)\b.*\|\s*(ba)?sh\b/,    // 下载即执行
      /\bbase64\s+-d\b.*\|\s*(ba)?sh\b/,
    ]
    for (const pattern of BLOCKED) {
      if (pattern.test(cmd)) {
        return `❌ 已拦截危险命令（禁止执行）: ${cmd.slice(0, 80)}`
      }
    }

    // L2 软沙箱：危险路径扫描（.ssh/.aws/.env、home 白名单外绝对路径等，按会话权限档位）
    const danger = scanDangerousPath(cmd, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd })
    if (danger) {
      return `❌ 已拦截（沙箱规则）: ${danger}\n命令: ${cmd.slice(0, 80)}`
    }

    // L3 硬沙箱：sandbox-exec 内核级隔离（不可用时自动降级，仍保留 L1/L2）
    const sb = await sandboxify(cmd)
    if (!sb.sandboxed && sb.reason) {
      console.warn(`[Sandbox] ${sb.reason}，命令以软沙箱保护执行: ${cmd.slice(0, 60)}`)
    }

    // 产物快照：执行前扫描工作目录（命令可能生成/修改文件 → 补录产物）
    const scanRoot = ctx?.cwd || WORKSPACE_ROOT
    const beforeSnap = ctx?.onArtifacts ? scanDirFiles(scanRoot) : null

    return new Promise((resolve) => {
      const timeout = args.timeout || 30000
      // 会话级工作目录：AI 在用户指定的文件夹里执行命令（默认项目工作区）
      const cwd = ctx?.cwd || WORKSPACE_ROOT
      // 流式执行：spawn 分片输出（tool_output SSE 实时推送），同时收集完整输出做最终结果
      let stdoutBuf = ''
      let stderrBuf = ''
      const stream = (chunk: string) => {
        if (ctx?.onOutput) ctx.onOutput('', chunk)
      }
      const finish = (code: number | null, signal: string | null, spawnErr?: Error) => {
        // 执行后对比：命令产生的文件补录为产物
        if (beforeSnap && ctx?.onArtifacts) {
          try {
            const afterSnap = scanDirFiles(scanRoot)
            const arts = diffFileSnapshots(beforeSnap, afterSnap)
            if (arts.length > 0) ctx.onArtifacts(arts)
          } catch {}
        }
        if (spawnErr) {
          resolve(`❌ 命令启动失败: ${spawnErr.message}`)
        } else if (code !== 0) {
          // 部分成功回传（主流实现 isPartial 同款）：失败也保留已产生的部分输出
          resolve(`❌ 命令执行失败 (exit code ${code}):\n${stderrBuf || '无错误输出'}${stdoutBuf ? `\n--- 已产生的部分输出 ---\n${stdoutBuf.slice(0, 4000)}` : ''}`)
        } else {
          const output = stdoutBuf + (stderrBuf ? `\n[stderr]\n${stderrBuf}` : '')
          resolve(output.slice(0, 8000) || '(无输出)')
        }
      }
      const opts = { cwd, env: { ...process.env } as NodeJS.ProcessEnv }
      const child = (sb.sandboxed && sb.args)
        ? spawn(sb.exec, sb.args, opts)
        : spawn(cmd, { ...opts, shell: true })
      const killTimer = setTimeout(() => { child.kill(); finish(-1, null) }, timeout)
      child.stdout?.on('data', (d: Buffer) => { const s = d.toString(); stdoutBuf += s; stream(s) })
      child.stderr?.on('data', (d: Buffer) => { const s = d.toString(); stderrBuf += s; stream(s) })
      child.on('error', (err) => { clearTimeout(killTimer); finish(-1, null, err) })
      child.on('close', (code, signal) => { clearTimeout(killTimer); finish(code, signal) })
    })
  },
}

export default tool
