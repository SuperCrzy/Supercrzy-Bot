import { useAppStore } from '@/stores/app'

/**
 * 打开文件预览（P0-1 正文路径检测 / P0-3 read_file 定位共用）。
 * 调后端 /api/filesystem/read（沙箱白名单校验）→ 内容灌入 detail 面板 preview tab。
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

    // 展示标签：路径（带行号范围时附加 L{start}-{end}，WorkBuddy "已读取 demo.py L12-30" 同款语义）
    const range = d.startLine ? ` L${d.startLine}${d.endLine && d.endLine !== d.startLine ? `-${d.endLine}` : ''}` : ''
    const label = `${d.path}${range}`
    const content = d.content || '(空文件)'

    appStore.previewFiles = { ...appStore.previewFiles, [label]: content }
    appStore.previewPath = label
    appStore.previewContent = content
    appStore.previewTs = Date.now()
    appStore.detailPanelVisible = true
    appStore.setDetailPanelTab('preview')
    return d
  } catch (err) {
    console.error('[openFilePreview]', path, err)
    return null
  }
}

/**
 * 从字符串提取路径 + 可选行号（`src/utils/tool-meta.ts` / `demo.py` / `app.ts:12` / `app.ts L12-30`）。
 * 简化版 WorkBuddy path-detector：绝对路径 / 相对路径 / 文件名带扩展名。
 */
const PATH_PATTERN = /((?:\/|~\/|\.{1,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.(?:[tj]sx?|vue|ts|js|mjs|cjs|json|md|mdx|css|scss|sass|less|py|go|rs|java|kt|c|h|cpp|hpp|cs|php|rb|swift|yml|yaml|toml|ini|cfg|sh|bash|zsh|fish|html|htm|svg|png|jpe?g|gif|webp|ico|db|sqlite|sql|txt|log|xml|env|lock|editorconfig|gitignore|dockerfile|graphql|proto|wasm))/gi
const PATH_LINE_SUFFIX = /^:\s*(\d+)(?:[-–](\d+))?\s*$/

export interface DetectedPath {
  path: string
  startLine?: number
  endLine?: number
}

/** 从文本中检测第一个文件路径（含可选行号后缀 `:12` 或 `:12-30`） */
export function detectPathInText(text: string): DetectedPath | null {
  if (!text) return null
  PATH_PATTERN.lastIndex = 0
  const m = PATH_PATTERN.exec(text)
  if (!m) return null
  const raw = m[0]
  // 尝试行号后缀（紧跟路径的 :N 或 :N-M）
  const after = text.slice(m.index + raw.length, m.index + raw.length + 12)
  const lm = after.match(/^\s*:\s*(\d+)(?:\s*[-–]\s*(\d+))?\b/)
  const path = (raw.endsWith(':') ? raw.slice(0, -1) : raw).trim()
  if (!lm) return { path }
  return { path, startLine: parseInt(lm[1], 10), endLine: lm[2] ? parseInt(lm[2], 10) : undefined }
}

/** HTML 文本节点内的路径是否应检测（跳过代码块 pre 内部） */
export function shouldSkipPathNode(el: Element | null): boolean {
  return !!el?.closest('pre')
}
