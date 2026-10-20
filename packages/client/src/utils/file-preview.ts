import { useAppStore } from '@/stores/app'

/**
 * 打开文件预览（正文路径点击 / 工具卡路径定位共用）。
 *
 * 返回形态由后端 `/api/filesystem/read` 的 `kind` 决定，判定唯一来源 =
 * `packages/server/src/services/file-kind.ts`：
 *
 * | kind | 含义 | 前端行为 |
 * |---|---|---|
 * | `text`   | 文本 | 内容灌 detail 面板 preview tab，等宽纯文本渲染 |
 * | `markdown` | Markdown | 同上，但按 markdown-it 渲染（2026-10-20） |
 * | `svg`     | SVG 文件 | 内容当文本传，前端塞 iframe 当图渲染（不进 `/raw`，见 file-kind.ts） |
 * | `media`  | 图片 / PDF | **不能**当文本读 → 走右栏 `<img>` 分支（`setPreviewImage`） |
 * | `docx`   | Word | 只回地址 → `docx-preview` 拉字节渲染（2026-10-20） |
 * | `binary` | 其它二进制 | 只显示一条提示，不渲染内容 |
 *
 * ⚠️ 2026-09-29 修的 bug：这里此前**无条件**把 `d.content` 当成文本塞进
 * `<pre class="preview-code">`，而正文路径链接的扩展名清单（`MessageFlowRenderer.vue`
 * 的 `PATH_LINK_RE`）里含 `png|jpe?g|gif|webp|ico` ⇒ 点 AI 自己截的那张图，
 * 拿到的是服务端 `readFile(p,'utf-8')` 解码后的 35 万字符 `U+FFFD` 乱码。
 *
 * ⚠️ 2026-10-20 修的另一半：`.md` / `.docx` 全部落在"未列出的扩展名 ⇒ 当文本读"的兜底上，
 * 前者被 iframe 当 HTML 解析（换行塌成空格），后者 42% 是 `U+FFFD`。现在类型由后端给，
 * 这里只负责**把类型原样转达给 store**，不在前端重复判定扩展名。
 *
 * @param path 文件路径（须在沙箱白名单内）
 * @param startLine 定位起始行（1-based，可选）
 * @param endLine 定位结束行（可选）
 */
export async function openFilePreview(path: string, startLine?: number, endLine?: number) {
  const appStore = useAppStore()
  try {
    const qs = new URLSearchParams({ path })
    if (startLine && startLine > 0) qs.set('start', String(startLine))
    if (endLine && endLine > 0) qs.set('end', String(endLine))
    const r = await fetch(`/api/filesystem/read?${qs.toString()}`)
    const d = await r.json()
    if (d.error) throw new Error(d.error)

    // 展示标签：路径（带行号范围时附加 L{start}-{end}，主流实现 "已读取 demo.py L12-30" 同款语义）
    const range = d.startLine ? ` L${d.startLine}${d.endLine && d.endLine !== d.startLine ? `-${d.endLine}` : ''}` : ''
    const label = `${d.path}${range}`

    // 打开文件预览前先清掉图片预览：preview tab 里 `<div v-if="previewImage">` 排在文本分支**前面**，
    // 而 previewImage 只写不清 ⇒ 生过一次图之后点任何文件都还是那张图。两种预览模式必须互斥。
    appStore.clearPreviewImage()
    appStore.detailPanelVisible = true
    appStore.setDetailPanelTab('preview')

    // 媒体（图片 / PDF）：交给右栏 <img> 渲染，**绝不**进 <pre>
    if (d.kind === 'media' && d.url) {
      appStore.setPreviewImage(String(d.url), true, label)
      appStore.setPreviewKind('')
      return d
    }

    // Word：内容不进 store（二进制），只把地址带过去，由 PreviewPane 里的 DocxPreview 渲染
    if (d.kind === 'docx' && d.url) {
      appStore.previewFiles = { ...appStore.previewFiles, [label]: '' }
      appStore.previewPath = label
      appStore.previewContent = ''
      appStore.setPreviewKind('docx', String(d.url))
      appStore.previewTs = Date.now()
      return d
    }

    // 其它二进制：文本预览无意义，给一条可行动的提示而不是一屏乱码
    const isBinary = d.kind === 'binary'
    const content = isBinary ? (d.message || '二进制文件不支持文本预览') : (d.content || '(空文件)')
    // markdown / svg 与 text 的内容相同，差别只在渲染方式；binary 用 text 通道展示提示文字
    const kind: 'markdown' | 'svg' | 'text' =
      isBinary ? 'text' : d.kind === 'markdown' ? 'markdown' : d.kind === 'svg' ? 'svg' : 'text'

    appStore.previewFiles = { ...appStore.previewFiles, [label]: content }
    appStore.previewPath = label
    appStore.previewContent = content
    appStore.setPreviewKind(kind)
    appStore.previewTs = Date.now()
    return d
  } catch (err) {
    console.error('[openFilePreview]', path, err)
    return null
  }
}
