/**
 * video_edit — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { spawn } from 'child_process'
import { basename, join, resolve } from 'path'
import { scanDangerousPath, WORKSPACE_ROOT, assertSafeFilePath } from '../services/sandbox'
import { readSetting, escapeFfPath } from './shared'

const tool: ToolDef = {
  name: 'video_edit',
  description: '用 ffmpeg 处理视频/音频。支持 op：trim 裁剪(time_start/time_end)、concat 合并(inputs 数组)、convert 转码(含 codec)、compress 压缩/改分辨率(width/height/codec)、extract 抽帧(提取第 time 秒的一帧为 png, 需 output 以 .png 结尾)、subtitle 加字幕(subtitle_file)。input 为源文件路径，output 为输出路径(必须在工作区内)。结果写盘并上报产物。',
  category: 'system',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '本次剪辑目的的一句话说明（人读标题）' },
      op: { type: 'string', enum: ['trim', 'concat', 'convert', 'compress', 'extract', 'subtitle'], description: '剪辑操作' },
      input: { type: 'string', description: '单个源文件路径（绝对路径，在工作区内）' },
      inputs: { type: 'array', items: { type: 'string' }, description: 'concat 合并时的多个源文件路径' },
      output: { type: 'string', description: '输出文件路径（绝对路径，必须在工作区内）' },
      time_start: { type: 'string', description: 'trim/截取起始时间，如 00:01:30 或 90' },
      time_end: { type: 'string', description: 'trim/截取结束时间，如 00:02:00' },
      time: { type: 'string', description: 'extract 抽帧的秒/时刻，如 10 或 00:00:10' },
      width: { type: 'number', description: 'compress 目标宽度' },
      height: { type: 'number', description: 'compress 目标高度' },
      codec: { type: 'string', description: 'convert/compress 视频编码，如 libx264 / h264_nvenc' },
      fps: { type: 'number', description: 'compress 目标帧率' },
      subtitle_file: { type: 'string', description: 'subtitle 操作的字幕文件路径(.srt/.ass，工作区内)' },
    },
    required: ['description', 'op', 'output'],
  },
  async execute(args, ctx) {
    const op = String(args.op || '').trim()
    const output = String(args.output || '').trim()
    const cwd = ctx?.cwd || WORKSPACE_ROOT
    // ffmpeg 路径：设置 ffmpegPath 可自配，否则用内置 bin/ffmpeg（随包分发，用户免安装）
    const ffmpegPath = readSetting('ffmpegPath') || join(process.cwd(), 'bin', 'ffmpeg')
    // 输出路径必须在工作区（防越权写盘）
    try { assertSafeFilePath(output, { workspaceDir: cwd }) } catch (e: any) { return `❌ 输出路径不在允许的工作区: ${output}` }
    if (!op) return '❌ video_edit 需要 op 参数（trim/concat/convert/compress/extract/subtitle）'

    // 校验输入路径在工作区内
    const checkInput = (p: string) => {
      if (!p) return ''
      try { assertSafeFilePath(p, { workspaceDir: cwd }); return '' } catch (e: any) { return `输入路径不合法: ${p}` }
    }
    const err = (args.input ? checkInput(String(args.input)) : '') || (args.subtitle_file ? checkInput(String(args.subtitle_file)) : '')
    if (err) return `❌ ${err}`
    if (Array.isArray(args.inputs)) for (const p of args.inputs) { const e2 = checkInput(String(p)); if (e2) return `❌ ${e2}` }

    // 构建 ffmpeg 参数（用数组，不拼接 shell，防注入）
    const out = `-y ${output}`  // -y 覆盖
    const buildArgs = (): string[] => {
      const a = ['-y']
      const inputs = (Array.isArray(args.inputs) && args.inputs.length) ? args.inputs.map(String) : (args.input ? [String(args.input)] : [])
      for (const inp of inputs) { a.push('-i', inp) }
      switch (op) {
        case 'trim': {
          if (args.time_start) { a.push('-ss', String(args.time_start)) }
          if (args.time_end) { a.push('-to', String(args.time_end)) }
          a.push('-c', 'copy', output)
          break
        }
        case 'convert': case 'compress': {
          if (args.width && args.height) { a.push('-vf', `scale=${args.width}:${args.height}`) }
          else if (args.width) { a.push('-vf', `scale=${args.width}:-2`) }
          else if (args.height) { a.push('-vf', `scale=-2:${args.height}`) }
          if (args.fps) { a.push('-r', String(args.fps)) }
          if (args.codec) { a.push('-c:v', String(args.codec)) }
          if (op === 'compress' && !args.codec) { a.push('-c:v', 'libx264', '-crf', '23', '-preset', 'medium') }
          a.push(output)
          break
        }
        case 'extract': {
          const t = String(args.time || '5')
          a.push('-ss', t, '-vframes', '1', output)
          break
        }
        case 'subtitle': {
          if (args.subtitle_file) { a.push('-vf', `subtitles=${escapeFfPath(String(args.subtitle_file))}`) }
          a.push('-c', 'copy', output)
          break
        }
        case 'concat': {
          // 用 concat demuxer：生成 list 文件（inputs 每行 file '...'）
          const listPath = join(cwd, `.concat_${Date.now()}.txt`)
          require('fs').writeFileSync(listPath, (Array.isArray(args.inputs) ? args.inputs : []).map((p: any) => `file '${String(p).replace(/'/g, "\\'")}'`).join('\n'), 'utf-8')
          a.push('-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output)
          break
        }
        default: return []
      }
      return a
    }
    const ffArgs = buildArgs()
    if (!ffArgs.length) return `❌ 未知的 op: ${op}`
    const cmd = `${ffmpegPath} ${ffArgs.join(' ')}`
    const danger = scanDangerousPath(cmd, { level: ctx?.permissionLevel, workspaceDir: cwd })
    if (danger) return `❌ 已拦截（沙箱规则）: ${danger}`
    return new Promise((resolve) => {
      let buf = ''
      let errBuf = ''
      const stream = (c: string) => { if (ctx?.onOutput) ctx.onOutput('', c) }
      const child = spawn(ffmpegPath, ffArgs, { cwd, env: { ...process.env } as NodeJS.ProcessEnv })
      const killTimer = setTimeout(() => { child.kill(); resolve(`❌ 剪辑超时（>${Math.round((args.timeout||120000)/1000)}s），已终止`) }, args.timeout || 120000)
      child.stdout?.on('data', (d: Buffer) => { const s = d.toString(); buf += s; stream(s) })
      child.stderr?.on('data', (d: Buffer) => { const s = d.toString(); errBuf += s; stream(s) })
      child.on('error', (e) => { clearTimeout(killTimer); resolve(`❌ ffmpeg 启动失败: ${e.message}`) })
      child.on('close', (code) => {
        clearTimeout(killTimer)
        if (ctx?.onFileChange && op !== 'extract') { try { ctx.onFileChange(output, '', output) } catch {} }
        if (ctx?.onArtifacts) {
          try { ctx.onArtifacts([{ name: basename(output), path: output, action: 'created', size: require('fs').existsSync(output) ? require('fs').statSync(output).size : 0 }]) } catch {}
        }
        resolve(code === 0 ? `✅ 剪辑完成，输出: ${output}（${op}）` : `❌ ffmpeg 失败 (exit ${code}):\n${errBuf.slice(0, 1500) || buf.slice(0, 1500)}`)
      })
    })
  },
}

export default tool
