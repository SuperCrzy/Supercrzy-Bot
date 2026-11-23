/**
 * extractHtmlText is the only thing standing between a fetched page and the
 * model's context window, so the cases here are the shapes that have actually
 * leaked or truncated content in practice, not synthetic tag soup.
 */
import { describe, it, expect } from 'vitest'
import { extractHtmlText } from './html-text'

describe('extractHtmlText', () => {
  it('keeps paragraph breaks and collects the title', () => {
    const r = extractHtmlText('<html><head><title>T</title></head><body><p>One</p><p>Two</p></body></html>')
    expect(r.title).toBe('T')
    expect(r.content).toBe('One\n\nTwo')
  })

  it('drops script and style bodies', () => {
    const r = extractHtmlText('<body><p>A</p><script>var x=1</script><style>.a{color:red}</style><p>B</p></body>')
    expect(r.content).toBe('A\n\nB')
  })

  it('decodes entities instead of leaving escaped markup', () => {
    const r = extractHtmlText('<body><p>a &amp; b &lt;tag&gt;</p></body>')
    expect(r.content).toBe('a & b <tag>')
  })

  // htmlparser2 treats textarea as RCDATA: tags inside are emitted as text and
  // onopentag never fires, so the ignored set cannot catch a nested <style>.
  // baidu.com ships an outer <textarea> holding escaped CSS that itself contains
  // a literal <textarea> tag; the first close the parser sees belongs to the
  // inner element, the depth accounting lands on the wrong node, and 1813 CSS
  // rules end up as the page body — ahead of the real text, so maxLength
  // truncates it away. A single non-nested textarea does NOT reproduce this.
  it('drops a textarea whose escaped CSS contains a nested textarea', () => {
    const r = extractHtmlText(
      '<body><textarea id="outer" style="display:none;">&lt;style&gt;.x{color:red}&lt;/style&gt;'
      + '<textarea id="inner"><style data-for="result">#a{display:none}</style></textarea>'
      + '</textarea><p>BODY</p></body>',
    )
    expect(r.content).toBe('BODY')
    expect(r.content).not.toContain('color:red')
    expect(r.content).not.toContain('display:none')
  })

  it('drops a plain textarea as well', () => {
    const r = extractHtmlText('<body><p>A</p><textarea>form default</textarea><p>B</p></body>')
    expect(r.content).toBe('A\n\nB')
    expect(r.content).not.toContain('form default')
  })

  it('survives an unclosed ignored container without swallowing later text', () => {
    const r = extractHtmlText('<body><script><div><span>a</span></div></script><p>ONE</p><noscript><div>y</div></noscript><p>TWO</p></body>')
    expect(r.content).toContain('ONE')
    expect(r.content).toContain('TWO')
  })
})
