import { Parser } from 'htmlparser2'

/** Extract readable text without executing page code or loading subresources. */
export function extractHtmlText(html: string): { title: string; content: string } {
  // textarea belongs here even though it can hold user-visible text: some sites
  // park stylesheet templates inside it. baidu.com wraps escaped CSS in an outer
  // <textarea> that contains a literal <textarea> tag, htmlparser2 emits two
  // closes for one open in that shape, the depth counter drifts to zero early,
  // and the inner <style> body is returned as page text — 1813 rules ahead of
  // the real body, which maxLength then truncates away. Ignoring the element
  // whole is what actually stops the leak; a stack-based counter on its own was
  // measured not to (1831 rules still leaked), so the simple counter stays.
  const ignored = new Set(['head', 'script', 'style', 'noscript', 'template', 'textarea'])
  const blocks = new Set(['p', 'div', 'article', 'section', 'main', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre', 'tr', 'br', 'hr'])
  let ignoredDepth = 0
  let inTitle = false
  let title = ''
  let content = ''
  const parser = new Parser({
    onopentag(name) {
      if (name === 'title') inTitle = true
      if (ignoredDepth || ignored.has(name)) { ignoredDepth++; return }
      if (blocks.has(name)) content += '\n'
    },
    ontext(text) {
      if (inTitle) title += text
      else if (!ignoredDepth) content += text
    },
    onclosetag(name) {
      if (name === 'title') inTitle = false
      if (ignoredDepth) { ignoredDepth--; return }
      if (blocks.has(name)) content += '\n'
    },
  }, { decodeEntities: true })
  parser.end(html)
  const clean = (text: string) => text.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { title: clean(title), content: clean(content) }
}
