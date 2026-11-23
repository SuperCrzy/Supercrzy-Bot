import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useMessageWindow } from './useMessageWindow'

afterEach(() => vi.unstubAllGlobals())

it('does not pull the reader down if they scroll up before a scheduled update', () => {
  let frame!: FrameRequestCallback
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
  const container = { scrollTop: 100, scrollHeight: 1000, clientHeight: 300 } as HTMLElement
  const view = useMessageWindow({ messages: () => [], messagesRef: ref(container) })
  view.scrollToBottom()
  view.stickToBottom.value = false
  frame(0)
  expect(container.scrollTop).toBe(100)
  view.scrollToBottom(true)
  frame(0)
  expect(container.scrollTop).toBe(1000)
})
