/**
 * Which viewport a page gets. The two failure modes are symmetric and both were
 * real: only widening for phone pages leaves a desktop site stuck at 390 after
 * the user comes back from one (measured: m.baidu.com then www.baidu.com stayed
 * at 390x844), and resizing unconditionally would thrash the viewport on every
 * navigation.
 */
import { describe, it, expect } from 'vitest'
import { viewportForLayout } from './ai-browser'

describe('viewportForLayout', () => {
    it('shrinks a wide viewport for a phone page', () => {
        expect(viewportForLayout('mobile', 1280)).toEqual({ width: 390, height: 844 })
    })

    it('widens back for a desktop page after a phone page', () => {
        // The regression: the page was still at 390 when the next desktop site loaded.
        expect(viewportForLayout('desktop', 390)).toEqual({ width: 1280, height: 800 })
    })

    it('leaves a phone page alone when it is already phone-width', () => {
        expect(viewportForLayout('mobile', 390)).toBeNull()
    })

    it('leaves a desktop page alone when it is already desktop-width', () => {
        expect(viewportForLayout('desktop', 1280)).toBeNull()
    })

    it('does not resize for a small drift on either side', () => {
        // 40px tolerance: a panel drag of a few pixels must not trigger a reload.
        expect(viewportForLayout('mobile', 420)).toBeNull()
        expect(viewportForLayout('desktop', 1245)).toBeNull()
    })

    it('does not guess when the width probe failed', () => {
        expect(viewportForLayout('desktop', 0)).toBeNull()
        expect(viewportForLayout('mobile', 0)).toBeNull()
    })

    it('does nothing when the layout is unknown', () => {
        expect(viewportForLayout(undefined, 1280)).toBeNull()
    })

    it('returns a fresh object so callers cannot mutate the frame constants', () => {
        const a = viewportForLayout('mobile', 1280)!
        a.width = 1
        expect(viewportForLayout('mobile', 1280)).toEqual({ width: 390, height: 844 })
    })
})
