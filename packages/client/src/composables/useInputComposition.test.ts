import { expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useInputTrigger } from './useInputTrigger'
import { useInputHistory } from './useInputHistory'

it('does not send or navigate history while an IME is composing', () => {
  const inputText = ref('')
  const send = vi.fn()
  const trigger = useInputTrigger({ inputText, inputRef: ref(null), t: x => x, sessions: () => [], currentSessionId: () => undefined, currentWorkspaceDir: () => undefined, welcomePlusOpen: ref(false), onNewChat: () => {}, onSend: send, onInfo: () => {} })
  const history = useInputHistory({ inputText, inputRef: () => null })
  history.pushInputHistory('old')
  const preventDefault = vi.fn()
  const composing = { isComposing: true, keyCode: 229, key: 'Enter', preventDefault } as unknown as KeyboardEvent
  trigger.onInputEnter(composing)
  history.historyPrev(composing)
  expect(send).not.toHaveBeenCalled()
  expect(inputText.value).toBe('')
  expect(preventDefault).not.toHaveBeenCalled()
  trigger.onInputEnter({ isComposing: false, keyCode: 13, preventDefault } as unknown as KeyboardEvent)
  expect(send).toHaveBeenCalledOnce()
  expect(preventDefault).toHaveBeenCalledOnce()
})

it('does not send when an IME only reports keyCode 229 (isComposing false)', () => {
  // Some IMEs report 229 on the Enter that confirms a candidate while
  // isComposing stays false. Trusting isComposing alone sends the half-typed
  // message, which is what this guards. The test above cannot catch it: there
  // isComposing is already true, so it passes even without the 229 check.
  const inputText = ref('')
  const send = vi.fn()
  const preventDefault = vi.fn()
  const trigger = useInputTrigger({ inputText, inputRef: ref(null), t: x => x, sessions: () => [], currentSessionId: () => undefined, currentWorkspaceDir: () => undefined, welcomePlusOpen: ref(false), onNewChat: () => {}, onSend: send, onInfo: () => {} })
  inputText.value = 'half typed'
  trigger.onInputEnter({ isComposing: false, keyCode: 229, key: 'Enter', preventDefault } as unknown as KeyboardEvent)
  expect(send).not.toHaveBeenCalled()
})
