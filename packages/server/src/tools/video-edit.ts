/**
 * video_edit — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { spawn } from 'child_process'
import { basename, join, resolve } from 'path'
import { existsSync, statSync, writeFileSync, unlinkSync } from 'fs'
import { scanDangerousPath, WORKSPACE_ROOT, assertSafeFilePath } from '../services/sandbox'
import { readSetting, escapeFfPath } from './shared'
import { resolveFfmpeg, ffmpegInstallHint } from '../services/ffmpeg'

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
    // ffmpeg 路径（2026-09-20 修死链，2026-10-14 移除包内兜底）：
    // 解析链 = 设置项 ffmpegPath / 环境变量 FFMPEG_PATH → PATH → ~/.supercrzy/bin → 常见包管理器安装位，
    // 每个候选真跑一次 `-version` 探测，能执行才算数；全不可用则返回可照抄的安装提示。
    // 仓库不再内置 ffmpeg（旧内置件 x86_64 在 Apple Silicon 上不可用，且带 GPL 分发义务）。
    const explicit = readSetting('ffmpegPath') || process.env.FFMPEG_PATH || ''
    const ff = await resolveFfmpeg(explicit)
    if (!ff.path) {
      const tried = ff.tried.map(t => `  - ${t.path}: ${t.reason}`).join('\n')
      return `❌ ${ffmpegInstallHint()}\n已尝试：\n${tried}`
    }
    const ffmpegPath = ff.path
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
    // concat 生成的 list 临时文件：用完删掉，别在工作区里留垃圾
    let concatListPath = ''
    const buildArgs = (): string[] => {
      const inputs = (Array.isArray(args.inputs) && args.inputs.length) ? args.inputs.map(String) : (args.input ? [String(args.input)] : [])
      // 2026-09-20 修「trim 成功但产物是空壳」：-ss/-to 放在 -i 之后（输出侧定位）+ -c copy，
      // 实测得到的是 261 字节、没有任何流的空 mp4（退出码 0，看起来像成功）。
      // 放到 -i 之前（输入侧定位）才是正确写法：实测 12 帧 / 1.2s / 9KB。
      const seek: string[] = []
      if (op === 'trim') {
        if (args.time_start) seek.push('-ss', String(args.time_start))
        if (args.time_end) seek.push('-to', String(args.time_end))
      } else if (op === 'extract') {
        seek.push('-ss', String(args.time || '5'))
      }
      const a = ['-y', ...seek]
      for (const inp of inputs) { a.push('-i', inp) }
      switch (op) {
        case 'trim': {
          a.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', output)
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
          a.push('-vframes', '1', output)
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
          concatListPath = listPath
          // 2026-09-20：原来是 require('fs')，在 ESM（"type":"module"）下 require 未定义 → ReferenceError；
          // concat 分支抛错、其余分支的 onArtifacts 被 try{} 静默吞掉（产物永远上报不出来）。改为顶层 import。
          writeFileSync(listPath, (Array.isArray(args.inputs) ? args.inputs : []).map((p: any) => `file '${String(p).replace(/'/g, "\\'")}'`).join('\n'), 'utf-8')
          a.push('-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output)
          break
        }
        default: return []
      }
      return a
    }
    const ffArgs = buildArgs()
    if (!ffArgs.length) return `❌ 未知的 op: ${op}`
    // 2026-09-20：只扫描「参数」，不把可执行文件本身送进沙箱扫描。
    // 原因：解析到的 ffmpeg 可能在 ~/.supercrzy/bin 或 /opt/homebrew/bin（合法且必须放行），
    // 而 scanDangerousPath 会把 home 下的绝对路径一律判越权 —— 于是修好 ffmpeg 之后，
    // 工具反而被自己的沙箱拦死（实测报「路径越权: ~/.supercrzy/bin/ffmpeg」）。
    // 可执行文件本身已由 resolveFfmpeg 真跑 -version 验过；参数里的输入输出路径另有 assertSafeFilePath 兜底，
    // 这里再扫一层是纵深防御，不是唯一防线。
    const danger = scanDangerousPath(ffArgs.join(' '), { level: ctx?.permissionLevel, workspaceDir: cwd })
    if (danger) return `❌ 已拦截（沙箱规则）: ${danger}`
    // concat 的 list 文件用完即删（不管成功失败）
    const cleanupList = () => {
      if (!concatListPath) return
      try { if (existsSync(concatListPath)) unlinkSync(concatListPath) } catch {}
      concatListPath = ''
    }
    return new Promise((resolve) => {
      let buf = ''
      let errBuf = ''
      const stream = (c: string) => { if (ctx?.onOutput) ctx.onOutput('', c) }
      const child = spawn(ffmpegPath, ffArgs, { cwd, env: { ...process.env } as NodeJS.ProcessEnv })
      const killTimer = setTimeout(() => { child.kill(); cleanupList(); resolve(`❌ 剪辑超时（>${Math.round((args.timeout||120000)/1000)}s），已终止`) }, args.timeout || 120000)
      child.stdout?.on('data', (d: Buffer) => { const s = d.toString(); buf += s; stream(s) })
      child.stderr?.on('data', (d: Buffer) => { const s = d.toString(); errBuf += s; stream(s) })
      child.on('error', (e) => { clearTimeout(killTimer); cleanupList(); resolve(`❌ ffmpeg 启动失败: ${e.message}（${ffmpegPath}）`) })
      child.on('close', (code) => {
        clearTimeout(killTimer)
        cleanupList()
        if (ctx?.onFileChange && op !== 'extract') { try { ctx.onFileChange(output, '', output) } catch {} }
        if (ctx?.onArtifacts) {
          try { ctx.onArtifacts([{ name: basename(output), path: output, action: 'created', size: existsSync(output) ? statSync(output).size : 0 }]) } catch {}
        }
        // 退出码 0 不等于成功：ffmpeg 完全可能生成一个没有任何流的空壳文件（trim 参数顺序错时就是这样）。
        // 产物不存在或为 0 字节一律判失败，避免「模型以为剪辑成功了」。
        const outSize = existsSync(output) ? statSync(output).size : 0
        if (code === 0 && outSize === 0) {
          resolve(`❌ ffmpeg 退出 0 但产物为空（0 字节）: ${output}\n${errBuf.slice(0, 800)}`)
          return
        }
        resolve(code === 0 ? `✅ 剪辑完成，输出: ${output}（${op}，${outSize} 字节）` : `❌ ffmpeg 失败 (exit ${code}):\n${errBuf.slice(0, 1500) || buf.slice(0, 1500)}`)
      })
    })
  },
}

export default tool
