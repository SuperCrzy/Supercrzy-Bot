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
 */
import type { ToolDef } from './types'
import { callDevice } from '../services/device-bridge'

const tool: ToolDef = {
  name: 'mobile_browser',
  description:
    'Browse the web inside the SUPERCRZY app on this phone. Actions: open a URL, snapshot the current page (interactive elements with indices), click an element by index, type text into an element by index, go back. Use snapshot first, then act by index.',
  category: 'network',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['open', 'snapshot', 'click', 'type', 'back'],
        description: 'What to do in the app browser.',
      },
      url: { type: 'string', description: 'open: the URL to load' },
      index: { type: 'integer', description: 'click/type: element index from the last snapshot' },
      text: { type: 'string', description: 'type: text to enter' },
    },
    required: ['action'],
  },
  async execute(args) {
    const action = String(args.action || '')
    const kindMap: Record<string, string> = {
      open: 'browser_navigate',
      snapshot: 'browser_snapshot',
      click: 'browser_click',
      type: 'browser_type',
      back: 'browser_back',
    }
    const kind = kindMap[action]
    if (!kind) return `Unknown action: ${action}`

    const passthrough: Record<string, unknown> = {}
    for (const key of ['url', 'index', 'text']) {
      if (args[key] !== undefined) passthrough[key] = args[key]
    }

    // Browsing needs longer than UI taps: page loads on mobile networks are slow.
    const result = await callDevice(kind, passthrough, 30000)
    return typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
  },
}

export default tool
