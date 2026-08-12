/**
 * 后端错误消息本地化
 * 后端错误带 code 时按 errors.<code> 词条翻译；无 code 或词条缺失时回退原文
 */
import i18n from '@/i18n'

export function errMsg(code: string | undefined, fallback: string): string {
  if (!code) return fallback
  const key = `errors.${code}`
  const t = i18n().global.t
  return i18n().global.te(key) ? t(key) : fallback
}
