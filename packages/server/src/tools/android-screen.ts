/**
 * android_screen — 手机端「眼睛」（2026-10-20）
 *
 * 存在理由：手机版 SUPERCRZY BOT 跑在 Alpine chroot 里，rootfs 本身没有 /system，
 * 开机脚本（supercrzy-bot-mobile/scripts/01-bot.sh）把 /system、/vendor 以**只读**
 * bind 方式挂进 chroot，于是 Android 的 screencap / uiautomator 可以直接调用。
 * 实测（X2 / LineageOS 16）：`screencap -p` 出 350KB PNG，`uiautomator dump` 出
 * ~600KB UI 树；两者都不需要 LD_LIBRARY_PATH（bind /vendor 后 gralloc HAL 就位）。
 *
 * 为什么还要 UI 树：模型光看图片路径无法定位坐标。uiautomator 的节点带
 * text / content-desc / bounds，直接给出「点哪里」的坐标，比 OCR 准且免费。
 *
 * 桌面端不存在 /system/bin/screencap → 明确提示，不做假成功。
 */
import type { ToolDef } from './types'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

const execFileP = promisify(execFile)
const SCREENCAP = '/system/bin/screencap'
const UIAUTOMATOR = '/system/bin/uiautomator'

/** 当前环境是否具备 Android 侧能力（供工具/状态判断复用） */
export function androidAvailable(): boolean {
  return existsSync(SCREENCAP)
}

/** 取 PNG 宽高：直接读 IHDR，不引第三方图像库 */
function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return { width: 0, height: 0 }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** 解析 uiautomator XML，挑出「模型用得上的」节点：有文字 / 有描述 / 可点击 */
function summarizeUi(xml: string, limit = 60): string[] {
  const attr = (tag: string, name: string): string => {
    const m = tag.match(new RegExp(`${name}="([^"]*)"`))
    return m ? m[1] : ''
  }
  const center = (bounds: string): string => {
    const m = bounds.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/)
    if (!m) return ''
    const cx = Math.round((Number(m[1]) + Number(m[3])) / 2)
    const cy = Math.round((Number(m[2]) + Number(m[4])) / 2)
    return `(${cx},${cy})`
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const tag of xml.match(/<node\b[^>]*>/g) || []) {
    const text = attr(tag, 'text')
    const desc = attr(tag, 'content-desc')
    const clickable = attr(tag, 'clickable') === 'true'
    const focused = attr(tag, 'focused') === 'true'
    const editable = attr(tag, 'class').includes('EditText')
    if (!text && !desc && !clickable && !editable) continue
    const label = text || desc
    const key = `${label}|${attr(tag, 'bounds')}`
    if (seen.has(key)) continue
    seen.add(key)
    const flags = [clickable ? '可点' : '', focused ? '聚焦' : '', editable ? '可输入' : '']
      .filter(Boolean).join('/')
    const pos = center(attr(tag, 'bounds'))
    const line = label
      ? `- "${label.slice(0, 40)}"${flags ? ` [${flags}]` : ''} ${pos}`
      : `- (无文字)${flags ? ` [${flags}]` : ''} ${pos}`
    out.push(line.trim())
    if (out.length >= limit) break
  }
  return out
}

const tool: ToolDef = {
  name: 'android_screen',
  description: '截取当前手机屏幕并可读回界面元素（含可点击坐标）。仅手机端可用；返回截图保存路径 + 屏幕尺寸 + 界面元素列表（文字/可点击/中心坐标），用于「看屏幕 → 决定点哪里」。',
  category: 'system',
  parameters: {
    type: 'object',
    properties: {
      with_ui: { type: 'boolean', description: '是否同时读界面元素（默认 true；只想看图时设 false，更快）' },
      max_elements: { type: 'number', description: '最多返回多少个界面元素，默认 60' },
    },
  },
  async execute(args) {
    if (!androidAvailable()) {
      return '❌ 当前不是手机端环境（找不到 /system/bin/screencap）。android_screen 只在 SUPERCRZY BOT 手机版（Alpine chroot + Android bind mount）里可用。'
    }
    const withUi = args.with_ui !== false
    const limit = Math.min(Math.max(Number(args.max_elements) || 60, 5), 200)

    let png: Buffer
    try {
      const tmp = `/tmp/scrz-shot-${Date.now()}.png`
      await execFileP(SCREENCAP, ['-p', tmp], { timeout: 20000 })
      png = readFileSync(tmp)
      try { unlinkSync(tmp) } catch { /* 临时文件删不掉不影响结果 */ }
    } catch (err: any) {
      return `❌ 截屏失败: ${err?.message || err}`
    }
    if (!png.length) return '❌ 截屏失败：screencap 输出为空（检查 /system、/vendor 是否已 bind）'

    const { width, height } = pngSize(png)
    const shotDir = join(process.cwd(), 'uploads', 'screenshots')
    const fname = `android-${Date.now()}.png`
    let fpath = join(shotDir, fname)
    try {
      if (!existsSync(shotDir)) mkdirSync(shotDir, { recursive: true })
      writeFileSync(fpath, png)
    } catch (err: any) {
      fpath = `/tmp/${fname}`
      try { writeFileSync(fpath, png) } catch { /* 内存里用完即弃 */ }
      return `📱 截图已生成（落盘失败: ${err?.message}）\n屏幕尺寸: ${width}x${height}`
    }

    let uiBlock = ''
    if (withUi) {
      try {
        const tmp = `/tmp/scrz-ui-${Date.now()}.xml`
        await execFileP(UIAUTOMATOR, ['dump', tmp], { timeout: 25000 })
        const xml = readFileSync(tmp, 'utf8')
        try { unlinkSync(tmp) } catch { /* ignore */ }
        const lines = summarizeUi(xml, limit)
        uiBlock = lines.length
          ? `\n界面元素（${lines.length} 个，坐标可直接用于 android_action tap）:\n${lines.join('\n')}`
          : '\n界面元素：未读到可交互节点（可能是视频/游戏画面）'
      } catch (err: any) {
        uiBlock = `\n（界面元素读取失败: ${err?.message || err}）`
      }
    }

    return `📱 截图已保存: ${fpath}\n屏幕尺寸: ${width}x${height}${uiBlock}`
  },
}

export default tool
