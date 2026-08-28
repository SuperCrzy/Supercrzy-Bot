/**
 * Channel Gateway — iLink + 多平台接入
 * 微信通过 iLink 协议扫码绑定（ClawBot 插件），企业微信/钉钉/飞书/QQ 通过 API 配置
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { getDB } from '../services/database'
import { getBotQRCode, pollQRCodeStatus, saveCredentials, loadCredentials, clearCredentials, type LoginCredentials } from '../services/wechat-ilink'
import { startBot, stopBot, isBotRunning } from '../services/wechat-bot-runner'
import { startQQChannel, stopQQChannel } from '../gateway/qq-bot'
import { startTelegramChannel, stopTelegramChannel, testTelegramToken } from '../gateway/telegram-bot'
import { startDiscordChannel, stopDiscordChannel, testDiscordToken } from '../gateway/discord-bot'
import { startSlackChannel, stopSlackChannel, testSlackTokens } from '../gateway/slack-bot'
import { startDingtalkChannel, stopDingtalkChannel, testDingtalkCreds } from '../gateway/dingtalk-bot'
import { startFeishuChannel, stopFeishuChannel, testFeishuCreds } from '../gateway/feishu-bot'
import { startWecomChannel, stopWecomChannel } from '../gateway/wecom-bot'

export const gatewayRouter = new Router({ prefix: '/api/gateway' })

interface ChannelConfig {
  id: string; platform: string; name: string; enabled: boolean
  config: Record<string, any>; status: string; createdAt: string; updatedAt: string
}

export function initChannelsTable() {
  const db = getDB()
  // 建表已统一归位 database.ts（2026-08-25）；这里只保留旧库 migration：补 error_message 列
  try {
    db.exec("ALTER TABLE channels ADD COLUMN error_message TEXT DEFAULT ''")
  } catch { /* already exists */ }
}

// 需要打码的敏感配置字段（避免 token/appSecret 明文回传前端）
const SENSITIVE_KEYS = ['botToken', 'appSecret', 'secret', 'appSecretKey', 'apiKey', 'token', 'encodingAesKey']

/** 脱敏 config：敏感字段只保留前 4 位 + 掩码 */
function maskConfig(config: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(config || {})) {
    if (typeof v === 'string' && v && SENSITIVE_KEYS.includes(k)) {
      out[k] = v.length > 8 ? `${v.slice(0, 4)}••••${v.slice(-4)}` : '••••••'
    } else {
      out[k] = v
    }
  }
  return out
}

