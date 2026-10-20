/**
 * android_action — 手机端「手」（2026-10-20）
 *
 * 通过 Android 的 `input` 命令操作真实界面：点击 / 长按 / 滑动 / 按键 / 输入文字。
 * 前提同 android_screen：开机脚本把 /system、/vendor 只读 bind 进 chroot。
 *
 * 安全边界（为什么 requiresApproval = true）：
 *  - 这一步真的会动用户的手机界面 —— 可能误触拨号、转账、删除。
 *  - 参数全部走 execFile 数组传参（不过 shell），并对坐标做范围校验，
 *    对 input text 做字符白名单，避免拼出额外命令。
 */
import type { ToolDef } from './types'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'

const execFileP = promisify(execFile)
const INPUT = '/system/bin/input'

/** X2 的物理分辨率上限；超出视为参数错误，避免点击落到莫名其妙的位置 */
const MAX_COORD = 4000

function coord(v: unknown, name: string): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > MAX_COORD) {
    throw new Error(`${name} 必须是 0~${MAX_COORD} 的数字，收到: ${String(v)}`)
  }
  return Math.round(n)
}

function duration(v: unknown, def: number): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 1 || n > 30000) return def
  return Math.round(n)
}

/** `input text` 的空格要用 %s；其余只放行可见 ASCII 与中文，杜绝 % 之外的元字符 */
function sanitizeText(raw: string): string {
  return raw.replace(/\s/g, '%s').replace(/[^\w\u4e00-\u9fff%.,!?@:_+\-*/()\[\]]/g, '')
}

const tool: ToolDef = {
  name: 'android_action',
  description: '操作手机界面：点击(tap)、长按(long_press)、滑动(swipe)、按键(key, 如 BACK/HOME/ENTER)、输入文字(text)。坐标来自 android_screen 返回的界面元素。仅手机端可用，调用前需用户确认。',
  category: 'system',
  requiresApproval: true,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: '动作：tap / long_press / swipe / key / text' },
      x: { type: 'number', description: 'tap/long_press 的横坐标' },
      y: { type: 'number', description: 'tap/long_press 的纵坐标' },
      x1: { type: 'number', description: 'swipe 起点横坐标' },
      y1: { type: 'number', description: 'swipe 起点纵坐标' },
      x2: { type: 'number', description: 'swipe 终点横坐标' },
      y2: { type: 'number', description: 'swipe 终点纵坐标' },
      duration_ms: { type: 'number', description: 'long_press/swipe 持续时间毫秒（默认 长按 600 / 滑动 300）' },
      key: { type: 'string', description: '按键名或键码：BACK / HOME / ENTER / 或数字键码' },
      text: { type: 'string', description: '要输入的文字（需先点中输入框）' },
    },
    required: ['action'],
  },
  async execute(args) {
    if (!existsSync(INPUT)) {
      return '❌ 当前不是手机端环境（找不到 /system/bin/input）。android_action 只在 SUPERCRZY BOT 手机版里可用。'
    }
    const action = String(args.action || '').trim()
    let argv: string[] = []
    let summary = ''
    try {
      switch (action) {
        case 'tap': {
          const x = coord(args.x, 'x'), y = coord(args.y, 'y')
          argv = ['tap', String(x), String(y)]
          summary = `点击 (${x},${y})`
          break
        }
        case 'long_press': {
          const x = coord(args.x, 'x'), y = coord(args.y, 'y')
          const ms = duration(args.duration_ms, 600)
          argv = ['swipe', String(x), String(y), String(x), String(y), String(ms)]
          summary = `长按 (${x},${y}) ${ms}ms`
          break
        }
        case 'swipe': {
          const x1 = coord(args.x1, 'x1'), y1 = coord(args.y1, 'y1')
          const x2 = coord(args.x2, 'x2'), y2 = coord(args.y2, 'y2')
          const ms = duration(args.duration_ms, 300)
          argv = ['swipe', String(x1), String(y1), String(x2), String(y2), String(ms)]
          summary = `滑动 (${x1},${y1}) → (${x2},${y2}) ${ms}ms`
          break
        }
        case 'key': {
          const k = String(args.key || '').trim().toUpperCase()
          if (!/^[A-Z0-9_]+$/.test(k)) throw new Error(`key 只能是 KEYCODE 名或数字，收到: ${k}`)
          const name = /^\d+$/.test(k) ? k : k.startsWith('KEYCODE_') ? k : `KEYCODE_${k}`
          argv = ['keyevent', name]
          summary = `按键 ${name}`
          break
        }
        case 'text': {
          const t = sanitizeText(String(args.text || ''))
          if (!t) throw new Error('text 为空（或不含可输入字符）')
          argv = ['text', t]
          summary = `输入文字（${t.length} 字符）`
          break
        }
        default:
          return `❌ 不支持的 action: ${action}（可选 tap / long_press / swipe / key / text）`
      }
      await execFileP(INPUT, argv, { timeout: 15000 })
      return `✅ ${summary}`
    } catch (err: any) {
      return `❌ ${summary || action} 执行失败: ${err?.message || err}`
    }
  },
}

export default tool
