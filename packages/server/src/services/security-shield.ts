/**
 * AgentShield Security Scanner — 安全检查层
 * 在每条消息发送前扫描：凭据泄露、敏感数据、注入攻击
 */
import { getDB } from './database'

interface ScanResult {
  safe: boolean
  alerts: Alert[]
}

interface Alert {
  level: 'critical' | 'high' | 'medium' | 'low'
  rule: string
  message: string
  masked?: string
}

// 敏感模式库
const CREDENTIAL_PATTERNS: { name: string; regex: RegExp; level: Alert['level'] }[] = [
  { name: 'API Key', regex: /(?:api[_-]?key|apikey|access[_-]?key)\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{20,}['"]?/gi, level: 'critical' },
  { name: 'AWS Key', regex: /AKIA[0-9A-Z]{16}/g, level: 'critical' },
  { name: 'Private Key', regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g, level: 'critical' },
  { name: 'Token', regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g, level: 'critical' },
  { name: 'Password', regex: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi, level: 'high' },
  { name: 'JWT', regex: /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.(?:[A-Za-z0-9\-_]+)?/g, level: 'high' },
  { name: 'Client Secret', regex: /(?:client[_-]?secret|app[_-]?secret)\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{16,}['"]?/gi, level: 'critical' },
  { name: 'Connection String', regex: /(?:mongodb|postgresql|mysql|redis):\/\/[^@\s]+@/gi, level: 'critical' },
]

// 用户数据泄露检测
const PII_PATTERNS: { name: string; regex: RegExp; level: Alert['level'] }[] = [
  { name: 'Email', regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, level: 'medium' },
  { name: 'Phone (CN)', regex: /1[3-9]\d{9}/g, level: 'medium' },
  { name: 'ID Card', regex: /\d{17}[\dXx]/g, level: 'high' },
  { name: 'Credit Card', regex: /\b(?:\d[ -]*?){13,16}\b/g, level: 'high' },
]

let alertCount = 0

export function scanContent(content: string, source: string = 'agent'): ScanResult {
  const alerts: Alert[] = []

  // 1. 凭据扫描
  for (const pattern of CREDENTIAL_PATTERNS) {
    const matches = content.match(pattern.regex)
    if (matches) {
      for (const m of matches) {
        const masked = m.slice(0, 4) + '***' + m.slice(-4)
        alerts.push({
          level: pattern.level,
          rule: pattern.name,
          message: `Credential leak detected: ${pattern.name}`,
          masked,
        })
      }
    }
  }

  // 2. 敏感信息泄露
  for (const pattern of PII_PATTERNS) {
    if (pattern.regex.test(content)) {
      alerts.push({
        level: pattern.level,
        rule: pattern.name,
        message: `PII detected: ${pattern.name}`,
      })
      break
    }
  }

  // 3. 注入检测（检查是否有 prompt injection 特征）
  if (/(?:ignore|forget|override|disregard)\s+(?:all\s+)?(?:previous|above|prior|system)\s+(?:instructions?|prompts?|rules?|context)/i.test(content)) {
    alerts.push({
      level: 'high',
      rule: 'Prompt Injection',
      message: 'Potential prompt injection attempt detected',
    })
  }

  // Log to DB
  if (alerts.length > 0) {
    try {
      const db = getDB()
      for (const a of alerts) {
        alertCount++
        db.prepare(
          'INSERT INTO agent_memory (key, content, importance) VALUES (?, ?, ?)'
        ).run(`shield_${Date.now()}_${alertCount}`, JSON.stringify({ source, rule: a.rule, level: a.level, message: a.message }), 0.9)
      }
    } catch (_) {}
  }

  return {
    safe: alerts.filter(a => a.level === 'critical').length === 0,
    alerts,
  }
}

// 内容过滤：自动从响应中移除凭据
export function sanitizeContent(content: string): string {
  let cleaned = content
  for (const pattern of CREDENTIAL_PATTERNS) {
    cleaned = cleaned.replace(pattern.regex, (match) => `[REDACTED:${match.slice(0, 4)}...]`)
  }
  return cleaned
}
