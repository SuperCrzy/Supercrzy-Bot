/**
 * 工具循环防护
 * 追踪工具调用签名（工具名 + 参数哈希），检测重复失败和无进展循环
 */
import { createHash } from 'crypto'

export type GuardrailDecision = 'allow' | 'warn' | 'block' | 'halt'

export interface ToolCallRecord {
  toolName: string
  argsHash: string
  failureCount: number
  successCount: number
  lastResultHash: string
  lastResultPreview: string
}

// 阈值配置
const THRESHOLDS = {
  EXACT_REPEAT_WARN: 2,      // 完全相同调用失败 2 次 → warn
  EXACT_REPEAT_BLOCK: 4,     // 完全相同调用失败 4 次 → block
  SAME_TOOL_WARN: 3,         // 同工具不同参数失败 3 次 → warn
  SAME_TOOL_HALT: 6,         // 同工具不同参数失败 6 次 → halt
  IDEMPOTENT_REPEAT_BLOCK: 3, // 幂等操作返回相同结果 3 次 → block
}

// 幂等工具（只读，重复调用是正常的）
const IDEMPOTENT_TOOLS = new Set([
  'file_read', 'file_exists', 'list_files', 'search_files',
  'web_search', 'web_fetch', 'memory_recall', 'memory_list',
  'read_terminal', 'session_search',
])

// 高危工具（需要更严格防护）
const DESTRUCTIVE_TOOLS = new Set([
  'write_file', 'patch', 'terminal',
])

export function hashArgs(args: string): string {
  return createHash('sha256').update(args).digest('hex').slice(0, 12)
}

export function hashResult(result: string): string {
  return createHash('sha256').update(result).digest('hex').slice(0, 12)
}

export class ToolGuardrailController {
  private records = new Map<string, ToolCallRecord>()  // key = toolName:argsHash
  private toolFailureCounts = new Map<string, number>() // key = toolName
  private totalBlocked = 0
  private totalHalted = 0

  /**
   * 检查工具调用是否应该被允许
   */
  check(toolName: string, args: string): { decision: GuardrailDecision; message?: string } {
    const argsHash = hashArgs(args)
    const key = `${toolName}:${argsHash}`
    const isIdempotent = IDEMPOTENT_TOOLS.has(toolName)

    // 获取或创建记录
    if (!this.records.has(key)) {
      this.records.set(key, {
        toolName,
        argsHash,
        failureCount: 0,
        successCount: 0,
        lastResultHash: '',
        lastResultPreview: '',
      })
    }

    return { decision: 'allow' }
  }

  /**
   * 记录工具执行结果，返回是否需要注入警告
   */
  recordResult(toolName: string, args: string, result: string): {
    decision: GuardrailDecision
    message?: string
  } {
    const argsHash = hashArgs(args)
    const key = `${toolName}:${argsHash}`
    const isIdempotent = IDEMPOTENT_TOOLS.has(toolName)
    const resultH = hashResult(result)

    const record = this.records.get(key) || {
      toolName, argsHash, failureCount: 0, successCount: 0,
      lastResultHash: '', lastResultPreview: '',
    }

    // 判断是否失败
    const isFailure = this.isToolFailure(toolName, result)

    if (isFailure) {
      record.failureCount++
      // 同工具总计数
      const toolTotal = (this.toolFailureCounts.get(toolName) || 0) + 1
      this.toolFailureCounts.set(toolName, toolTotal)

      // 检查同工具不同参数的总失败数
      if (toolTotal >= THRESHOLDS.SAME_TOOL_HALT) {
        this.totalHalted++
        return {
          decision: 'halt',
          message: `[Tool Guardrail] 工具 "${toolName}" 已连续失败 ${toolTotal} 次（不同参数），停止调用。请换一种完全不同的方法，或直接告诉用户遇到的问题。`,
        }
      }
      if (toolTotal >= THRESHOLDS.SAME_TOOL_WARN) {
        return {
          decision: 'warn',
          message: `[Tool Guardrail] 工具 "${toolName}" 已失败 ${toolTotal} 次。请分析失败模式，考虑换工具或换方法。`,
        }
      }

      // 检查完全相同调用的失败数
      if (record.failureCount >= THRESHOLDS.EXACT_REPEAT_BLOCK) {
        this.totalBlocked++
        return {
          decision: 'block',
          message: `[Tool Guardrail] 完全相同的调用 "${toolName}(${argsHash})" 已失败 ${record.failureCount} 次，阻止继续。请用不同参数或换工具。`,
        }
      }
      if (record.failureCount >= THRESHOLDS.EXACT_REPEAT_WARN) {
        return {
          decision: 'warn',
          message: `[Tool Guardrail] 调用 "${toolName}(${argsHash})" 已失败 ${record.failureCount} 次。`,
        }
      }
    } else {
      // 成功 — 重置该调用的失败计数
      record.failureCount = 0
      record.successCount++

      // 幂等工具：检测返回相同结果（无进展）
      if (isIdempotent && record.lastResultHash === resultH) {
        // 相同结果不一定是问题，只在连续多次时警告
        if (record.successCount >= THRESHOLDS.IDEMPOTENT_REPEAT_BLOCK) {
          return {
            decision: 'block',
            message: `[Tool Guardrail] 幂等工具 "${toolName}" 连续返回相同结果 ${record.successCount} 次，已无新信息可获取。`,
          }
        }
      }

      // 成功时重置同工具总失败计数
      this.toolFailureCounts.set(toolName, 0)
    }

    record.lastResultHash = resultH
    record.lastResultPreview = result.slice(0, 100)
    this.records.set(key, record)

    return { decision: 'allow' }
  }

  /**
   * 判断工具结果是否为失败
   */
  private isToolFailure(toolName: string, result: string): boolean {
    // terminal 工具：检查 exit code
    if (toolName === 'terminal' || toolName === 'execute_code') {
      if (result.includes('"exit_code": 1') || result.includes('"exit_code": 2')) return true
      // 但也排除一些正常的非零退出
      if (result.includes('exit_code') && !result.includes('"exit_code": 0')) return true
    }

    // 文件操作：检查明确错误
    if (toolName === 'write_file' || toolName === 'patch') {
      if (result.includes('"error"') && !result.includes('"files_modified"')) return true
    }

    // 通用失败模式（精确匹配，避免误报）
    if (result.startsWith('Error:')) return true
    if (result.startsWith('ERROR ')) return true
    if (result.includes('command failed')) return true
    if (result.includes('ENOENT')) return true
    if (result.includes('EACCES')) return true
    if (result.includes('Permission denied')) return true
    if (result.includes('Unknown tool')) return true
    if (result.includes('BLOCKED:')) return true

    // 排除误报：内容中提到 error 但不是错误本身
    return false
  }

  /**
   * 重置所有状态（新 turn 开始时调用）
   */
  reset(): void {
    this.records.clear()
    this.toolFailureCounts.clear()
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalTracked: this.records.size,
      totalBlocked: this.totalBlocked,
      totalHalted: this.totalHalted,
    }
  }
}
