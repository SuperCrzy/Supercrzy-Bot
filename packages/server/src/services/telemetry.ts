/**
 * 匿名使用统计（telemetry）— 2026-10-18
 *
 * 设计原则（老板确认「A，加」；用户量接近零，需要知道真实安装与版本分布）：
 *   ① **最小化**：只上报这 4 个字段，绝不含任何内容、路径、密钥、模型名、对话数据
 *        { iid, version, platform, firstRun }
 *   ② **可关闭**：settings 表 `telemetry.enabled = false` 即永久关闭；
 *       环境变量 `SUPERCRZY_TELEMETRY=0` 同样生效（docker/CI 用）
 *   ③ **不影响启动**：全部 fire-and-forget，失败静默，绝不阻塞、绝不重试刷屏
 *   ④ **iid 是随机 UUID**：写在 settings 表，不基于硬件/网卡/MAC，无法反推到人
 *
 * 上报时机：服务启动成功后一次（每个进程一次，不轮询）。
 * 目标端点：SUPERCRZY_TELEMETRY_URL，默认 https://updates.supercrzy.com/api/telemetry
 */
import { randomUUID } from 'crypto'
import { platform, release } from 'os'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { getDB } from './database'

const DEFAULT_ENDPOINT = 'https://updates.supercrzy.com/api/telemetry'
const TIMEOUT_MS = 5000

let _version: string | null = null

/** 版本号：从 server 的 package.json 读（单一来源，避免两处写死）。
 *  🔴 ESM 下 `__dirname` 不可用（实测为 "."），必须用 import.meta.url 推目录。
 *  tsx 下 = <pkg>/src/services；tsc 产物下 = <pkg>/dist/services
 *  ⇒ 两种情况下 ../../package.json 都指向 <pkg>/package.json */
function getAppVersion(): string {
  if (_version) return _version
  let here = ''
  try {
    here = dirname(fileURLToPath(import.meta.url))
  } catch {
    here = process.cwd()
  }
  for (const rel of ['../../package.json', '../../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, rel), 'utf8')) as { version?: unknown }
      if (typeof pkg?.version === 'string' && pkg.version) {
        _version = pkg.version
        return _version
      }
    } catch {
      /* 试下一个路径 */
    }
  }
  _version = '0.0.0'
  return _version
}

/** settings 表读写（项目里没有专门的 helper，这里用最小 SQL，不引入新依赖） */
function readSetting(key: string): string | null {
  try {
    const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}
function writeSetting(key: string, value: string): void {
  try {
    getDB()
      .prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, new Date().toISOString())
  } catch {
    /* 写失败不影响主流程 */
  }
}

/** 是否启用：环境变量优先，其次 settings；默认启用（首次运行） */
export function isTelemetryEnabled(): boolean {
  const env = process.env.SUPERCRZY_TELEMETRY
  if (env === '0' || env === 'false' || env === 'off') return false
  if (env === '1' || env === 'true' || env === 'on') return true
  const v = readSetting('telemetry.enabled')
  return !(v === 'false' || v === '0')
}

/** 取（或首次生成）匿名安装 ID —— 随机 UUID，不包含任何机器特征 */
function getInstallId(): string {
  const existing = readSetting('telemetry.iid')
  if (existing && existing.length >= 16) return existing
  const iid = randomUUID()
  writeSetting('telemetry.iid', iid)
  return iid
}

function isFirstRun(): boolean {
  const seen = readSetting('telemetry.firstReportedAt')
  if (seen) return false
  writeSetting('telemetry.firstReportedAt', new Date().toISOString())
  return true
}

/**
 * 上报一次。调用方**不需要 await**（fire-and-forget），但也返回 Promise 便于测试。
 * 任何异常都被吞掉：统计失败不能影响产品。
 */
export async function reportTelemetryOnce(reason = 'startup'): Promise<void> {
  if (!isTelemetryEnabled()) return
  const endpoint = process.env.SUPERCRZY_TELEMETRY_URL || DEFAULT_ENDPOINT
  const payload = {
    iid: getInstallId(),
    version: getAppVersion(),
    platform: `${platform()} ${release()}`.slice(0, 40),
    firstRun: isFirstRun(),
    reason,
  }
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // 离线 / DNS 失败 / 端点不存在 —— 全部静默。每进程只试一次，不重试。
  }
}