const PLATFORM_DEFS: Record<string, any> = {
  wechat: {
    name: '微信',
    icon: 'wechat',
    description: '扫码绑定个人微信，通过 ClawBot 插件接入。扫一次码即可，无需公众号。',
    fields: [],
    isILink: true,
    available: true,
  },
  wecom: {
    name: '企业微信', icon: 'wecom',
    description: '接入企微智能机器人（WebSocket 长连接，免公网回调），支持私聊与群聊',
    available: true,
    fields: [
      { key:'botId',label:'机器人 ID',type:'text',placeholder:'bot 机器人 ID',required:true },
      { key:'secret',label:'机器人 Secret',type:'password',placeholder:'',required:true },
      { key:'allowedUserIds',label:'允许的用户 ID（可选）',type:'text',placeholder:'逗号分隔，留空=允许所有',required:false },
    ],
  },
  dingtalk: {
    name: '钉钉', icon: 'dingtalk',
    description: '接入钉钉机器人（Stream 长连接，免公网回调），支持单聊与群聊@',
    available: true,
    fields: [
      { key:'clientId',label:'Client ID (AppKey)',type:'text',placeholder:'ding...',required:true },
      { key:'clientSecret',label:'Client Secret',type:'password',placeholder:'',required:true },
      { key:'allowedUserIds',label:'允许的用户 ID（可选）',type:'text',placeholder:'逗号分隔，留空=允许所有',required:false },
    ],
  },
  feishu: {
    name: '飞书', icon: 'feishu',
    description: '接入飞书机器人（官方长连接，免公网回调），支持单聊与群聊@',
    available: true,
    fields: [
      { key:'appId',label:'App ID',type:'text',placeholder:'cli_...',required:true },
      { key:'appSecret',label:'App Secret',type:'password',placeholder:'',required:true },
      { key:'allowedUserIds',label:'允许的用户 ID（可选）',type:'text',placeholder:'逗号分隔，留空=允许所有',required:false },
    ],
  },
  qq: {
    name: 'QQ', icon: 'qq',
    description: '接入QQ机器人，支持群聊@和私聊',
    available: true,
    fields: [
      { key:'appId',label:'App ID',type:'text',placeholder:'',required:true },
      { key:'appSecret',label:'App Secret',type:'password',placeholder:'',required:true },
    ],
  },
  telegram: {
    name: 'Telegram', icon: 'telegram',
    description: '接入 Telegram Bot（@BotFather 免费创建），支持私聊与群聊@提及，长轮询免公网回调',
    available: true,
    fields: [
      { key:'botToken',label:'Bot Token',type:'password',placeholder:'123456:ABC-DEF...',required:true },
      { key:'allowedUserIds',label:'允许的用户 ID（可选）',type:'text',placeholder:'逗号分隔，留空=允许所有私聊',required:false },
      { key:'baseUrl',label:'API 反代地址（可选）',type:'text',placeholder:'api.telegram.org 不通时填，如 https://tg.xx.com/bot',required:false },
    ],
  },
  discord: {
    name: 'Discord', icon: 'discord',
    description: '接入 Discord Bot（Developer Portal 创建），支持私聊 DM 与群聊@提及，WebSocket 常驻',
    available: true,
    fields: [
      { key:'botToken',label:'Bot Token',type:'password',placeholder:'MTIzNDU2...',required:true },
      { key:'allowedUserIds',label:'允许的用户 ID（可选）',type:'text',placeholder:'逗号分隔，留空=允许所有私聊',required:false },
    ],
  },
  slack: {
    name: 'Slack', icon: 'slack',
    description: '接入 Slack App（Socket Mode，免公网回调），支持私聊 DM 与群聊@提及',
    available: true,
    fields: [
      { key:'botToken',label:'Bot Token',type:'password',placeholder:'xoxb-...',required:true },
      { key:'appToken',label:'App Token',type:'password',placeholder:'xapp-...（需 connections:write 权限）',required:true },
      { key:'allowedUserIds',label:'允许的用户 ID（可选）',type:'text',placeholder:'逗号分隔，留空=允许所有私聊',required:false },
    ],
  },
}

// ============================
// Platform & Channel CRUD
// ============================

gatewayRouter.get('/platforms', (ctx: Context) => {
  ctx.body = Object.entries(PLATFORM_DEFS).map(([id, def]) => ({ id, ...def }))
})

gatewayRouter.get('/channels', (ctx: Context) => {
  const rows = getDB().prepare('SELECT * FROM channels ORDER BY created_at DESC').all() as ChannelConfig[]
  ctx.body = rows.map(r => ({
    ...r,
    config: maskConfig(JSON.parse((r.config as any) || '{}')),
    errorMessage: (r as any).error_message || '',
  }))
})

gatewayRouter.post('/channels', (ctx: Context) => {
  const db = getDB()
  const body = ctx.request.body as any
  if (!body.platform || !body.name) { ctx.status=400; ctx.body={error:'platform and name required'}; return }
  const id = body.id || `ch_${Date.now()}`
  db.prepare('INSERT INTO channels (id,platform,name,config) VALUES (?,?,?,?)').run(id, body.platform, body.name, JSON.stringify(body.config||{}))
  ctx.body = { success: true, id }; ctx.status=201
})

