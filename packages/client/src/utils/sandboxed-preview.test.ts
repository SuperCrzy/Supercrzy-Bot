import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { sandboxedPreviewDocument } from './sandboxed-preview'

describe('new-tab HTML preview', () => {
  it('keeps adversarial markup inside an opaque-origin sandbox', () => {
    const input = '<!doctype html><script>window.parent.location="/api"</script>" onload="alert(1) <iframe>&amp;'
    const page = new JSDOM(sandboxedPreviewDocument(input)).window.document
    const frames = page.querySelectorAll('iframe')
    expect(frames).toHaveLength(1)
    expect(frames[0].getAttribute('sandbox')).toBe('allow-scripts')
    expect(frames[0].getAttribute('srcdoc')).toBe(input)
    expect(frames[0].hasAttribute('onload')).toBe(false)
    expect(page.querySelectorAll('script')).toHaveLength(0)
  })
})
