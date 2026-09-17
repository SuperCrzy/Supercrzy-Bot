/**
 * 附件 / 产物的类型判定与体积格式化（P1-04 从 ChatView.vue 下沉，2026-09-17）
 *
 * 这些是纯函数，原先散在 6500 行的 ChatView 里、且零测试覆盖。
 * 下沉后既可单独测试，也让 ChatView 专注于编排。
 */

/** 图片（按 mime 前缀） */
export function isImageType(mime: string): boolean {
  return String(mime || '').startsWith('image/')
}

/** PDF */
export function isPdfType(mime: string): boolean {
  return String(mime || '') === 'application/pdf'
}

/** Word 类文档 */
export function isDocType(mime: string): boolean {
  const m = String(mime || '')
  return m.includes('word') || m.includes('document')
}

/** Excel 类表格 */
export function isSheetType(mime: string): boolean {
  const m = String(mime || '')
  return m.includes('excel') || m.includes('spreadsheet')
}

/**
 * 上传附件的体积文案（带空格：`1.5 KB`）。
 * 注意：与 formatArtifactSize 的差异（有无空格）是历史行为，保持一致以免造成视觉回归；
 * 两者的合并留作后续清理项。
 */
export function formatFileSize(bytes: number): string {
  const n = Number(bytes) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

/**
 * 产物卡片的体积文案（无空格：`1.5KB`；0/空值返回空串，避免卡片上出现 "0B"）。
 * 与 formatFileSize 的差异见上。
 */
export function formatArtifactSize(n: number): string {
  if (!n) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}