gatewayRouter.put('/channels/:id', async (ctx: Context) => {
  const db = getDB()
  const { id } = ctx.params
  const body = ctx.request.body as any
  const sets: string[] = []; const vals: any[] = []

  if (body.name !== undefined) { sets.push('name=?'); vals.push(body.name) }
  if (body.config !== undefined) {
    // 合并语义 + 掩码保护：以旧配置为基，新值覆盖；掩码值（••••）不覆盖真实凭据
    const existing = db.prepare('SELECT config FROM channels WHERE id = ?').get(id) as { config: string } | undefined
    let merged = body.config
    if (existing) {
      const old = JSON.parse(existing.config || '{}')
      merged = { ...old, ...body.config }
      for (const k of Object.keys(body.config)) {
        const v = body.config[k]
        if (typeof v === 'string' && v.includes('••••') && old[k]) {
          merged[k] = old[k] // 掩码值 → 保留原值
        }
      }
    }
    sets.push('config=?'); vals.push(JSON.stringify(merged))
  }
  if (body.status !== undefined) { sets.push('status=?'); vals.push(body.status) }

  if (body.enabled !== undefined) {
    sets.push('enabled=?'); vals.push(body.enabled ? 1 : 0)

    const channel = db.prepare('SELECT platform FROM channels WHERE id = ?').get(id) as { platform: string } | undefined
    if (body.enabled) {
      sets.push('status=?'); vals.push('connected')
      sets.push('error_message=?'); vals.push('')
      // QQ: 启动 WebSocket 连接
      if (channel?.platform === 'qq') {
        await startQQChannel(id).catch(err => {
          console.error(`[Gateway] QQ channel ${id} start failed:`, err.message)
          // 状态改为 error + 记录错误
          db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run(err.message?.slice(0, 300) || '连接失败', id)
        })
      }
      // Telegram: 启动长轮询（真实校验 token，失败置 error）
      if (channel?.platform === 'telegram') {
        const ok = await startTelegramChannel(id).catch((err: any) => {
          console.error(`[Gateway] Telegram channel ${id} start failed:`, err.message)
          return false
        })
        if (!ok) {
          db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run('启动失败：token 无效或网络不可达', id)
        }
      }
      // Discord: 启动 WebSocket（真实校验 token，失败置 error）
      if (channel?.platform === 'discord') {
        const ok = await startDiscordChannel(id).catch((err: any) => {
          console.error(`[Gateway] Discord channel ${id} start failed:`, err.message)
          return false
        })
        if (!ok) {
          db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run('启动失败：token 无效或网络不可达', id)
        }
      }
      // Slack: 启动 Socket Mode（真实校验 token，失败置 error）
      if (channel?.platform === 'slack') {
        const ok = await startSlackChannel(id).catch((err: any) => {
          console.error(`[Gateway] Slack channel ${id} start failed:`, err.message)
          return false
        })
        if (!ok) {
          db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run('启动失败：token 无效或网络不可达', id)
        }
      }
      // 钉钉/飞书/企微: 启动长连接
      if (channel?.platform === 'dingtalk') {
        const ok = await startDingtalkChannel(id).catch((err: any) => {
          console.error(`[Gateway] Dingtalk channel ${id} start failed:`, err.message)
          return false
        })
        if (!ok) {
          db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run('启动失败：凭据无效或网络不可达', id)
        }
      }
      if (channel?.platform === 'feishu') {
        const ok = await startFeishuChannel(id).catch((err: any) => {
          console.error(`[Gateway] Feishu channel ${id} start failed:`, err.message)
          return false
        })
        if (!ok) {
          db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run('启动失败：凭据无效或网络不可达', id)
        }
      }
      if (channel?.platform === 'wecom') {
        const ok = await startWecomChannel(id).catch((err: any) => {
          console.error(`[Gateway] Wecom channel ${id} start failed:`, err.message)
          return false
        })
        if (!ok) {
          db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run('启动失败：凭据无效或网络不可达', id)
        }
      }
    } else {
      sets.push('status=?'); vals.push('disconnected')
      sets.push('error_message=?'); vals.push('')
      if (channel?.platform === 'qq') {
        await stopQQChannel(id)
      }
      if (channel?.platform === 'telegram') {
        await stopTelegramChannel(id)
      }
      if (channel?.platform === 'discord') {
        await stopDiscordChannel(id)
      }
      if (channel?.platform === 'slack') {
        await stopSlackChannel(id)
      }
      if (channel?.platform === 'dingtalk') {
        await stopDingtalkChannel(id)
      }
      if (channel?.platform === 'feishu') {
        await stopFeishuChannel(id)
      }
      if (channel?.platform === 'wecom') {
        await stopWecomChannel(id)
      }
    }
  }

  if (sets.length === 0) { ctx.body = { success: true }; return }
  sets.push("updated_at=datetime('now')"); vals.push(id)
  db.prepare(`UPDATE channels SET ${sets.join(',')} WHERE id=?`).run(...vals)
  ctx.body = { success: true }
})

