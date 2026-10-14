/**
 * Deep Links 深链接协议（URL 深链接）
 * Web 场景实现：URL 参数 + window message 事件两种唤起方式
 * 协议：supercrzy:// 等价于 http://host/?{query}
 * 支持：
 *  - ?q=文本          → 预填输入框并聚焦（快速提问）
 *  - ?session=id      → 打开指定会话
 *  - ?workspace=path  → 切换工作区
 * 外部程序可 window.open('http://localhost:5173/?q=...') 或 postMessage 唤起
 */

export interface DeepLinkAction {
  q?: string
  session?: string
  workspace?: string
}

/** 从 URL query 解析 deep link 动作 */
export function parseDeepLinkFromURL(): DeepLinkAction {
  const params = new URLSearchParams(window.location.search)
  const action: DeepLinkAction = {}
  const q = params.get('q')
  const session = params.get('session')
  const workspace = params.get('workspace')
  if (q) action.q = q
  if (session) action.session = session
  if (workspace) action.workspace = workspace
  return action
}

/** 注册外部 postMessage 唤起（同源/跨源窗口可发 { type: 'supercrzy-deeplink', action } 消息） */
export function registerDeepLinkListener(handler: (action: DeepLinkAction) => void): () => void {
  const listener = (e: MessageEvent) => {
    const data = e.data
    if (data && typeof data === 'object' && data.type === 'supercrzy-deeplink' && data.action) {
      handler(data.action as DeepLinkAction)
    }
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

/** 构造 deep link URL（供分享/外部唤起） */
export function buildDeepLink(base: string, action: DeepLinkAction): string {
  const params = new URLSearchParams()
  if (action.q) params.set('q', action.q)
  if (action.session) params.set('session', action.session)
  if (action.workspace) params.set('workspace', action.workspace)
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}
