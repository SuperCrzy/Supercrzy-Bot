/**
 * 巨石文件体量闸门（P1-04 配套，2026-09-17）
 *
 * 报告 P1-04 指出 ChatView / DetailPanel 体量过大属**维护性风险**。风险要可度量才不会
 * 悄悄恶化，所以这里设一个"棘轮"：超过上限即失败，并提示应该抽离而不是继续长。
 *
 * 上限取值 = 上一次实测值 + 少量余量（容忍正常小改动）。
 * 目标方向是**逐步下调**，不是上调；需要上调时请先在 PR 里说明为什么。
 *
 * 2026-09-24：DetailPanel 抽离 AI 浏览器（逻辑 331 + 模板 100 + 样式 48）后 1403 → 933，
 * 上限同步由 1180 **下调到 1000**，把这次收益锁住。
 *
 * ⚠️ **口径必须连外链样式一起数**。只数 .vue 自身的行数，一行 `import './x.css'` 就能绕开
 * 这个闸门：ChatView 样式段 2360 行占它 37%，外链出去立刻"达标"，而复杂度一点没降。
 * 所以本文件不只数行数，还**强制检查外链**：
 *   - 计入总量 = .vue 自身行数 + 它 import 的本地 css 行数（`extra`）；
 *   - 若源码里出现了本地 css import 却不在 `extra` 里 → **直接失败**（"未登记的绕行"）。
 *     ⇒ 这个断言让"把样式搬到隔壁文件"从"绕过闸门"变成"必须显式申报"。
 *
 * 用 Vite 的 `?raw` 读源码（client tsconfig 的 types 只有 vite/client，没有 node 类型，
 * 直接 import 'node:fs' 会 TS2307）。
 */
import { describe, it, expect } from 'vitest'
import chatViewSrc from '../views/ChatView.vue?raw'
import detailPanelSrc from '../components/layout/DetailPanel.vue?raw'

interface LimitEntry {
  name: string
  src: string
  max: number
  hint: string
  /** 该组件 import 的本地样式：路径 → 源码。抽样式时必须在这里登记，否则下面的断言会失败。 */
  extra?: Record<string, string>
}

/** 上限（实测 2026-09-24：ChatView 5457 / DetailPanel 933） */
const LIMITS: LimitEntry[] = [
  {
    name: 'views/ChatView.vue',
    src: chatViewSrc,
    // 2026-09-18：把交付页判定（utils/artifact-kind）与对话导出（utils/share-export）
    // 下沉后由 6550 收紧到 6460，锁定这次收益；后续继续**下调**才是方向。
    // 2026-09-24 I10 低风险批：14 个状态型单元下沉（useInputHistory / useInputHeight /
    // chat-text / useQuote / useMessageWindow / svg-extract / useCodeBlocks / useAttachments /
    // useInputTrigger / useArtifacts / useHistorySearch / useShareExport / useAskQuestion /
    // useWelcomePanel）后 6424 → 5457，上限同步 6460 → 5500。
    // ⚠️ 仍未下沉的是**核心链路**（handleAgentEvent 430 行 + 发送管线 ~640 行），
    // 那批要单独开一次、单独验证，不要混进低风险改动里。
    max: 5500,
    hint: 'ChatView 已超体量上限。请把纯逻辑下沉到 utils/ 或抽成 composables/、components/chat/ 子组件（参考已下沉的 utils/stage.ts、utils/trigger.ts、utils/message-text.ts、utils/delivery.ts、utils/artifact-kind.ts、utils/share-export.ts 与 composables/useInputTrigger.ts、useWelcomePanel.ts），而不是继续加行。',
  },
  {
    name: 'components/layout/DetailPanel.vue',
    src: detailPanelSrc,
    // 2026-09-24：AI 浏览器抽成 components/layout/AiBrowserPanel.vue +
    // composables/useAiBrowser.ts 后 1403 → 933，上限同步 1180 → 1000。
    max: 1000,
    hint: 'DetailPanel 已超体量上限。请把各 tab 的内容抽成独立子组件后再加功能（参考已抽离的 AiBrowserPanel.vue），或继续下调上限。',
  },
]

/** 源码里 import 的本地样式路径（相对路径 .css/.scss/.less） */
function localStyleImports(src: string): string[] {
  const out: string[] = []
  const re = /import\s+['"](\.[^'"]+\.(?:css|scss|less))['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(m[1])
  return out
}

describe('巨石文件体量闸门', () => {
  for (const { name, src, max, hint, extra } of LIMITS) {
    const extraLines = Object.values(extra ?? {}).reduce((n, s) => n + s.split('\n').length, 0)
    const total = src.split('\n').length + extraLines
    const detail = extraLines ? `（自身 ${src.split('\n').length} + 外链样式 ${extraLines}）` : ''

    it(`${name} 不超过 ${max} 行`, () => {
      expect(total, `${name} 当前 ${total} 行${detail}（上限 ${max}）。${hint}`).toBeLessThanOrEqual(max)
    })

    it(`${name} 的外链样式已登记进闸门`, () => {
      const declared = new Set(Object.keys(extra ?? {}))
      const undeclared = localStyleImports(src).filter((p) => !declared.has(p))
      expect(
        undeclared,
        `${name} import 了未登记的本地样式 ${undeclared.join(', ')}。` +
          '把样式搬出 .vue 会让行数"达标"但复杂度没降 —— 请在本文件 LIMITS 的 extra 里登记，' +
          '让这些行数一起计入上限。',
      ).toEqual([])
    })
  }
})
