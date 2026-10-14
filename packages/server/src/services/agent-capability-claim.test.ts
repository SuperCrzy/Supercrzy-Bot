/**
 * 能力声明守卫（I11 / #5，2026-10-14）
 *
 * 规则：**提示词里的能力声明必须由真实状态生成，不能写死。**
 *
 * 反例（本轮修掉的）：`video_edit` 曾被无条件写成可用能力
 *   `- **[按需]** make_article / video_edit: 内容工厂 / 视频剪辑`
 * 而它的前置依赖（本机可用的 ffmpeg）当时必然不满足（包内那份是 x86_64，
 * Apple Silicon 上 execve 直接 EBADARCH）⇒ 系统主动推荐一个必错的工具，
 * 模型选了就错、用户看到的是"BOT 连视频都不会剪"。
 *
 * 这条守卫锁的是渲染函数的**三态语义**，不是"某一行文本"：
 *   true  = 探测到可用 → 正常列出
 *   false = 探测到不可用 → 不列为能力 + 给出可照抄的安装指引
 *   null  = 尚未探测 → 列出但显式标注前置条件（保守：宁可少说不可说错）
 */
import { describe, it, expect } from 'vitest'

import { contentFactoryPromptLine, setupCapabilityLines } from './agent'
import { ffmpegInstallHint } from './ffmpeg'

const HINT = '（占位安装指引）'

/** 旧实现硬编码在提示词里的九个渠道名 —— 一个都不许再无条件出现 */
const HARDCODED_CHANNEL_NAMES = [
  'Telegram', 'QQ', '微信', '钉钉', '飞书', 'Slack', 'Discord', '企业微信',
]

const BASE = {
  model: 'deepseek-v4-pro',
  memoryEnabled: true,
  memoriesCount: 3,
  skillsCount: 210,
  channels: [] as Array<{ platform?: string; name?: string }>,
  automationsCount: 0,
  mcpServersCount: 0,
}

describe('I11：能力声明必须由真实表生成', () => {
  it('channels 为空 ⇒ 提示词里不含任何渠道名（backlog 验收①）', () => {
    const text = setupCapabilityLines(BASE).join('\n')
    for (const n of HARDCODED_CHANNEL_NAMES) {
      expect(text, `channels 表为空，提示词却出现了渠道「${n}」`).not.toContain(n)
    }
    expect(text, 'channels 为空时不该出现"已接入渠道"这一条').not.toContain('已接入渠道')
  })

  it('channels 非空 ⇒ 只列**真实接入**的名字（取自表，不是写死的清单）', () => {
    const text = setupCapabilityLines({
      ...BASE,
      channels: [{ platform: 'telegram', name: 'TG 主号' }, { platform: 'slack', name: '' }],
    }).join('\n')
    expect(text).toContain('已接入渠道')
    expect(text, '应使用表里的 name').toContain('TG 主号')
    expect(text, 'name 为空时应回退 platform').toContain('slack')
    expect(text, '未接入的渠道名不得出现').not.toContain('钉钉')
  })

  it('automations / mcp_servers 为 0 ⇒ 对应声明整条不出现（backlog 验收②）', () => {
    const zero = setupCapabilityLines(BASE).join('\n')
    expect(zero).not.toContain('自动化任务')
    expect(zero).not.toContain('MCP 服务')

    const some = setupCapabilityLines({ ...BASE, automationsCount: 2, mcpServersCount: 1 }).join('\n')
    expect(some).toContain('自动化任务')
    expect(some).toContain('MCP 服务')
  })

  it('skills 为 0 ⇒ 不声称技能系统', () => {
    expect(setupCapabilityLines({ ...BASE, skillsCount: 0 }).join('\n')).not.toContain('技能系统')
    expect(setupCapabilityLines({ ...BASE, skillsCount: 7 }).join('\n')).toContain('7 个已启用技能')
  })

  it('记忆未启用 ⇒ 明确说未启用（不谎称已启用）', () => {
    const text = setupCapabilityLines({ ...BASE, memoryEnabled: false, memoriesCount: 0 }).join('\n')
    expect(text).toMatch(/持久记忆系统：未启用/)
    expect(text).not.toMatch(/可跨对话存储与检索/)
  })
})

describe('内容工厂能力声明的三态（I11 / #5）', () => {
  it('探测到不可用（false）→ 不得把 video_edit 列为可用能力，且必须给出安装指引', () => {
    const line = contentFactoryPromptLine(false, HINT)
    // 「可用能力」的列表形态 = 以 `- **[按需]** ` 开头且含 `video_edit:`
    expect(line, 'false 时仍把 video_edit 当可用能力列出').not.toMatch(/^-\s*\*\*\[按需\]\*\*.*video_edit:/m)
    expect(line, 'false 时不该连 make_article 一起丢掉').toMatch(/make_article/)
    expect(line, 'false 时必须说明原因').toMatch(/未检测到可用的 ffmpeg/)
    expect(line, 'false 时必须带上安装指引，否则模型无法指导用户').toContain(HINT)
  })

  it('探测到可用（true）→ 正常列出，并标注前置条件；不得附带安装指引', () => {
    const line = contentFactoryPromptLine(true, HINT)
    expect(line).toMatch(/make_article \/ video_edit/)
    expect(line, 'true 时不应出现"未检测到"').not.toMatch(/未检测到/)
    expect(line, 'true 时附带安装指引会误导模型让用户白装一遍').not.toContain(HINT)
    expect(line, 'true 时仍应标注前置条件').toMatch(/需本机有可用的 ffmpeg/)
  })

  it('尚未探测（null）→ 保守：列出但标注前置条件，且不谎称已检测', () => {
    const line = contentFactoryPromptLine(null, HINT)
    expect(line).toMatch(/make_article \/ video_edit/)
    expect(line, 'null 时应标注前置条件').toMatch(/需本机有可用的 ffmpeg/)
    expect(line).not.toContain(HINT)
  })

  it('默认参数取真实安装指引（兜住"有人把默认值改成空串"）', () => {
    const line = contentFactoryPromptLine(false)
    // 三个平台分支都以这句开头
    expect(line).toMatch(/ffmpeg 不可用。任选其一安装/)
    expect(ffmpegInstallHint().length, '安装指引本身不得为空').toBeGreaterThan(20)
  })
})
