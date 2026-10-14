/**
 * SUPERCRZY BOT 版本更新日志（双语）
 * 新版本发布时在数组头部追加条目（zh + en 文案）
 */

export interface ChangelogEntry {
  version: string
  date: string
  title: string
  titleEn: string
  features: string[]
  featuresEn: string[]
  fixes: string[]
  fixesEn: string[]
}

/**
 * 引擎（代码仓库）版本 —— 必须与根 / packages/client / packages/server 三个
 * package.json 的 `version` 保持一致（当前 0.3.0）。
 *
 * ⚠️ 这**不是** App 二进制版本。App 版本请走 `window.supercrzyDesktop.app.getInfo()`
 * （主进程 `app.getVersion()`：打包读 Info.plist、dev 读 packages/desktop/package.json）。
 *
 * 2026-10-12 改名由来：此前叫 `APP_VERSION` 且被渲染成「SUPERCRZY BOT v0.3.0」，
 * 与 App 的真实版本（1.0.5/1.0.6）并排出现时口径打架 —— 数字本身没错，标签错了。
 * CHANGELOG 记录的就是**引擎**的版本变更，与上面的 ENGINE_VERSION 同体系。
 */
export const ENGINE_VERSION = '0.3.0'

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.3.0',
    date: '2026-08-13',
    title: '多平台网关 + 角色化 Agent',
    titleEn: 'Multi-platform Gateway + Role-based Agents',
    features: [
      '接入 8 个消息渠道：微信 / QQ / 企业微信 / 钉钉 / 飞书 / Telegram / Discord / Slack，全部支持长连接免公网回调',
      '角色化 Agent：任务按类型自动分发到设计 / 开发 / 数据分析 / 文案专家，各角色独立系统提示与记忆',
      '任务结果主动推送：定时任务完成后推送到指定渠道（含全部渠道选项）',
      '渠道感知输出：同一回复按平台能力自适应格式化（Markdown / 纯文本）',
      '网关功能区完善：凭据脱敏、错误原因持久化、状态轮询、开发中渠道诚实标注',
      '聊天区改为气泡布局：用户消息右侧品牌色气泡、AI 消息左侧浅色气泡',
      '统一品牌视觉：官方 LOGO 全站应用（欢迎区 / 消息头像），浅色纯白、深色纯黑主题背景',
      '版本更新：更新日志弹窗 + 一键更新（提交改动 → 拉取 → 装依赖 → 构建）',
    ],
    featuresEn: [
      '8 messaging channels: WeChat / QQ / WeCom / DingTalk / Feishu / Telegram / Discord / Slack, all via long-connection without public webhooks',
      'Role-based agents: tasks auto-routed to design / dev / data / copywriting experts, each with dedicated system prompt and memory',
      'Proactive result push: scheduled task results delivered to chosen channels (including "all channels")',
      'Channel-aware output: replies auto-formatted per platform capability (Markdown / plain text)',
      'Gateway improvements: credential masking, error persistence, status polling, honest "in development" labels',
      'Chat UI switched to bubble layout: user messages as brand-colored bubbles on the right, AI on the left',
      'Unified branding: official logo across the app, pure-white / pure-black theme backgrounds',
      'Version updates: changelog modal + one-click update (commit → pull → install → build)',
    ],
    fixes: [
      '修复 vite 开发代理缓冲 SSE 导致流式输出一次性到达的问题',
      '修复历史对话 Markdown 表格不渲染（双重 JSON 序列化兼容）',
      '修复 Agent 收尾空转（推理模型纯思考轮误判为空回复）',
    ],
    fixesEn: [
      'Fixed vite dev proxy buffering SSE, causing streamed output to arrive all at once',
      'Fixed history chat Markdown tables not rendering (double JSON serialization compatibility)',
      'Fixed agent tail-spinning (reasoning-only rounds misread as empty replies)',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-08-12',
    title: '开源准备 + 安全加固',
    titleEn: 'Open-source Prep + Security Hardening',
    features: [
      '全仓库敏感信息清除，git 历史重写，开源审计通过',
      '引入技能系统：技能库管理、GitHub 技能安装、触发词自动匹配',
      'Agent 经验复盘（Playbook）：同类任务自动注入历史经验',
      '幽灵模式：工作区文件变化自动监控',
    ],
    featuresEn: [
      'Cleared sensitive info repo-wide, rewrote git history, open-source audit passed',
      'Skills system: skill library, GitHub skill install, keyword auto-matching',
      'Agent playbook: auto-injects lessons from similar past tasks',
      'Ghost mode: automatic workspace file-change monitoring',
    ],
    fixes: [
      'shell_exec 危险命令黑名单（删根 / sudo / fork 炸弹 / 下载即执行）',
      '文件预览路径穿越防护、CORS 白名单、可选 API Token 鉴权',
      'xlsx 安全漏洞修复（升级 exceljs）',
    ],
    fixesEn: [
      'shell_exec dangerous command blacklist (rm -rf /, sudo, fork bombs, download-and-execute)',
      'File preview path traversal protection, CORS allowlist, optional API token auth',
      'xlsx vulnerability fix (upgraded to exceljs)',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-05',
    title: '初始版本',
    titleEn: 'Initial Release',
    features: [
      'SUPERCRZY BOT 核心对话能力（Web / 微信 / QQ 三通道统一大脑）',
      'Agent 循环：8+ 工具（文件 / Shell / 网页 / 记忆 / 技能）',
      '会话历史、记忆管理、模型多提供商配置',
      '任务系统、自动化定时任务、用量统计',
    ],
    featuresEn: [
      'SUPERCRZY BOT core chat (unified brain across Web / WeChat / QQ)',
      'Agent loop with 8+ tools (files / shell / web / memory / skills)',
      'Chat history, memory management, multi-provider model config',
      'Tasks, scheduled automations, usage stats',
    ],
    fixes: [],
    fixesEn: [],
  },
]
