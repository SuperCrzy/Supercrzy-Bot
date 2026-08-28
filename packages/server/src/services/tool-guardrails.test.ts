import { describe, it, expect } from 'vitest'
import { hashArgs, hashResult, ToolGuardrailController } from './tool-guardrails'

describe('tool-guardrails', () => {
  it('hashArgs 确定性且定长', () => {
    const h1 = hashArgs('{"file":"a.txt"}')
    const h2 = hashArgs('{"file":"a.txt"}')
    expect(h1).toBe(h2)
    expect(h1).toHaveLength(12)
    expect(hashArgs('{"file":"a.txt"}')).not.toBe(hashArgs('{"file":"b.txt"}'))
  })

  it('hashResult 确定性', () => {
    expect(hashResult('ok result')).toBe(hashResult('ok result'))
  })

  it('首次调用 check 返回 allow', () => {
    const c = new ToolGuardrailController()
    expect(c.check('file_read', '{"path":"/tmp/a"}').decision).toBe('allow')
  })

  it('完全相同调用失败 2 次 → warn，6 次 → halt（同工具总失败检查优先，EXACT_REPEAT_BLOCK 不可达）', () => {
    const c = new ToolGuardrailController()
    const tool = 'shell_exec'
    const args = '{"command":"ls /nonexistent-xyz"}'
    // 1 次 → allow；2 次 → EXACT_REPEAT_WARN(2) → warn
    expect(c.recordResult(tool, args, '❌ command failed: No such file').decision).toBe('allow')
    expect(c.recordResult(tool, args, '❌ command failed: No such file').decision).toBe('warn')
    // 3-5 次 → SAME_TOOL_WARN(3) 优先 → warn
    expect(c.recordResult(tool, args, '❌ command failed: No such file').decision).toBe('warn')
    expect(c.recordResult(tool, args, '❌ command failed: No such file').decision).toBe('warn')
    expect(c.recordResult(tool, args, '❌ command failed: No such file').decision).toBe('warn')
    // 6 次 → SAME_TOOL_HALT(6) → halt
    expect(c.recordResult(tool, args, '❌ command failed: No such file').decision).toBe('halt')
  })

  it('同工具不同参数失败 6 次 → halt', () => {
    const c = new ToolGuardrailController()
    const tool = 'shell_exec'
    let last = 'allow'
    for (let i = 0; i < 6; i++) {
      last = c.recordResult(tool, `{"command":"cmd-${i}"}`, '❌ command failed').decision
    }
    expect(last).toBe('halt')
  })

  it('成功重置失败计数', () => {
    const c = new ToolGuardrailController()
    const args = '{"command":"echo ok"}'
    c.recordResult('shell_exec', args, '❌ command failed')
    c.recordResult('shell_exec', args, '❌ command failed')
    const r = c.recordResult('shell_exec', args, '✅ done')
    expect(r.decision).toBe('allow')
    // 失败计数已重置：再失败一次仍是 allow（未达 warn 阈值）
    expect(c.recordResult('shell_exec', args, '❌ command failed').decision).toBe('allow')
  })
})