gatewayRouter.delete('/channels/:id', async (ctx: Context) => {
  const { id } = ctx.params
  const channel = getDB().prepare('SELECT platform FROM channels WHERE id = ?').get(id) as { platform: string } | undefined
  if (channel?.platform === 'qq') {
    await stopQQChannel(id)
  }
  if (channel?.platform === 'telegram') {
    await stopTelegramChannel(id)
  }
  if (channel?.platform === 'discord') {
    await stopDiscordChannel(id)
  }
  if (channel?.platform === 'slack') {
    await stopSlackChannel(id)
  }
  if (channel?.platform === 'dingtalk') {
    await stopDingtalkChannel(id)
  }
  if (channel?.platform === 'feishu') {
    await stopFeishuChannel(id)
  }
  if (channel?.platform === 'wecom') {
    await stopWecomChannel(id)
  }
  getDB().prepare('DELETE FROM channels WHERE id=?').run(id)
  ctx.body = { success: true }
})

gatewayRouter.post('/channels/:id/test', async (ctx: Context) => {
  const db = getDB()
  const { id } = ctx.params
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelConfig | undefined

  if (!channel) { ctx.status = 404; ctx.body = { error: 'Channel not found' }; return }

  const config = JSON.parse((channel.config as any) || '{}')

  // QQ: 真实连接测试
  if (channel.platform === 'qq') {
    if (!config.appId || !config.appSecret) {
      ctx.body = { success: false, status: 'error', message: '请填写 App ID 和 App Secret', code: 'NEED_CREDENTIALS' }
      return
    }
    try {
      const started = await startQQChannel(id)
      if (started) {
        db.prepare("UPDATE channels SET status='connected', enabled=1, error_message='', updated_at=datetime('now') WHERE id=?").run(id)
        ctx.body = { success: true, status: 'connected' }
      } else {
        db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run('连接失败，请检查凭据', id)
        ctx.body = { success: false, status: 'error', message: '连接失败，请检查凭据', code: 'CONNECT_FAILED' }
      }
    } catch (err: any) {
      db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run(err.message?.slice(0, 300) || '连接失败', id)
      ctx.body = { success: false, status: 'error', message: err.message }
    }
    return
  }

  // Telegram: 真实 getMe 校验 token
  if (channel.platform === 'telegram') {
    if (!config.botToken) {
      ctx.body = { success: false, status: 'error', message: '请填写 Bot Token', code: 'NEED_CREDENTIALS' }
      return
    }
    const test = await testTelegramToken(config.botToken, config.baseUrl)
    if (test.ok) {
      // 校验通过即尝试启动
      const started = await startTelegramChannel(id)
      if (started) {
        db.prepare("UPDATE channels SET status='connected', enabled=1, error_message='', updated_at=datetime('now') WHERE id=?").run(id)
      }
      ctx.body = { success: started, status: started ? 'connected' : 'error', message: started ? `已连接 @${test.username}` : '连接失败', username: test.username }
    } else {
      db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run(test.error?.slice(0, 300) || 'Token 无效', id)
      ctx.body = { success: false, status: 'error', message: test.error || 'Token 无效', code: 'INVALID_TOKEN' }
    }
    return
  }

  // Discord: 真实 getMe 校验 token
  if (channel.platform === 'discord') {
    if (!config.botToken) {
      ctx.body = { success: false, status: 'error', message: '请填写 Bot Token', code: 'NEED_CREDENTIALS' }
      return
    }
    const test = await testDiscordToken(config.botToken)
    if (test.ok) {
      const started = await startDiscordChannel(id)
      if (started) {
        db.prepare("UPDATE channels SET status='connected', enabled=1, error_message='', updated_at=datetime('now') WHERE id=?").run(id)
      }
      ctx.body = { success: started, status: started ? 'connected' : 'error', message: started ? `已连接 @${test.username}` : '连接失败', username: test.username }
    } else {
      db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run(test.error?.slice(0, 300) || 'Token 无效', id)
      ctx.body = { success: false, status: 'error', message: test.error || 'Token 无效', code: 'INVALID_TOKEN' }
    }
    return
  }

  // Slack: 真实校验（apps.connections.open 验证 xapp token）
  if (channel.platform === 'slack') {
    if (!config.botToken || !config.appToken) {
      ctx.body = { success: false, status: 'error', message: '请填写 Bot Token 和 App Token', code: 'NEED_CREDENTIALS' }
      return
    }
    const test = await testSlackTokens(config.botToken, config.appToken)
    if (test.ok) {
      const started = await startSlackChannel(id)
      if (started) {
        db.prepare("UPDATE channels SET status='connected', enabled=1, error_message='', updated_at=datetime('now') WHERE id=?").run(id)
      }
      ctx.body = { success: started, status: started ? 'connected' : 'error', message: started ? '已连接' : '连接失败' }
    } else {
      db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run(test.error?.slice(0, 300) || 'Token 无效', id)
      ctx.body = { success: false, status: 'error', message: test.error || 'Token 无效', code: 'INVALID_TOKEN' }
    }
    return
  }

  // 钉钉: 真实校验（注册 Stream 连接）
  if (channel.platform === 'dingtalk') {
    if (!config.clientId || !config.clientSecret) {
      ctx.body = { success: false, status: 'error', message: '请填写 Client ID 和 Client Secret', code: 'NEED_CREDENTIALS' }
      return
    }
    const test = await testDingtalkCreds(config.clientId, config.clientSecret)
    if (test.ok) {
      const started = await startDingtalkChannel(id)
      if (started) {
        db.prepare("UPDATE channels SET status='connected', enabled=1, error_message='', updated_at=datetime('now') WHERE id=?").run(id)
      }
      ctx.body = { success: started, status: started ? 'connected' : 'error', message: started ? '已连接' : '连接失败' }
    } else {
      db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run(test.error?.slice(0, 300) || '凭据无效', id)
      ctx.body = { success: false, status: 'error', message: test.error || '凭据无效', code: 'INVALID_TOKEN' }
    }
    return
  }

  // 飞书: 真实校验（请求 tenant token）
  if (channel.platform === 'feishu') {
    if (!config.appId || !config.appSecret) {
      ctx.body = { success: false, status: 'error', message: '请填写 App ID 和 App Secret', code: 'NEED_CREDENTIALS' }
      return
    }
    const test = await testFeishuCreds(config.appId, config.appSecret)
    if (test.ok) {
      const started = await startFeishuChannel(id)
      if (started) {
        db.prepare("UPDATE channels SET status='connected', enabled=1, error_message='', updated_at=datetime('now') WHERE id=?").run(id)
      }
      ctx.body = { success: started, status: started ? 'connected' : 'error', message: started ? '已连接' : '连接失败' }
    } else {
      db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run(test.error?.slice(0, 300) || '凭据无效', id)
      ctx.body = { success: false, status: 'error', message: test.error || '凭据无效', code: 'INVALID_TOKEN' }
    }
    return
  }

  // 企微: WebSocket 订阅校验（等待订阅 ack 结果）
  if (channel.platform === 'wecom') {
    if (!config.botId || !config.secret) {
      ctx.body = { success: false, status: 'error', message: '请填写机器人 ID 和 Secret', code: 'NEED_CREDENTIALS' }
      return
    }
    const { testWecomConnection } = await import('../gateway/wecom-bot')
    const test = await testWecomConnection(config.botId, config.secret)
    if (test.ok) {
      const started = await startWecomChannel(id)
      if (started) {
        db.prepare("UPDATE channels SET status='connected', enabled=1, error_message='', updated_at=datetime('now') WHERE id=?").run(id)
      }
      ctx.body = { success: started, status: started ? 'connected' : 'error', message: started ? '已连接' : '连接失败' }
    } else {
      db.prepare("UPDATE channels SET status='error', error_message=?, updated_at=datetime('now') WHERE id=?").run(test.error?.slice(0, 300) || '连接失败', id)
      ctx.body = { success: false, status: 'error', message: test.error || '连接失败：凭据无效或网络不可达', code: 'INVALID_TOKEN' }
    }
    return
  }

  // 其他平台：字段校验
  const hasRequired = channel.platform === 'wecom'
    ? config.corpId && config.secret
    : channel.platform === 'dingtalk'
    ? config.appKey && config.appSecret
    : config.appId

  if (hasRequired) {
    db.prepare("UPDATE channels SET status='connected', enabled=1, error_message='', updated_at=datetime('now') WHERE id=?").run(id)
    ctx.body = { success: true, status: 'connected' }
  } else {
    ctx.body = { success: false, status: 'error', message: '配置不完整', code: 'CONFIG_INCOMPLETE' }
  }
})

