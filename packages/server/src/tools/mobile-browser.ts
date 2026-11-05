/**
 * mobile_browser — the phone implementation of the AI browser.
 *
 * The agent drives a WebView inside the SUPERCRZY app through the device bridge:
 * open → snapshot → click/type → repeat. The engine is the system WebView
 * (Chromium), so no browser download is needed; the snapshot is a flat list of
 * interactive elements with stable indices that click/type address by index.
 *
 * This is the mobile counterpart of the desktop `browser` tool. Same loop, different
 * engine: there is no bundled Chromium on Android, and the system WebView is both
 * the smallest (0 MB) and the most current kernel available on the device.
 *
 * It goes through `ai-browser-mobile` rather than calling the device bridge directly
 * for one reason: the side panel shares that module's frame cache. An agent action
 * therefore shows up in the human's side panel on the next long-poll — one WebView,
 * one page, two operators. Calling `callDevice` straight from here would leave the
 * panel showing a stale page.
 */
import type { ToolDef } from './types'
import { mobileBrowserCall } from '../services/ai-browser-mobile'
import type { BrowserSnapshot } from '../services/ai-browser'

/** Human/LLM readable rendering of a DOM snapshot: what you can see, what you can press. */
function render(snap: BrowserSnapshot): string {
  const dom = snap.dom
  if (!dom) return `${snap.url}\n${snap.title}\n(no DOM payload)`
  const head = [`URL: ${snap.url}`, `TITLE: ${snap.title || '(none)'}`]
  if (dom.ready && dom.ready !== 'complete') head.push(`STATE: ${dom.ready}`)
  const text = (dom.text || '').trim()
  const body = text ? ['', 'TEXT:', text.slice(0, 3000)] : []
  const els = dom.elements.slice(0, 60).map((e) => {
    const href = e.href ? ` → ${e.href}` : ''
    const off = e.disabled ? ' [disabled]' : ''
    return `[${e.i}] <${e.tag}> ${e.text || '(no label)'}${href}${off}`
  })
  const list = els.length ? ['', 'ELEMENTS:', ...els] : ['', 'ELEMENTS: (none)']
  const more = dom.elements.length > 60 ? [`… ${dom.elements.length - 60} more`] : []
  return [...head, ...body, ...list, ...more].join('\n')
}

const tool: ToolDef = {
  name: 'mobile_browser',
  description:
    'Browse the web inside the SUPERCRZY app on this phone. Actions: open a URL, snapshot the current page (text plus interactive elements with indices), click an element by index, type text into an element by index, go back, or click by visible text. Use snapshot first, then act by index.',
  category: 'network',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'snapshot', 'click', 'type', 'back', 'click_text'],
        description: 'What to do in the app browser.',
      },
      url: { type: 'string', description: 'open: the URL to load' },
      index: { type: 'integer', description: 'click/type: element index from the last snapshot' },
      text: { type: 'string', description: 'type: text to enter; click_text: the visible label to click' },
    },
    required: ['action'],
  },
  async execute(args) {
    const action = String(args.action || '')
    const known = ['open', 'snapshot', 'click', 'type', 'back', 'click_text']
    if (!known.includes(action)) return `Unknown action: ${action}`
    try {
      const snap = await mobileBrowserCall(action, args)
      return render(snap)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `mobile_browser ${action} failed: ${msg}`
    }
  },
}

export default tool
