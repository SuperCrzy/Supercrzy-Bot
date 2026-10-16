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
 * package.json 的 `version` 保持一致（当前 0.4.0）。
 *
 * ⚠️ 这**不是** App 二进制版本。App 版本请走 `window.supercrzyDesktop.app.getInfo()`
 * （主进程 `app.getVersion()`：打包读 Info.plist、dev 读 packages/desktop/package.json）。
 *
 * 2026-10-12 改名由来：此前叫 `APP_VERSION` 且被渲染成「SUPERCRZY BOT v0.3.0」，
 * 与 App 的真实版本（1.0.5/1.0.6）并排出现时口径打架 —— 数字本身没错，标签错了。
 * CHANGELOG 记录的就是**引擎**的版本变更，与上面的 ENGINE_VERSION 同体系。
 */
export const ENGINE_VERSION = '0.4.0'

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.4.0',
    date: '2026-10-16',
    title: '全界面双语 + 中英通用音色 + 桌面端稳定性',
    titleEn: 'Full bilingual UI + multilingual voice + desktop stability',
    features: [
      '英文界面补齐：定时任务、例程、协作平台、侧栏会话、文件树、工具调用卡等页面此前在英文模式下仍显示中文，现已全部接入 i18n',
      '朗读音色新增「中英通用」档：默认改为 Ava（Edge TTS 多语言音色），中英混排都自然；同时保留纯中文音色（晓晓 / 晓伊 / 云希 / 云扬 / 晓北）',
      '音色列表清理：移除上游已失效的 en-US-AriaNeural',
      '设置 → 关于新增「检查更新」按钮：此前只有启动后自动检查一次，启动时网络不通就再也没机会检查',
      '自动更新源恢复可用（updates.supercrzy.com 持续发布新版本）',
    ],
    featuresEn: [
      'English coverage completed: Scheduled tasks, Routines, Collaboration Hub, sidebar sessions, file tree and tool-call cards previously still showed Chinese in English mode — all now wired to i18n',
      'New "multilingual" voice tier: default is now Ava (Edge TTS multilingual), natural for both Chinese and English; the Chinese-only voices (Xiaoxiao / Xiaoyi / Yunxi / Yunyang / Xiaobei) remain available',
      'Voice list cleanup: removed the now-retired upstream voice en-US-AriaNeural',
      'Settings > About gained a "Check for updates" button: previously the only check ran once at startup, so a bad network at launch meant no chance to check again',
      'The auto-update feed is live again (updates.supercrzy.com keeps receiving releases)',
    ],
    fixes: [
      '修复点关闭按钮后屏幕残留黑色方块：主窗口隐藏到托盘时未同步隐藏 AI 浏览器的原生视图（WebContentsView）',
      '修复没有新版本时顶部常驻显示 Update failed / net::ERR_CONNECTION_CLOSED：启动时的后台自动检查失败现改为静默，不再把技术错误抛给用户',
      '修复协作平台整块翻译不生效（i18n 的 collab 段在英文侧被错误嵌套进 aiBrowser 段）',
      '更新失败提示改为友好文案，原始错误只保留在设置面板的更新日志里',
    ],
    fixesEn: [
      'Fixed a black rectangle left on screen after clicking close: hiding the main window to the tray did not hide the AI browser native view (WebContentsView)',
      'Fixed "Update failed / net::ERR_CONNECTION_CLOSED" permanently shown when already up to date: the background check at startup now fails silently instead of surfacing a technical error',
      'Fixed the Collaboration Hub translation never applying (the collab block was wrongly nested inside aiBrowser on the English side)',
      'Update-failure messages are now user-friendly; raw errors stay in the settings update log',
    ],
  },
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
