/**
 * 剪贴板工具 — 复制文本到剪贴板，多级降级（参考 主流实现 copyToClipboard 设计）
 * ① navigator.clipboard.writeText（标准 API，需用户手势/页面 focus）
 * ② document.execCommand('copy')（Safari / 非安全上下文兜底，setSelectionRange 兼容 iOS）
 */

/** execCommand 复制：同步，兼容 iOS Safari（contentEditable + setSelectionRange 防弹键盘） */
function execCommandCopy(text: string): boolean {
  try {
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.setAttribute('readonly', '')
    textArea.contentEditable = 'true'
    textArea.style.position = 'fixed'
    textArea.style.top = '0'
    textArea.style.left = '-9999px'
    textArea.style.width = '1px'
    textArea.style.height = '1px'
    textArea.style.padding = '0'
    textArea.style.border = 'none'
    textArea.style.outline = 'none'
    textArea.style.boxShadow = 'none'
    textArea.style.background = 'transparent'
    textArea.style.opacity = '0'
    document.body.appendChild(textArea)
    textArea.focus()
    textArea.setSelectionRange(0, text.length)
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    document.body.removeChild(textArea)
    return ok
  } catch {
    return false
  }
}

/**
 * 复制文本到剪贴板。按可靠性从高到低依次尝试：
 * ① navigator.clipboard.writeText（标准 API）
 * ② execCommand('copy')（兜底）
 * @returns 复制成功返回 true
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  if (navigator.clipboard?.writeText && document.hasFocus()) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* 尝试兜底 */ }
  }
  if (execCommandCopy(text)) return true
  return false
}

/** 剥离 markdown 语法 → 纯文本（用于复制 AI 回复；代码块内容保留原样） */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, __, code) => code) // 代码块保留内容
    .replace(/`([^`]+)`/g, '$1')                                // 行内代码
    .replace(/^#{1,6}\s+/gm, '')                                // 标题
    .replace(/^\s*[-*+]\s+/gm, '- ')                            // 无序列表
    .replace(/^\s*\d+\.\s+/gm, '')                              // 有序列表
    .replace(/^\s*>\s?/gm, '')                                  // 引用
    .replace(/\*\*([^*]+)\*\*/g, '$1')                          // 粗体
    .replace(/\*([^*]+)\*/g, '$1')                              // 斜体
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')                    // 链接
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')                   // 图片
    .replace(/\s{2,}\n/g, '\n')                                 // 多余空白
    .trim()
}

/**
 * 富文本复制：同时写 text/plain + text/html（对齐主流实现 复制能力——粘贴到 Notion/Word 保留格式）。
 * 优先 ClipboardItem（标准 API，需要 focus/手势）；不支持或失败 → 降级纯文本。
 */
export async function copyRichText(plain: string, html: string): Promise<boolean> {
  if (!plain) return false
  if (navigator.clipboard?.write && window.ClipboardItem && document.hasFocus()) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ])
      return true
    } catch { /* 降级纯文本 */ }
  }
  return copyToClipboard(plain)
}
