/**
 * 代码块复制按钮注入（v-html 渲染之后调用）。
 *
 * 抽自 `ChatView.vue`（I10 低风险批）。
 *
 * 两个必须保留的细节：
 *   · **事件委托**：按钮是运行时 `document.createElement` 造出来的，逐按钮绑监听会随流式重渲染
 *     无限堆积；绑在消息区根节点上一次即可
 *   · **`.has-copy` 标记**：流式期间每隔几帧就会调用一次，没有标记会给同一个 `pre` 反复插按钮
 */
import { nextTick, type Ref } from 'vue'
import { copyToClipboard } from '@/utils/clipboard'

export interface UseCodeBlocksOptions {
  /** 消息区根节点（事件委托挂在它上面） */
  messagesRef: Ref<HTMLElement | undefined>
  t: (key: string) => string
}

export function useCodeBlocks(opts: UseCodeBlocksOptions) {
  let clickHandler: ((e: MouseEvent) => void) | null = null

  function enhanceCodeBlocks() {
    nextTick(() => {
      const root = opts.messagesRef.value
      if (!root) return

      // 事件委托：一次绑定，处理所有 .code-copy-btn 点击
      if (!clickHandler) {
        clickHandler = async (e: MouseEvent) => {
          const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLElement | null
          if (!btn) return
          // 新结构（cr-code-like-box：按钮在 header，code 在 content）与旧结构（按钮在 pre 内）兼容
          const box = btn.closest('.cr-code-like-box')
          const code = box
            ? (box.querySelector('pre code')?.textContent ?? '')
            : (btn.parentElement?.querySelector('code')?.textContent ?? '')
          const ok = await copyToClipboard(code)
          if (ok) {
            btn.classList.add('copied')
            btn.textContent = '✓'
            setTimeout(() => { btn.classList.remove('copied'); btn.textContent = opts.t('chat.copy') }, 2000)
          }
        }
        root.addEventListener('click', clickHandler)
      }

      // 为尚未有按钮的 pre 添加按钮
      root.querySelectorAll('pre:not(.has-copy)').forEach((pre) => {
        pre.classList.add('has-copy')
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'code-copy-btn'
        btn.textContent = opts.t('chat.copy')
        pre.appendChild(btn)
      })
    })
  }

  /** 解绑（组件卸载时调用，避免根节点被替换后留下悬空监听） */
  function disposeCodeBlocks() {
    const root = opts.messagesRef.value
    if (root && clickHandler) root.removeEventListener('click', clickHandler)
    clickHandler = null
  }

  return { enhanceCodeBlocks, disposeCodeBlocks }
}
