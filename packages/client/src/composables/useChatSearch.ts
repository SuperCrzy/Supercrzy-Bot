/**
 * useChatSearch — 聊天区 DOM 级搜索高亮 (TreeWalker)
 * 参考 WorkBuddy cb-chat-search 实现
 */

const SEARCH_HIT_CLASS = 'cb-search-hit'
const SEARCH_HIT_CURRENT_CLASS = 'cb-search-hit--current'
const SKIPPED_SELECTORS = 'pre, code, img, .markdown-pre-mermaid, .katex, svg, [data-chat-search-skip]'

/** 大小写不敏感正则，转义特殊字符 */
export function buildSearchRegExp(keyword: string): RegExp | null {
  if (!keyword) return null
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped, 'gi')
}

/** 清除容器内所有高亮 mark 标签 */
export function clearHighlights(root: HTMLElement | null) {
  if (!root) return
  root.querySelectorAll(`mark.${SEARCH_HIT_CLASS}`).forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
  })
  root.normalize()
}

/** 在 root 内把 keyword 所有匹配包进 mark.cb-search-hit */
export function applyHighlights(
  root: HTMLElement | null,
  keyword: string,
  onMarkCreated?: (mark: HTMLElement) => void,
): HTMLElement[] {
  clearHighlights(root)
  if (!root || !keyword) return []
  const re = buildSearchRegExp(keyword)
  if (!re) return []

  const created: HTMLElement[] = []
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Text) {
        const text = node.nodeValue
        if (!text) return NodeFilter.FILTER_REJECT
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        if (parent.closest(SKIPPED_SELECTORS)) return NodeFilter.FILTER_REJECT
        re.lastIndex = 0
        return re.test(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    },
  )

  const pending: Text[] = []
  let node = walker.nextNode() as Text | null
  while (node) {
    pending.push(node)
    node = walker.nextNode() as Text | null
  }

  for (const textNode of pending) {
    const text = textNode.nodeValue || ''
    re.lastIndex = 0
    let lastIndex = 0
    const fragment = document.createDocumentFragment()
    let match
    while ((match = re.exec(text)) !== null) {
      const start = match.index
      const end = start + match[0].length
      if (match[0].length === 0) {
        re.lastIndex = end + 1
        continue
      }
      if (start > lastIndex) fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)))
      const mark = document.createElement('mark')
      mark.className = SEARCH_HIT_CLASS
      mark.textContent = match[0]
      fragment.appendChild(mark)
      created.push(mark)
      onMarkCreated?.(mark)
      lastIndex = end
    }
    if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
    const parent = textNode.parentNode
    if (parent) parent.replaceChild(fragment, textNode)
  }
  return created
}

/** 更新当前选中高亮 */
export function updateCurrentMark(marks: HTMLElement[], index: number) {
  marks.forEach((m) => m.classList.remove(SEARCH_HIT_CURRENT_CLASS))
  if (marks[index]) {
    marks[index].classList.add(SEARCH_HIT_CURRENT_CLASS)
    marks[index].scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}
