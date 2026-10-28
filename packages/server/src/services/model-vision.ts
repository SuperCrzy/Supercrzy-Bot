/**
 * Model vision capability registry (2026-10-26, backlog item 4a).
 *
 * Why: `computer_use` currently always runs OCR on a screenshot and injects text.
 * That is right for text-only models (DeepSeek chat/reasoner), but wasteful and
 * lossy for vision models (GPT-4o, Claude, Gemini, Qwen-VL): they can read the
 * pixels directly, including layout and icons that OCR throws away.
 *
 * This module answers one question — "can this model see an image?" — without a
 * database migration. Two layers:
 *   1. a static pattern table for well-known model ids (offline, zero config)
 *   2. `SUPERCRZY_VISION_MODELS` env override (comma separated substrings) for
 *      private gateways / new models the table has not learned yet
 *
 * Deliberately NOT wired to skip OCR yet: tool results are plain strings, so an
 * image cannot reach the model without a pipeline change. Until then the value is
 * `visionIngestEnabled()` staying false and the registry telling the UI/agent what
 * it may assume. Flipping the env var only enables the hint line, not image upload.
 */

export type VisionSupport = 'yes' | 'no' | 'unknown'

/** Model id fragments that are known to accept image input */
const VISION_YES: RegExp[] = [
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /o3|o4-mini/i,
  /claude-(3|4|sonnet|opus|haiku)/i,
  /gemini/i,
  /qwen.*vl/i,
  /qwen2\.5-vl|qwen3-vl/i,
  /glm-4(v|-v)/i,
  /llava/i,
  /pixtral/i,
  /internvl/i,
  /ui-tars/i,
  /grok.*vision/i,
  /doubao.*vision|seed.*vision/i,
]

/** Model id fragments that are known to be text-only */
const VISION_NO: RegExp[] = [
  /deepseek-(chat|reasoner|coder|v\d)/i,
  /deepseek-r1/i,
  /gpt-3\.5/i,
  /text-davinci/i,
  /llama-?3(?!.*vision)/i,
  /qwen(?!.*vl)/i,
  /glm-4(?!.*v)/i,
  /moonshot|kimi(?!.*vision)/i,
  /ernie(?!.*vision)/i,
]

function envOverrides(): string[] {
  return String(process.env.SUPERCRZY_VISION_MODELS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** Can this model read images? `unknown` when the table has never seen it. */
export function modelSupportsVision(modelId: string | undefined | null): VisionSupport {
  const id = String(modelId || '').trim()
  if (!id) return 'unknown'
  const lower = id.toLowerCase()
  if (envOverrides().some((needle) => lower.includes(needle))) return 'yes'
  // NO first: "deepseek-v4" must not be caught by a broader positive pattern
  for (const rx of VISION_NO) if (rx.test(id)) return 'no'
  for (const rx of VISION_YES) if (rx.test(id)) return 'yes'
  return 'unknown'
}

/**
 * Whether the pipeline should hand raw screenshots to the model instead of OCR text.
 * Off by default: tool results are strings today, so enabling this changes nothing but
 * the hint we print. Ships as an explicit switch rather than a silent behaviour change.
 */
export function visionIngestEnabled(): boolean {
  return process.env.SUPERCRZY_VISION_INGEST === '1'
}

/** Compact description for logs, diagnostics endpoints and the settings UI */
export function describeVision(modelId: string | undefined | null): {
  model: string
  support: VisionSupport
  ingestEnabled: boolean
  /** What computer_use will actually do with a screenshot right now */
  screenshotPath: 'ocr' | 'image'
} {
  const support = modelSupportsVision(modelId)
  const ingestEnabled = visionIngestEnabled()
  return {
    model: String(modelId || ''),
    support,
    ingestEnabled,
    screenshotPath: support === 'yes' && ingestEnabled ? 'image' : 'ocr',
  }
}
