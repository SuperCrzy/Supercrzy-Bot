/**
 * 任务模板（首用引导）单测 — 2026-09-18
 *
 * 这里锁两类"看起来能跑、上线就出错"的问题：
 *
 * 1. **i18n key 只加了一种语言**。项目历史上踩过（新 key 全失效 / 渲染出 key 字符串），
 *    而模板是首用引导的第一屏，缺文案就是新用户看到的第一眼。所以逐个模板 × 逐语言做存在性断言。
 * 2. **模板点了做不出来**。模板是对用户的承诺（"会真的去搜""生成的文件会出现在产物栏"），
 *    结构和文案必须与真实能力对应：至少要有 prompt、有图标、有合法配色 token。
 */
import { describe, it, expect } from 'vitest'
import { i18nInstance } from '@/i18n'
import {
  TASK_TEMPLATES,
  MAX_WELCOME_TEMPLATES,
  TEMPLATES_HIDDEN_KEY,
  templateKeys,
  resolveTemplatePrompt,
} from '@/data/task-templates'

const LOCALES = ['zh-CN', 'en-US'] as const

describe('模板结构不变量', () => {
  it('id 唯一（v-for :key 与 i18n key 都靠它）', () => {
    const ids = TASK_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('数量不超过上限（欢迎页不是功能清单）', () => {
    expect(TASK_TEMPLATES.length).toBeGreaterThan(0)
    expect(TASK_TEMPLATES.length).toBeLessThanOrEqual(MAX_WELCOME_TEMPLATES)
  })

  it('每条都有图标路径（禁 emoji，图标必须是 SVG 路径）', () => {
    for (const tpl of TASK_TEMPLATES) {
      expect(tpl.paths.length, `${tpl.id} 缺图标`).toBeGreaterThan(0)
      for (const d of tpl.paths) expect(d.length, `${tpl.id} 路径为空`).toBeGreaterThan(4)
    }
  })

  it('tone 是 tokens.css 里真实存在的分类色', () => {
    const allowed = [
      'cat-research', 'cat-writing', 'cat-analysis',
      'cat-coding', 'cat-automation', 'cat-system', 'cat-file', 'cat-network', 'cat-memory', 'cat-general',
    ]
    for (const tpl of TASK_TEMPLATES) {
      expect(allowed, `${tpl.id} 的 tone=${tpl.tone} 不是合法 token`).toContain(tpl.tone)
    }
  })

  it('首条必须是"必然能成"的任务（新用户第一炮不该失败）', () => {
    // 联网查资料不依赖工作区、不依赖上传文件——放第一条
    expect(TASK_TEMPLATES[0].id).toBe('research')
  })
})

describe('i18n 文案在两种语言下都必须存在', () => {
  for (const locale of LOCALES) {
    describe(locale, () => {
      for (const tpl of TASK_TEMPLATES) {
        it(`${tpl.id} 的 title/desc/prompt 齐全`, () => {
          const keys = templateKeys(tpl.id)
          expect(i18nInstance.global.te(keys.title, locale), `${keys.title} 缺失`).toBe(true)
          expect(i18nInstance.global.te(keys.desc, locale), `${keys.desc} 缺失`).toBe(true)
          expect(i18nInstance.global.te(keys.prompt, locale), `${keys.prompt} 缺失`).toBe(true)

          // 值不能是空串或 key 本身（vue-i18n 取不到时会回传 key）
          for (const k of [keys.title, keys.desc, keys.prompt]) {
            const v = i18nInstance.global.t(k, {}, { locale })
            expect(v, `${k} 的值是空的或等于 key`).toBeTruthy()
            expect(v).not.toBe(k)
          }
        })
      }
    })
  }

  it('prompt 要足够长，能直接当任务发出去（不是占位符）', () => {
    for (const locale of LOCALES) {
      for (const tpl of TASK_TEMPLATES) {
        const v = i18nInstance.global.t(templateKeys(tpl.id).prompt, {}, { locale })
        expect(v.length, `${locale} 的 ${tpl.id} prompt 太短`).toBeGreaterThan(12)
      }
    }
  })

  it('模板区自身的说明文案也在两种语言下存在', () => {
    for (const locale of LOCALES) {
      for (const k of ['chat.welcomeTips', 'chat.templatesHint', 'chat.templatesWhereGoes', 'chat.templatesHide', 'chat.templatesShow']) {
        expect(i18nInstance.global.te(k, locale), `${k} 在 ${locale} 缺失`).toBe(true)
      }
    }
  })
})

describe('resolveTemplatePrompt', () => {
  it('正常取值直接返回文案', () => {
    expect(resolveTemplatePrompt(() => '帮我查资料', 'research')).toBe('帮我查资料')
  })

  it('key 缺失（vue-i18n 回传 key）时返回空串，绝不把 key 当 prompt 填进输入框', () => {
    const echoKey = (k: string) => k
    expect(resolveTemplatePrompt(echoKey, 'research')).toBe('')
  })

  it('返回空串时也不抛错', () => {
    expect(resolveTemplatePrompt(() => '', 'anything')).toBe('')
  })

  it('传入真实的 i18n t，每个模板都能解析出非空 prompt（两种语言）', () => {
    for (const locale of LOCALES) {
      const t = (k: string) => i18nInstance.global.t(k, {}, { locale })
      for (const tpl of TASK_TEMPLATES) {
        expect(resolveTemplatePrompt(t, tpl.id), `${locale}/${tpl.id}`).not.toBe('')
      }
    }
  })
})

describe('显隐偏好键', () => {
  it('沿用 supercrzy: 前缀（与项目其它本地存储约定一致）', () => {
    expect(TEMPLATES_HIDDEN_KEY.startsWith('supercrzy:')).toBe(true)
  })
})
