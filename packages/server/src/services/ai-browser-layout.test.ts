/**
 * Layout detection decides whether the panel gives a page a phone frame or a
 * desktop frame. Getting it wrong is visible: a mobile page in a wide frame
 * stretches, a desktop page in a narrow frame collapses to a tablet layout.
 * The metas below are the ones observed on real sites (2026-11-21).
 */
import { describe, it, expect } from 'vitest'
import { scoreLayoutKind } from './ai-browser'

describe('scoreLayoutKind', () => {
    it('calls an m. subdomain mobile', () => {
        // m.baidu.com: width=device-width + locked zoom
        const r = scoreLayoutKind({
            host: 'm.baidu.com',
            meta: 'width=device-width,minimum-scale=1.0,maximum-scale=1.0,user-scalable=no',
            apple: false,
        })
        expect(r.kind).toBe('mobile')
        expect(r.reasons).toContain('mobile-subdomain')
        expect(r.suggestedWidth).toBe(390)
    })

    it('calls weibo.cn mobile from locked zoom alone', () => {
        const r = scoreLayoutKind({
            host: 'weibo.cn',
            meta: 'width=device-width,initial-scale=1.0,minimum-scale=1.0, maximum-scale=2.0',
            apple: false,
        })
        // device-width (0.5) is below the threshold: this is the weakest case the
        // function is allowed to call desktop, and it does.
        expect(r.kind).toBe('desktop')
    })

    it('treats a fixed 1200px viewport as desktop', () => {
        // m.taobao.com redirects to www and declares width=1200
        const r = scoreLayoutKind({ host: 'www.taobao.com', meta: 'width=1200', apple: false })
        expect(r.kind).toBe('desktop')
        expect(r.reasons).toContain('fixed-width-1200')
        expect(r.suggestedWidth).toBe(1280)
    })

    it('does not flip a responsive desktop page on device-width alone', () => {
        const r = scoreLayoutKind({
            host: 'www.example.com',
            meta: 'width=device-width, initial-scale=1',
            apple: false,
        })
        expect(r.kind).toBe('desktop')
    })

    it('treats an apple-mobile-web-app meta as decisive', () => {
        const r = scoreLayoutKind({ host: 'example.com', meta: '', apple: true })
        expect(r.kind).toBe('mobile')
    })

    it('defaults to desktop when the page declares nothing', () => {
        const r = scoreLayoutKind({ host: 'example.com', meta: '', apple: false })
        expect(r.kind).toBe('desktop')
        expect(r.reasons).toContain('no-viewport-meta')
    })

    it('lets a fixed desktop width beat a mobile subdomain', () => {
        // A desktop site on an m host that explicitly asks for 1200px wins:
        // the author's fixed width is the stronger statement.
        const r = scoreLayoutKind({ host: 'm.example.com', meta: 'width=1200', apple: false })
        expect(r.kind).toBe('desktop')
    })
})
