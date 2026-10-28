import { describe, it, expect, afterEach } from 'vitest'
import { modelSupportsVision, visionIngestEnabled, describeVision } from './model-vision'

const ENV_KEY = 'SUPERCRZY_VISION_MODELS'
const INGEST_KEY = 'SUPERCRZY_VISION_INGEST'

afterEach(() => {
  delete process.env[ENV_KEY]
  delete process.env[INGEST_KEY]
})

describe('modelSupportsVision', () => {
  it('text-only families answer "no" — a false "yes" would make us skip OCR for a blind model', () => {
    expect(modelSupportsVision('deepseek-chat')).toBe('no')
    expect(modelSupportsVision('deepseek-reasoner')).toBe('no')
    expect(modelSupportsVision('deepseek-v4-pro')).toBe('no')
    expect(modelSupportsVision('qwen-max')).toBe('no')
    expect(modelSupportsVision('glm-4-plus')).toBe('no')
  })

  it('multimodal families answer "yes"', () => {
    expect(modelSupportsVision('gpt-4o')).toBe('yes')
    expect(modelSupportsVision('gpt-4.1-mini')).toBe('yes')
    expect(modelSupportsVision('claude-sonnet-4')).toBe('yes')
    expect(modelSupportsVision('gemini-2.5-pro')).toBe('yes')
    expect(modelSupportsVision('qwen2.5-vl-72b')).toBe('yes')
    expect(modelSupportsVision('glm-4v')).toBe('yes')
  })

  it('unknown models never guess', () => {
    expect(modelSupportsVision('acme-9000')).toBe('unknown')
    expect(modelSupportsVision('')).toBe('unknown')
    expect(modelSupportsVision(undefined)).toBe('unknown')
  })

  it('env override wins, so private gateways do not need a code change', () => {
    process.env[ENV_KEY] = 'acme, custom-vl'
    expect(modelSupportsVision('acme-9000')).toBe('yes')
    expect(modelSupportsVision('my-custom-vl-7b')).toBe('yes')
  })
})

describe('visionIngestEnabled', () => {
  it('is off unless explicitly switched on', () => {
    expect(visionIngestEnabled()).toBe(false)
    process.env[INGEST_KEY] = '1'
    expect(visionIngestEnabled()).toBe(true)
  })
})

describe('describeVision', () => {
  it('reports the OCR path while ingest stays off, even for a vision model', () => {
    const d = describeVision('gpt-4o')
    expect(d.support).toBe('yes')
    expect(d.ingestEnabled).toBe(false)
    expect(d.screenshotPath).toBe('ocr')
  })

  it('only claims the image path when both capability and ingest are true', () => {
    process.env[INGEST_KEY] = '1'
    expect(describeVision('gpt-4o').screenshotPath).toBe('image')
    // capability yes but ingest off → still OCR
    delete process.env[INGEST_KEY]
    expect(describeVision('gpt-4o').screenshotPath).toBe('ocr')
    // ingest on but text-only model → still OCR
    process.env[INGEST_KEY] = '1'
    expect(describeVision('deepseek-chat').screenshotPath).toBe('ocr')
  })
})
