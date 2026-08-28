/**
 * 双语字段工具：后端数据（技能/角色等）存中英双份（name + name_en），
 * 前端按当前界面语言取对应字段。切英文显示英文，切中文显示中文。
 */
import i18n from '@/i18n'

/** 是否为中文界面（zh / zh-CN 等） */
export function isZhLocale(): boolean {
  return i18n().global.locale.value.startsWith('zh')
}

/** 取双语字段的当前语言值：中文取 zh 字段，英文取 en 字段（缺英文回退中文，缺中文回退空） */
export function l10n(zh: string | null | undefined, en: string | null | undefined): string {
  if (isZhLocale()) return zh || en || ''
  return en || zh || ''
}
