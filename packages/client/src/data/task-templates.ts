/**
 * 任务模板（阶段三-④ 首用引导配套，2026-09-18）
 *
 * 目的：新用户打开是空白输入框，不知道该输入什么——这是"新用户不看文档也能完成第一个任务"
 * （docs/SUPERCRZY_PRODUCT_OPTIMIZATION_AUDIT_2026-09-15.md 阶段三完成标准）的第一个门槛。
 * 模板用"一句话示例"替用户跨过门槛：点了就把 prompt 填进输入框（**不直接发送**，
 * 用户能看见将要发什么、还能改），比"教功能"更直接。
 *
 * 选取原则：
 * - 每个模板对应一条**真实存在**的能力链（会联网的才写联网，会写文件的才说产物），
 *   宁少勿虚——模板点了做不出来，比没有模板更伤。
 * - 第一条放"必然能成"的任务（联网查资料），新用户第一炮不该失败。
 * - 需要工作区的任务（读代码）排在后面，并在描述里点明要先选工作区，避免点了报错。
 *
 * 文案走 i18n（zh/en 各一份，见 i18n/index.ts 的 tmpl* 键），本文件只放结构与图标。
 * 图标是内联 SVG 路径（**不用 emoji**，符合老板硬性要求），描边风格，24×24 viewBox。
 */

export interface TaskTemplate {
  /** i18n 键后缀：title / desc / prompt 分别为 `tmpl_<id>` / `tmpl_<id>_d` / `tmpl_<id>_p` */
  id: string
  /** 分类色 token（tokens.css 里的 --cat-*），用于图标底色区分能力族 */
  tone: 'cat-research' | 'cat-writing' | 'cat-analysis' | 'cat-coding' | 'cat-automation'
  /** 图标路径（支持多段，均为 stroke 描边） */
  paths: string[]
}

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: 'research',
    tone: 'cat-research',
    paths: [
      'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
      'M2 12h20',
      'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
    ],
  },
  {
    id: 'write',
    tone: 'cat-writing',
    paths: [
      'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
      'M14 2v6h6',
      'M9 13h6',
      'M9 17h4',
    ],
  },
  {
    id: 'data',
    tone: 'cat-analysis',
    paths: ['M3 3v18h18', 'M7 15v-5', 'M12 17V8', 'M17 15v-8'],
  },
  {
    id: 'code',
    tone: 'cat-coding',
    paths: ['M8 5l-7 7 7 7', 'M16 5l7 7-7 7'],
  },
  {
    id: 'image',
    tone: 'cat-automation',
    paths: [
      'M3 3h18v18H3z',
      'M8.5 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
      'M21 15l-5-5L5 21',
    ],
  },
  {
    id: 'schedule',
    tone: 'cat-automation',
    paths: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 6v6l4 2'],
  },
]

/** 模板张数上限（欢迎页不要变成功能列表；也便于测试锁定渲染数量） */
export const MAX_WELCOME_TEMPLATES = 6

/** 隐藏模板区的 localStorage 键（沿用 supercrzy: 前缀约定） */
export const TEMPLATES_HIDDEN_KEY = 'supercrzy:welcomeTemplatesHidden'

/** 模板的 i18n 键（单一出处，组件与测试都用它，避免手写字符串不一致） */
export function templateKeys(id: string): { title: string; desc: string; prompt: string } {
  return { title: `chat.tmpl_${id}`, desc: `chat.tmpl_${id}_d`, prompt: `chat.tmpl_${id}_p` }
}

/**
 * 解析模板 prompt 文案。
 *
 * vue-i18n 在 key 缺失时**回传 key 本身**（项目历史上踩过"新 key 只在一种语言里加了"的坑），
 * 那种情况下绝不能把 `chat.tmpl_xxx_p` 这串当 prompt 填进输入框——用户会看到一串 key 被发出去。
 * 所以这里显式判定"取到的值是否等于 key"，等于就当作缺失。
 */
export function resolveTemplatePrompt(translate: (key: string) => string, id: string): string {
  const key = templateKeys(id).prompt
  const value = translate(key)
  return value && value !== key ? value : ''
}
