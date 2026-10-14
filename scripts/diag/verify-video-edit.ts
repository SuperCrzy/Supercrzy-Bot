/**
 * video_edit 端到端验收（2026-09-20）
 *
 * 目的：证明「video_edit 死链」真的修好了——不是单测绿就算数，而是让工具真跑一遍 ffmpeg。
 * 做法：先用解析到的 ffmpeg 造一段 3 秒测试视频，再让 video_edit 跑 extract（抽帧）与 trim（裁剪），
 * 检查产物文件真实存在且非空。
 *
 * 运行（在 packages/server 下）：
 *   node ../../node_modules/tsx/dist/cli.mjs ../../scripts/diag/verify-video-edit.ts
 */
import { mkdirSync, existsSync, statSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { spawn } from 'child_process'
import tool from '../../packages/server/src/tools/video-edit'
import { resolveFfmpeg } from '../../packages/server/src/services/ffmpeg'

function run(bin: string, args: string[]): Promise<{ code: number; err: string; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    let out = ''
    c.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    c.stderr?.on('data', (d: Buffer) => { err += d.toString() })
    c.on('error', () => resolve({ code: -1, err: 'spawn error', out: '' }))
    c.on('close', (code) => resolve({ code: code ?? -1, err, out: out.trim() }))
  })
}

async function main() {
  const ff = await resolveFfmpeg()
  console.log(`[1] 解析到 ffmpeg: ${ff.path || '(无)'}`)
  if (!ff.path) {
    console.log('❌ 本机没有可用 ffmpeg，video_edit 仍然是死链')
    for (const t of ff.tried) console.log(`    - ${t.path}: ${t.reason}`)
    process.exit(1)
  }

  // 工作目录必须落在工作区内（沙箱约束），用完删除
  const dir = join(process.cwd(), '.diag-video')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const src = join(dir, 'src.mp4')
  const frame = join(dir, 'frame.png')
  const clipped = join(dir, 'clip.mp4')

  console.log('[2] 生成 3 秒测试视频...')
  const gen = await run(ff.path, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-pix_fmt', 'yuv420p', src])
  if (gen.code !== 0 || !existsSync(src)) {
    console.log(`❌ 生成测试视频失败: ${gen.err.slice(0, 300)}`)
    process.exit(1)
  }
  console.log(`    src.mp4 = ${statSync(src).size} bytes`)

  console.log('[3] video_edit → extract（抽第 1 秒的帧）...')
  const r1 = await (tool as any).execute(
    { description: 'diag extract', op: 'extract', input: src, output: frame, time: '1' },
    { cwd: dir }
  )
  console.log(`    ${String(r1).slice(0, 200)}`)

  console.log('[4] video_edit → trim（裁 0~1 秒）...')
  const r2 = await (tool as any).execute(
    { description: 'diag trim', op: 'trim', input: src, output: clipped, time_start: '0', time_end: '1' },
    { cwd: dir }
  )
  console.log(`    ${String(r2).slice(0, 200)}`)

  const okFrame = existsSync(frame) && statSync(frame).size > 0
  // trim 的验收标准不是「文件存在」——空壳 mp4 也存在。必须有真实帧。
  let frames = -1
  const ffprobe = join(dirname(ff.path), 'ffprobe')
  if (existsSync(ffprobe)) {
    const p = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', clipped])
    frames = Number.isFinite(parseInt(p.out, 10)) ? parseInt(p.out, 10) : -1
  }
  const okClip = existsSync(clipped) && statSync(clipped).size > 1000 && (frames === -1 || frames >= 1)
  console.log('\n===== 结果 =====')
  console.log(`extract 产物 frame.png : ${okFrame ? `✅ ${statSync(frame).size} bytes` : '❌ 缺失/空'}`)
  console.log(`trim    产物 clip.mp4  : ${okClip ? `✅ ${statSync(clipped).size} bytes, ${frames} 帧` : `❌ 空壳或缺失（${existsSync(clipped) ? statSync(clipped).size : 'missing'} bytes, ${frames} 帧）`}`)

  rmSync(dir, { recursive: true, force: true })
  process.exit(okFrame && okClip ? 0 : 1)
}

main()
