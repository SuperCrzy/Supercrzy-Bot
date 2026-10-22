/**
 * 授权弹窗的风险等级（唯一实现，2026-10-22）
 *
 * 起因：`ToolApprovalFloating.vue` 里写的是
 *   `name === 'file_delete' ? 'high' : 'medium'`
 * —— 按**工具名**猜，于是 `shell_exec` 跑 `rm -rf /`（真·不可逆）显示"中风险"，
 * 而 `file_write` 写 `/etc/hosts`（覆盖系统文件）也是"中风险"。等级等于没有。
 *
 * 判据只有两条，且都能落到断言上：
 *   ① 能不能撤销 —— 不可撤销 = 高
 *   ② 有没有副作用 —— 有 = 中；没有 = 低（低 = 不问，不弹窗）
 *
 * 不另立阈值，直接复用分类器三值（`classifySensitiveTool`），保证"显示的等级"与
 * "实际会不会被允许跳过"是同一个事实：
 *   block → high   任何档位都恒问，"本会话全部允许"默认不能跳过（`decideToolApproval`）
 *   ask   → medium 会问一次；用户点过「本会话全部允许」后不再问 = 有副作用但可放行
 *   allow → low    不触发审批（只读/测试/查询类）
 *
 * ⚠️ 等级必须**按调用**算：同一个 `shell_exec`，`pnpm test` 是低、`sudo rm` 是中、
 *    `rm -rf dist` 是高。任何"按工具名查表"的写法都会退化成装饰。
 */
import { classifySensitiveTool } from './tools'

export type ApprovalRisk = 'low' | 'medium' | 'high'

/**
 * 为什么是这个等级（前端据此显示一行说明，避免用户只看到一个颜色）：
 *   read-only    只读/查询，无副作用
 *   side-effect  有副作用，但结果可回滚/可重做（写工作区文件、跑有副作用的命令）
 *   irreversible 不可撤销或影响系统级状态（删除、覆盖系统文件、装可执行代码、操作本机）
 */
export type ApprovalRiskReason = 'read-only' | 'side-effect' | 'irreversible'

export interface ApprovalRiskView {
  level: ApprovalRisk
  reason: ApprovalRiskReason
}

export type RiskClassifier = (toolName: string, args: string) => 'allow' | 'ask' | 'block'

/**
 * 解析一次工具调用的风险等级。
 * @param toolName 工具名（`shell_exec` / `file_delete` …）
 * @param args 参数原文（JSON 字符串）
 * @param classify 分类器（注入以便单测替换；默认即生产实现）
 */
export function resolveApprovalRisk(
  toolName: string,
  args: string,
  classify: RiskClassifier = classifySensitiveTool,
): ApprovalRiskView {
  const verdict = classify(toolName, args)
  if (verdict === 'block') return { level: 'high', reason: 'irreversible' }
  if (verdict === 'ask') return { level: 'medium', reason: 'side-effect' }
  return { level: 'low', reason: 'read-only' }
}

/** 等级是否需要在弹窗里被当成"不可逆"展示（前端用于弱化「全部允许」按钮的措辞） */
export function isIrreversibleRisk(view: ApprovalRiskView | null | undefined): boolean {
  return view?.level === 'high'
}
