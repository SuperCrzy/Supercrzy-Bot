/**
 * 历史消息搜索（右上角放大镜：跨会话全文搜索消息内容）—— 从 ChatView.vue 抽出
 *
 * 与 `composables/useChatSearch.ts`（DOM 级高亮 mark 注入）**不是一回事**，别合并：
 *   - 本模块 = 后端全文检索（`/api/history/search`），跨会话，输入即搜；
 *   - useChatSearch = 当前会话已渲染 DOM 的关键词高亮。
 *
 * 两个必须保留的细节：
 *   1. **250ms 防抖**：即输即搜，不去抖会每敲一个字打一次后端全文检索。
 *   2. **空查询走本地清空**（不发请求），避免后端把 `q=` 当成"匹配全部"返回一大坨。
 */
import { ref } from 'vue'

export interface UseHistorySearchOptions {
  /** 打开搜索结果对应的会话 */
  selectSession: (id: string) => Promise<unknown> | unknown
  /** 跳回对话页（App 内是路由 push('/')） */
  afterOpen?: () => void
  debounceMs?: number
}

export function useHistorySearch(opts: UseHistorySearchOptions) {
  const { selectSession, afterOpen, debounceMs = 250 } = opts

  const searchOpen = ref(false)
  const searchQuery = ref('')
  const searchResults = ref<any[]>([])
  const searchSearched = ref(false)

  function openSearch() {
    searchOpen.value = true
    searchQuery.value = ''
    searchResults.value = []
    searchSearched.value = false
    // 弹层由 v-if 挂载，120ms 后再抓输入框（挂载即聚焦）
    setTimeout(() => { (document.querySelector('.search-modal input') as HTMLInputElement | null)?.focus() }, 120)
  }

  /** 跨会话全文搜索消息内容（含提问与 AI 回复；q 为空 = 清空结果） */
  async function searchHistoryMessages(q: string) {
    try {
      const url = `/api/history/search?q=${encodeURIComponent(q)}`
      const res = await fetch(url)
      if (res.ok) searchResults.value = await res.json()
    } catch { /* 搜索失败不阻断界面，仅保持空结果 */ }
    searchSearched.value = true
  }

  /** 输入变化：空 → 清空结果；有字 → 即输即搜（防抖） */
  let searchDebounce: ReturnType<typeof setTimeout> | null = null
  function onSearchQueryChange(v: string) {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      const q = v.trim()
      if (q) searchHistoryMessages(q)
      else { searchResults.value = []; searchSearched.value = false }
    }, debounceMs)
  }

  async function doSearch() {
    const q = searchQuery.value.trim()
    if (!q) { searchResults.value = []; searchSearched.value = false; return }
    searchHistoryMessages(q)
  }

  /** 点击结果：打开对应会话 */
  async function openSearchResult(r: any) {
    searchOpen.value = false
    if (!r.session_id) return
    await selectSession(r.session_id)
    afterOpen?.()
  }

  return {
    searchOpen, searchQuery, searchResults, searchSearched,
    openSearch, searchHistoryMessages, onSearchQueryChange, doSearch, openSearchResult,
  }
}