// ============================
// 汇总状态（网关页状态轮询用）
// ============================

gatewayRouter.get('/status', (ctx: Context) => {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM channels ORDER BY created_at DESC').all() as ChannelConfig[]
  const wechatCreds = loadCredentials()

  ctx.body = {
    wechat: {
      connected: !!wechatCreds,
      running: isBotRunning(),
      accountId: wechatCreds?.accountId || null,
      savedAt: wechatCreds?.savedAt || null,
    },
    channels: rows.map(r => ({
      id: r.id,
      platform: r.platform,
      name: r.name,
      enabled: !!r.enabled,
      status: r.status,
      errorMessage: (r as any).error_message || '',
      hasConfig: Object.keys(JSON.parse((r.config as any) || '{}')).length > 0,
    })),
  }
})

// ============================
// WeChat iLink — 扫码绑定
// ============================

gatewayRouter.get('/wechat/qrcode', async (ctx: Context) => {
  try {
    const qr = await getBotQRCode()
    ctx.body = {
      qrDataUrl: qr.qrDataUrl,
      qrcode: qr.qrcode,
      expiresAt: qr.expiresAt,
    }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
})

gatewayRouter.get('/wechat/qrcode/status', async (ctx: Context) => {
  const qrcode = ctx.query.qrcode as string
  if (!qrcode) { ctx.status=400; ctx.body={error:'qrcode required'}; return }

  try {
    // 单次查询（不内部长轮询）：扫码确认节奏由前端控制（每 3s 查一次），
    // 避免"后端 6s 窗口内未确认就过期"导致扫码授权了却存不上凭据
    const result = await pollQRCodeStatus(qrcode, 1)
    console.log(`[WeChat] qrcode status=${result.status} hasToken=${!!result.token}`)
    if (result.status === 'confirmed' && result.token) {
      saveCredentials({
        token: result.token,
        baseUrl: result.baseUrl || 'https://ilinkai.weixin.qq.com',
        accountId: result.accountId || '',
        userId: result.userId || '',
        savedAt: Date.now(),
      })
      console.log(`[WeChat] ✅ 凭据已保存 accountId=${result.accountId || '(空)'}`)
      ctx.body = { status: 'confirmed' }

      startBot(async (userId, text) => {
        try {
          const res = await fetch(`http://localhost:${process.env.PORT||'3000'}/api/chat/agent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: [{ role: 'user', content: text }],
              model: 'deepseek-v4-pro',
            }),
          })
          if (!res.ok) return 'Sorry, Agent is busy.'
          const reader = res.body?.getReader()
          if (!reader) return ''
          const decoder = new TextDecoder(); let buf = ''; let result = ''
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            for (const line of buf.split('\n')) {
              if (line.startsWith('data: ')) {
                try { const d = JSON.parse(line.slice(6)); if (d.content) result = d.content } catch {}
              }
            }
            buf = buf.includes('\n') ? buf.split('\n').pop() || '' : ''
          }
          return result || 'No response'
        } catch {
          return 'Sorry, something went wrong.'
        }
      })
    } else {
      ctx.body = { status: result.status }
    }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
})

gatewayRouter.get('/wechat/status', (ctx: Context) => {
  const creds = loadCredentials()
  ctx.body = {
    connected: !!creds,
    running: isBotRunning(),
    accountId: creds?.accountId || null,
    savedAt: creds?.savedAt || null,
  }
})

gatewayRouter.post('/wechat/disconnect', (ctx: Context) => {
  stopBot()
  clearCredentials()
  ctx.body = { success: true }
})

gatewayRouter.get('/wechat/debug-poll', async (ctx: Context) => {
  const { getUpdates } = await import('../services/wechat-ilink')
  const creds = (await import('../services/wechat-ilink')).loadCredentials()
  if (!creds) { ctx.body = { error: 'Not connected' }; return }
  try {
    const resp = await getUpdates(creds.baseUrl, creds.token, '')
    ctx.body = { connected: true, msgs: resp.msgs, buf: resp.get_updates_buf?.slice(0, 40) }
  } catch (err: any) {
    ctx.body = { error: err.message }
  }
})

// ============================
// 通用二维码生成（DetailPanel 手机扫码预览等场景）
// ============================

gatewayRouter.get('/qrcode', async (ctx: Context) => {
  const text = (ctx.query.text as string) || ''
  if (!text) {
    ctx.status = 400
    ctx.body = { error: 'text query param is required' }
    return
  }
  try {
    const QRCode = (await import('qrcode')).default
    const qrDataUrl = await QRCode.toDataURL(text, { width: 200, margin: 1 })
    ctx.body = { qrDataUrl }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

export default gatewayRouter
