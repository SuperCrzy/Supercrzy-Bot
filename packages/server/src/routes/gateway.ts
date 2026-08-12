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

export const gatewayRouter = new Router({ prefix: '/api/gateway' })

interface ChannelConfig {
  id: string; platform: string; name: string; enabled: boolean
  config: Record<string, any>; status: string; createdAt: string; updatedAt: string
}

export function initChannelsTable() {
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER DEFAULT 0, config TEXT DEFAULT '{}',
      status TEXT DEFAULT 'disconnected',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
}

const PLATFORM_DEFS: Record<string, any> = {
  wechat: {
    name: '微信',
    icon: 'wechat',
    description: '扫码绑定个人微信，通过 ClawBot 插件接入。扫一次码即可，无需公众号。',
    fields: [],
    isILink: true,
  },
  wecom: {
    name: '企业微信', icon: 'wecom',
    description: '接入企业微信智能机器人，支持群聊和私聊',
    fields: [
      { key:'corpId',label:'企业ID',type:'text',placeholder:'ww...',required:true },
      { key:'agentId',label:'AgentId',type:'text',placeholder:'1000001',required:true },
      { key:'secret',label:'应用Secret',type:'password',placeholder:'',required:true },
      { key:'token',label:'回调Token',type:'text',placeholder:'',required:true },
      { key:'encodingAesKey',label:'EncodingAESKey',type:'text',placeholder:'43位',required:true },
    ],
  },
  dingtalk: {
    name: '钉钉', icon: 'dingtalk',
    description: '接入钉钉机器人', fields: [
      { key:'appKey',label:'AppKey',type:'text',placeholder:'',required:true },
      { key:'appSecret',label:'AppSecret',type:'password',placeholder:'',required:true },
      { key:'mode',label:'模式',type:'select',options:['webhook','openapi','stream'],required:true },
    ],
  },
  feishu: {
    name: '飞书', icon: 'feishu',
    description: '接入飞书机器人', fields: [
      { key:'appId',label:'App ID',type:'text',placeholder:'cli_...',required:true },
      { key:'appSecret',label:'App Secret',type:'password',placeholder:'',required:true },
    ],
  },
  qq: {
    name: 'QQ', icon: 'qq',
    description: '接入QQ机器人，支持群聊@和私聊',
    fields: [
      { key:'appId',label:'App ID',type:'text',placeholder:'',required:true },
      { key:'appSecret',label:'App Secret',type:'password',placeholder:'',required:true },
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
  ctx.body = rows.map(r => ({ ...r, config: JSON.parse((r.config as any) || '{}') }))
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
  if (body.config !== undefined) { sets.push('config=?'); vals.push(JSON.stringify(body.config)) }
  if (body.status !== undefined) { sets.push('status=?'); vals.push(body.status) }

  if (body.enabled !== undefined) {
    sets.push('enabled=?'); vals.push(body.enabled ? 1 : 0)

    const channel = db.prepare('SELECT platform FROM channels WHERE id = ?').get(id) as { platform: string } | undefined
    if (body.enabled) {
      sets.push('status=?'); vals.push('connected')
      // QQ: 启动 WebSocket 连接
      if (channel?.platform === 'qq') {
        await startQQChannel(id).catch(err => {
          console.error(`[Gateway] QQ channel ${id} start failed:`, err.message)
          // 状态改为 error
          db.prepare("UPDATE channels SET status='error', updated_at=datetime('now') WHERE id=?").run(id)
        })
      }
    } else {
      sets.push('status=?'); vals.push('disconnected')
      if (channel?.platform === 'qq') {
        await stopQQChannel(id)
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
      ctx.body = { success: false, status: 'error', message: '请填写 App ID 和 App Secret' }
      return
    }
    try {
      const started = await startQQChannel(id)
      if (started) {
        db.prepare("UPDATE channels SET status='connected', enabled=1, updated_at=datetime('now') WHERE id=?").run(id)
        ctx.body = { success: true, status: 'connected' }
      } else {
        ctx.body = { success: false, status: 'error', message: '连接失败，请检查凭据' }
      }
    } catch (err: any) {
      ctx.body = { success: false, status: 'error', message: err.message }
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
    db.prepare("UPDATE channels SET status='connected', enabled=1, updated_at=datetime('now') WHERE id=?").run(id)
    ctx.body = { success: true, status: 'connected' }
  } else {
    ctx.body = { success: false, status: 'error', message: '配置不完整' }
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
    const result = await pollQRCodeStatus(qrcode, 3)
    if (result.status === 'confirmed' && result.token) {
      saveCredentials({
        token: result.token,
        baseUrl: result.baseUrl || 'https://ilinkai.weixin.qq.com',
        accountId: result.accountId || '',
        userId: result.userId || '',
        savedAt: Date.now(),
      })
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
