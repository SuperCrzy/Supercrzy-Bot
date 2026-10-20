/**
 * 文件「能不能当文本预览」的判定 —— **唯一来源**（2026-09-29）。
 *
 * ## 为什么需要这个模块
 *
 * 老板报「AI 自己截屏在右侧边栏的预览是乱码」。真机实测：`/api/filesystem/read?path=…png`
 * 返回 200 + 353525 字节 JSON，`content` 是 `\ufffdPNG\r\n\u001a\n…IHDR`
 * —— 因为服务端把它 `readFile(p, 'utf-8')` 了。PNG 字节流里没有合法 UTF-8 序列，
 * 全部塌成 `U+FFFD` 替换字符，前端再塞进 `<pre>` 渲染 ⇒ 满屏乱码。
 *
 * 全仓库**没有**任何"工作区原始文件直出"的接口，所以正确做法是分两步：
 *   1. `/read` 命中二进制 → 不读内容，改为返回 `{ kind, mime, size, url }`（本模块负责判定）；
 *   2. 前端拿到 `kind: 'media'` → 走右栏 `<img>` 分支（`setPreviewImage`），不走 `<pre>`。
 *
 * ## SVG 为什么**不**算媒体
 *
 * `.svg` 是**文本**：文本预览本来就正确，且 `DetailPanel` 的 SVG 分支会走 `sanitizeSvg`。
 * 更关键的是——把它放进 `raw` 就等于开了一条"同源可执行 SVG"通道：
 * 直接打开 `/api/filesystem/raw?path=x.svg` 会让文件里的 `<script>` 在 App 源上执行。
 * ⇒ **svg 留在文本预览路径**。
 *
 * ## 2026-10-20：Office 文档不再"当文本读"（老板报「md/word 能看吗」）
 *
 * 上一版的 `BINARY_ONLY_EXT` 只有压缩包/字体/音视频/db 那一批，`.docx` **不在里面**，
 * 于是走了"未列出 ⇒ 按 UTF-8 读"的兜底：真机实测 39,300 字节的 docx 解出
 * **15,802 个 `U+FFFD`（42.2%）**，右栏满屏乱码 —— 和 2026-09-29 那次 PNG 乱码同源。
 *
 * 现在分三档，**判定只在这里**：
 *   | 类型 | kind | 前端行为 |
 *   |---|---|---|
 *   | 位图 / pdf | `media` | `<img>` / `<embed>`，`/raw` 直出字节 |
 *   | `.docx` | `docx` | `docx-preview` 渲染（`/raw` 直出字节） |
 *   | `.md/.markdown` | `markdown` | `markdown-it` 渲染 |
 *   | 其它文本 | `text` | 等宽纯文本 |
 *   | 其余二进制 | `binary` | 只给一条提示，不读内容 |
 *
 * `.doc`（97-2003 老二进制格式）**不给 docx 通道**：它根本不是 zip，docx-preview 解析必失败，
 * 归到 `binary` 提示"请另存为 .docx"比抛一个半截渲染要好。
 */
import { extname } from 'path'

/** 可按"媒体"直接内嵌渲染（`<img>` / `<embed>`）的扩展名 → MIME。只放真正的二进制位图 + pdf。 */
const INLINE_MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
}

/**
 * 其余「当文本读毫无意义」的二进制扩展名：不返回内容，只回一条可行动的提示。
 *
 * 目的不是"精确判定二进制"（那要靠读魔数），而是**堵住已知会出乱码的那一类**：
 * 少读一次 = 少一次把几 MB 乱码 JSON 推给前端。未列出的扩展名仍走原文本路径（行为不变）。
 */
const BINARY_ONLY_EXT = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac',
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.db', '.sqlite', '.sqlite3', '.wasm', '.class', '.jar', '.o', '.a', '.so', '.dylib', '.dll', '.exe',
  // 2026-10-20：Office 文档族。`.docx` 走上面的 docx 通道，其余一律不进文本路径。
  // `.doc/.xls/.ppt` 是老二进制格式，前端没有渲染器；`.xlsx/.pptx/.odt/...` 是 zip 容器，
  // 现在没有表格/幻灯片渲染器（待做），先给提示，绝不再读成乱码。
  '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp', '.rtf',
  '.pages', '.numbers', '.key',
])

/**
 * Word OOXML：唯一"二进制但可渲染"的类型。
 * 单独一个 MIME 而**不并进** `INLINE_MEDIA_MIME`：那张表的语义是"能塞进 `<img>/<embed>`"，
 * docx 塞不进去 —— 它的使用方是 `docx-preview`，需要 `arrayBuffer()` 而不是 src。
 */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** Markdown：文本可读，但前端要渲染而不是当纯文本平铺 */
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx'])

function extOf(p: string): string {
  return extname(String(p || '')).toLowerCase()
}

/** 该路径能否当"媒体"内嵌渲染（能则返回 MIME，否则 null） */
export function mediaMimeOf(p: string): string | null {
  return INLINE_MEDIA_MIME[extOf(p)] || null
}

/** 该路径是否属于「已知二进制、文本预览无意义」的类型 */
export function isBinaryPath(p: string): boolean {
  const ext = extOf(p)
  return !!INLINE_MEDIA_MIME[ext] || BINARY_ONLY_EXT.has(ext)
}

/** 二进制 + 非媒体（媒体走 `mediaMimeOf`）→ 文本预览无意义 */
export function isNonPreviewableBinary(p: string): boolean {
  return isBinaryPath(p) && !mediaMimeOf(p)
}

/** `.docx` → 专用渲染通道的 MIME；其它 → null */
export function docxMimeOf(p: string): string | null {
  return extOf(p) === '.docx' ? DOCX_MIME : null
}

/** 是否该按 Markdown 渲染（而不是当纯文本） */
export function isMarkdownPath(p: string): boolean {
  return MARKDOWN_EXT.has(extOf(p))
}

/**
 * SVG：内容是文本，但预览要「当图渲染」而不是给源码。
 *
 * 🔴 刻意**不**进 `/raw`（见文件头「SVG 为什么不 算媒体」）：直出原始字节 =
 * 同源可执行 SVG 通道。所以这里只给一个"渲染提示"，字节仍由 `/read` 当文本返回，
 * 前端塞进 `iframe srcdoc`（沙箱内，脚本跑不出 App 源）。
 */
export function isSvgPath(p: string): boolean {
  return extOf(p) === '.svg'
}
