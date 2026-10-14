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
])

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
