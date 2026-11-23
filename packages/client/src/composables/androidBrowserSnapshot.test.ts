// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

describe('Android browser snapshot element identities', () => {
  it('keeps node identities stable when elements are hidden or inserted', () => {
    const source = readFileSync(resolve(process.cwd(), '../../apps/android/app/src/main/java/com/supercrzy/bot/BrowserHost.kt'), 'utf8')
    const body = source.match(/private const val SNAPSHOT_BODY = """([\s\S]*?)"""/)?.[1]
    expect(body).toBeTruthy()
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>'
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 20, height: 20, left: 0, top: 0 } as DOMRect)
    try {
      const snapshot = () => JSON.parse(new Function(body!)()) as { elements: Array<{ i: number }> }
      const first = snapshot()
      const a = document.querySelector<HTMLElement>('#a')!
      const b = document.querySelector<HTMLElement>('#b')!
      const [idA, idB] = first.elements.map((e) => e.i)
      a.style.display = 'none'
      expect(snapshot().elements[0].i).toBe(idB)
      expect(document.querySelector(`[data-sc-idx="${idA}"]`)).toBeNull()
      const c = document.createElement('button')
      b.before(c)
      const afterInsert = snapshot()
      expect(afterInsert.elements[1].i).toBe(idB)
      expect(afterInsert.elements[0].i).not.toBe(idA)
    } finally {
      rect.mockRestore()
      document.body.innerHTML = ''
    }
  })
})
