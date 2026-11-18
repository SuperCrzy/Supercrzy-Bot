/** Wrap untrusted HTML in a sandbox even when it is opened in a new tab. */
export function sandboxedPreviewDocument(content: string): string {
  const attribute = content.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}iframe{display:block}</style></head><body><iframe title="Preview" sandbox="allow-scripts" srcdoc="${attribute}"></iframe></body></html>`
}
