/**
 * 渠道感知的回复格式化
 * 不同 IM 平台对 Markdown 的支持差异极大，这里按渠道能力做适配：
 *  - telegram: 支持 Markdown 基本语法，保留
 *  - discord: 支持 markdown + 代码块，保留但适配
 *  - slack: mrkdwn 语法（与 markdown 有差异），保守处理
 *  - 微信/企微/钉钉/飞书: 纯文本为主，剥掉 markdown 符号
 */

/**
 * 按渠道格式化 agent 回复
 * @param text   原始回复（Markdown）
 * @param channel 渠道 id
 */
export function formatForChannel(text: string, channel: string): string {
  switch (channel) {
    case 'telegram':
      return formatTelegram(text)
    case 'discord':
      return formatDiscord(text)
    case 'slack':
      return formatSlack(text)
    case 'wechat':
    case 'wecom':
    case 'dingtalk':
    case 'feishu':
    case 'qq':
      return formatPlain(text)
    default:
      return text
  }
}

/** Telegram：保留 Markdown，但规避不支持的复杂语法 */
function formatTelegram(text: string): string {
  // Telegram 对表格/复杂嵌套支持差，但基本 markdown 可用。保持原样。
  // 仅处理一个已知问题：裸 URL 后跟标点会被 markdown 解析打断，这里不做过度处理
  return text
}

/** Discord：支持 markdown + ``` 代码块 */
function formatDiscord(text: string): string {
  return text
}

/** Slack：mrkdwn 语法——链接是 <url|text>，粗体是 *text*，与 markdown 冲突的符号要转义 */
function formatSlack(text: string): string {
  // Slack 里 `#` 标题、`>` 引用兼容；但 `_italic_` 与 markdown 冲突小
  // 保守：保留文本，Slack 端 mrkdwn:false 已避免语法冲突（slack-bot 发送时已设 mrkdwn:false）
  return text
}

/** 纯文本渠道：剥掉 markdown 符号，保留可读性 */
function formatPlain(text: string): string {
  let t = text

  // 代码块 → 保留内容，去掉围栏
  t = t.replace(/```(\w+)?\n?/g, '')
  t = t.replace(/```/g, '')

  // 行内代码 → 去掉反引号
  t = t.replace(/`([^`]+)`/g, '$1')

  // 标题 → 转成纯文本行
  t = t.replace(/^#{1,6}\s+/gm, '')

  // 粗体/斜体 → 去掉符号
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
  t = t.replace(/\*([^*]+)\*/g, '$1')
  t = t.replace(/__([^_]+)__/g, '$1')
  t = t.replace(/_([^_]+)_/g, '$1')

  // 删除线
  t = t.replace(/~~([^~]+)~~/g, '$1')

  // 链接 [text](url) → text (url)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')

  // 引用 → 去掉 > 前缀
  t = t.replace(/^>\s?/gm, '')

  // 列表符号 → 保留（纯文本友好）
  // 分割线
  t = t.replace(/^---+$/gm, '')

  return t.trim()
}
