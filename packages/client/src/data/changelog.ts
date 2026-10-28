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
/**
 * 当前版本 —— 构建时由 `vite.config.mjs` 的 `define` 注入，来源是
 * `packages/client/package.json`（`scripts/version.mjs` 负责把它与其余 workspace 同步）。
 *
 * 🔴 2026-10-26 删除了原 `ENGINE_VERSION = '0.4.0'`。
 * 它和 package.json 各存一份版本号，注释里写着「必须与三个 package.json 保持一致」，
 * 但**没有任何机制检查它** —— 于是它停在 0.4.0，而应用已经走到 1.2.3。
 * 结果是「设置 → 关于」同时显示「应用 v1.2.3 / 引擎 v0.4.0」，看起来像装了半成品。
 *
 * 为什么直接删而不是让它跟随：用户视角只有一个版本。两套版本号只要不能自动校验，
 * 迟早再次漂移；而这个标签本身在 2026-10-12 就因「和真实版本并排出现时口径打架」改过一次名
 * —— 当时选择改标签，而不是删掉多余那套。这次删掉。
 *
 * 打包后的二进制版本仍走 `window.supercrzyDesktop.app.getInfo()`（主进程 app.getVersion()，
 * 读 Info.plist）；它与这里同源，因为 desktop/package.json 也在 version.mjs 的同步范围内。
 *
 * 兜底 `'0.0.0'`：单测（vitest）不经过 vite 的 define，运行时要能拿到一个字符串而不是 ReferenceError。
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.3.0',
    date: '2026-10-28',
    title: '先登录，再使用',
    titleEn: 'Sign in first',
    features: [
      '打开即登录：浏览器收六位验证码，登录后三十天内免登录，退出在设置里。',
      '截图取字不再需要额外安装：macOS 用系统 Vision，Windows 用系统 OCR，取不到时自动改用视觉模型。',
      '本地会话加密保存，窗口一直开着也会自己接上登录状态，不用重启。',
    ],
    featuresEn: [
      'Sign in on first launch: a six-digit code from your browser session keeps the app open for thirty days. Sign out any time from Settings.',
      'Screen text extraction works out of the box: system Vision on macOS, system OCR on Windows, and a vision model when neither finds text.',
      'The saved session is encrypted on disk and refreshes itself, so a window left open picks up the new state without a restart.',
    ],
    fixes: [
      // no fixes
    ],
    fixesEn: [
      // no fixes
    ],
  },
  {
    version: '1.2.4',
    date: '2026-10-26',
    title: 'Windows 平台支持与稳定性提升',
    titleEn: 'Windows platform support and stability improvements',
    features: [
      'Windows 版本全新适配：屏幕操控、文件读写、终端会话与 MCP 扩展服务在 Windows 上全面可用',
      'Windows 采用沉浸式顶部栏：窗口控制按钮整合至应用顶栏右侧，界面更简洁、内容区更完整',
      '「关于」页面统一版本标识，仅展示当前应用版本',
    ],
    featuresEn: [
      'Full Windows compatibility: screen control, file access, terminal sessions and MCP extension servers all work on Windows',
      'Immersive title bar on Windows: window controls are integrated into the app header, giving a cleaner interface and more content space',
      'The About panel now shows a single, unified version number',
    ],
    fixes: [
      '修复 Windows 下文件读写、存在性检查、删除与代码检查因路径校验异常而无法执行的问题',
      '修复 Windows 下屏幕操控与扩展服务无法启动的问题',
      '修复 Windows 下终端会话无法执行命令的问题',
      '修复 Windows 下完全访问权限未能覆盖用户文档与工作目录的问题',
      '修复 Windows 下敏感配置目录未被正确保护的问题',
      '优化长期记忆写入逻辑：语义相近的条目自动归并，并提供内容保留与长度上限保护',
      '修复多步骤计划无法推进的问题：创建计划后可直接更新各步骤状态',
      '修复部分图像与视频处理工具未能遵循当前权限设置的问题',
    ],
    fixesEn: [
      'Fixed file operations (read, write, existence check, delete, lint) failing on Windows due to a path validation defect',
      'Fixed screen control and extension servers failing to start on Windows',
      'Fixed terminal sessions being unable to execute commands on Windows',
      'Fixed full access permission not covering user documents and working directories on Windows',
      'Fixed sensitive configuration directories not being properly protected on Windows',
      'Improved long-term memory: semantically similar entries are merged automatically, with content retention and length limits',
      'Fixed multi-step plans that could not advance; steps can now be updated after the plan is created',
      'Fixed some image and video tools not respecting the current permission level',
    ],
  },
  {
    version: '1.2.3',
    date: '2026-10-26',
    title: '即时通讯集成修复与语音体验优化',
    titleEn: 'Messaging integrations and speech experience improvements',
    features: [
      '新增 Windows 系统语音兜底能力，并按系统版本优先选用高质量音色',
      '「关于」页面版本标识完成统一',
    ],
    featuresEn: [
      'Added system speech fallback on Windows, preferring higher-quality voices by OS generation',
      'Unified the version identifier in the About panel',
    ],
    fixes: [
      '修复 Telegram、Discord、Slack、钉钉、飞书、企业微信六个渠道无法返回回复的问题',
      '修复中文内容被英文音色朗读、日文被误判为中文的问题',
      '优化中国及周边地区语音服务的中继可用性',
      '修复系统语音兜底时输出不完整的问题',
      '修复重复启动时因端口占用导致启动失败的问题',
      '更新包改为增量下载，显著减少升级所需流量',
    ],
    fixesEn: [
      'Fixed replies not being delivered in Telegram, Discord, Slack, DingTalk, Feishu and WeCom',
      'Fixed Chinese text being read by an English voice, and Japanese being classified as Chinese',
      'Improved speech relay availability for users in China and nearby regions',
      'Fixed incomplete audio when falling back to system speech',
      'Fixed startup failures caused by port conflicts on a second launch',
      'Updates now download incrementally, substantially reducing upgrade traffic',
    ],
  },
  {
    version: '1.2.2',
    date: '2026-10-23',
    title: '语音朗读连贯性与稳定性修复',
    titleEn: 'Speech playback continuity and stability fixes',
    features: [
      '朗读分段策略优化：按未播放音频时长调度，避免等待与断流',
      '朗读中断时新增明确提示与「续读」入口，可从断点继续播放',
    ],
    featuresEn: [
      'Improved speech segmentation: scheduling by unplayed audio duration avoids stalls and stalls',
      'Added a clear interruption notice and a resume action when playback is cut off',
    ],
    fixes: [
      '修复朗读读到一半停止的问题，涵盖切句、分段传输、重试与暂停超时四个方面',
      '修复朗读中断后界面无任何提示的问题',
    ],
    fixesEn: [
      'Fixed playback stopping mid-sentence across sentence splitting, chunk delivery, retries and pause timeouts',
      'Fixed the interface showing no notice when playback was interrupted',
    ],
  },
  {
    version: '1.2.1',
    date: '2026-10-22',
    title: '版本号统一与用量统计修正',
    titleEn: 'Unified versioning and accurate usage statistics',
    features: [
      '版本号统一为单一来源，设置、关于与更新检查显示的版本保持一致',
      '用量统计口径修正，数据更准确',
    ],
    featuresEn: [
      'Version now derives from a single source, consistent across settings, About and update checks',
      'Corrected usage statistics for accurate reporting',
    ],
    fixes: [],
    fixesEn: [],
  },
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
