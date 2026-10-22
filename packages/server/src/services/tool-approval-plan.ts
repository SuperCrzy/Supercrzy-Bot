/**
 * 工具审批的「先判后播」计划（2026-10-22）
 *
 * 修掉的 bug（老板实测）：
 *   一条纯只读的循环命令也弹了授权框，还带 1s 倒计时：
 *   `for f in src/tools/*.ts; do grep -q "name: '" "$f" && …; done | sort | uniq -c | head -60`
 *
 * 根因（顺序错了，不是分类错了）：
 *   `agent.ts` 先把**所有敏感工具**一律以 `status:'pending'` 播给前端，**之后**才算
 *   `decideToolApproval`。低/中风险算出来是 `allow` → 命令立刻执行 → 前端那条 pending
 *   就变成"先弹一下、再被结果顶掉"的闪框，倒计时也跟着跑。
 *   分类器本身是对的（这条命令判 `allow`，风险标"低"），错的是**播报时机**。
 *
 * 正解：授权裁决是**纯函数、无 IO**，必须先全部算完再播，`pending` 只发给真要问的。
 * 本模块把这个顺序固化进结构：调用方只能拿到"计划"，没有"先播后判"的机会。
 */
import type { ApprovalRiskView } from './approval-risk'

export type ToolAction = 'allow' | 'confirm' | 'deny'

export interface ToolApprovalPlanItem {
  id: string
  name: string
  /** 是否在 `SENSITIVE_TOOLS` 里（非敏感工具不参与审批，也没有风险等级） */
  sensitive: boolean
  /** 授权裁决；非敏感工具恒为 `'allow'` */
  action: ToolAction
  /**
   * 播给前端的初始状态。**只有 `confirm` 才是 `pending`** ——
   * 这一行就是本 bug 的修复点：低/中风险（allow）必须以 `running` 开场。
   */
  status: 'pending' | 'running'
  risk?: ApprovalRiskView
}

/** 只需要这两个字段，避免与 ToolCall 类型耦合 */
export interface PlanableCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

export interface ApprovalPlanDeps {
  isSensitive: (name: string) => boolean
  decide: (name: string, args: string) => ToolAction
  risk: (name: string, args: string) => ApprovalRiskView
}

/**
 * 算出本轮每个工具调用的授权裁决与初始状态。
 * @param calls 本轮 tool_calls（顺序即播报顺序）
 */
export function planToolApprovals(calls: PlanableCall[], deps: ApprovalPlanDeps): ToolApprovalPlanItem[] {
  return calls.map((call, i) => {
    const id = call.id || `call_${i}`
    const name = call.function?.name || ''
    const args = call.function?.arguments || ''
    const sensitive = deps.isSensitive(name)
    const action: ToolAction = sensitive ? deps.decide(name, args) : 'allow'
    return {
      id,
      name,
      sensitive,
      action,
      status: action === 'confirm' ? 'pending' : 'running',
      ...(sensitive ? { risk: deps.risk(name, args) } : {}),
    }
  })
}
