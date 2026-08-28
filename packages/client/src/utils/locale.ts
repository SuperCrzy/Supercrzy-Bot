/**
 * 语言检测工具（i18n-first）：
 * 本地偏好（localStorage）优先；无偏好时按浏览器语言检测——zh 系 → zh-CN，其余 → en-US。
 * 抽成纯函数便于 i18n 初始化 / SettingsView / 单测共用。
 */

export function detectLocale(
  saved: string | null,
  browserLang: string,
): 'zh-CN' | 'en-US' {
  if (saved === 'zh-CN' || saved === 'en-US') return saved
  try {
    const nav = (browserLang || '').toLowerCase()
    if (nav.startsWith('zh')) return 'zh-CN'
  } catch { /* ignore */ }
  return 'en-US'
}

/** 浏览器环境下的检测（无参数版，供 i18n 初始化调用） */
export function detectInitialLocale(): 'zh-CN' | 'en-US' {
  let saved: string | null = null
  try { saved = localStorage.getItem('supercrzy-lang') } catch { /* 非浏览器环境 */ }
  let browserLang = ''
  try { browserLang = navigator.language || navigator.languages?.[0] || '' } catch { /* ignore */ }
  return detectLocale(saved, browserLang)
}
