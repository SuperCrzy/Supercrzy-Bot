/**
 * device_control — let the agent see and operate THIS phone (P3).
 *
 * Android-only: the tool rides the device-bridge file channel to the app's
 * accessibility service. Actions map 1:1 to DeviceCommandWorker kinds.
 *
 * Safety fences (by design, not optional):
 *   - snapshot/tap/swipe/text only; no global system-settings changes
 *   - every action requires the user's accessibility service switch to be ON,
 *     which they can flip off at any moment (the bridge then answers with a
 *     clear error instead of failing silently)
 */
import type { ToolDef } from './types'
import { callDevice } from '../services/device-bridge'

const tool: ToolDef = {
  name: 'device_control',
  description:
    'See and operate THIS Android phone via accessibility: read a UI snapshot of the current screen, tap coordinates, swipe, type into the focused field, press back/home/recents, or launch an app by package name. Requires the user to have enabled the SUPERCRZY accessibility service.',
  category: 'interaction',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['snapshot', 'tap', 'swipe', 'text', 'key', 'launch'],
        description: 'What to do on the phone.',
      },
      x: { type: 'integer', description: 'tap: x coordinate' },
      y: { type: 'integer', description: 'tap: y coordinate' },
      x1: { type: 'integer', description: 'swipe: start x' },
      y1: { type: 'integer', description: 'swipe: start y' },
      x2: { type: 'integer', description: 'swipe: end x' },
      y2: { type: 'integer', description: 'swipe: end y' },
      ms: { type: 'integer', description: 'swipe duration in ms (default 300)' },
      text: { type: 'string', description: 'text: text to type into the focused field' },
      key: { type: 'string', enum: ['back', 'home', 'recents', 'notifications'], description: 'key: which global key to press' },
      package: { type: 'string', description: 'launch: package name, e.g. com.tencent.mm' },
    },
    required: ['action'],
  },
  async execute(args) {
    const action = String(args.action || '')
    const kindMap: Record<string, string> = {
      snapshot: 'snapshot',
      tap: 'tap',
      swipe: 'swipe',
      text: 'text',
      key: 'key',
      launch: 'launch',
    }
    const kind = kindMap[action]
    if (!kind) return `Unknown action: ${action}`

    const passthrough: Record<string, unknown> = {}
    for (const key of ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'ms', 'text', 'key', 'package']) {
      if (args[key] !== undefined) passthrough[key] = args[key]
    }

    const result = await callDevice(kind, passthrough)
    return typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
  },
}

export default tool
