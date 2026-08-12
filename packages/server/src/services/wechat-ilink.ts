/**
 * WeChat iLink Bot Service
 * 基于微信 ClawBot 的 iLink 协议实现个人微信扫码绑定
 * 协议文档: https://www.wechatbot.dev/zh/protocol
 */
import { randomUUID, randomBytes, createDecipheriv } from 'crypto'
// @ts-ignore - qrcode 类型声明缺失
import QRCode from 'qrcode'
import { existsSync, readFileSync, writeFileSync } from 'fs'

// ============================
// 随机 UIN
// ============================

function randomUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

const ILINK_BASE = 'https://ilinkai.weixin.qq.com'
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com'
const BOT_TYPE = 3
const LONG_POLL_TIMEOUT = 35000

export interface LoginCredentials {
  token: string
  baseUrl: string
  accountId: string
  userId: string
  savedAt: number
}

export interface QRCodeData {
  qrcode: string
  qrDataUrl: string
  expiresAt: number
}

// ---- 消息结构（支持文件） ----

interface ILinkItem {
  type: number
  text_item?: { text: string }
  file_item?: {
    file_name: string
    file_size: number
    file_md5?: string
    cdn_media?: {
      aes_key: string
      file_id: string
      url?: string
    }
    cdn_aes_key?: string
    cdn_file_id?: string
    cdn_url?: string
  }
  image_item?: {
    aeskey: string
    cdn_file_id?: string
    cdn_url?: string
  }
}

interface GetUpdatesResp {
  ret: number
  msgs?: Array<{
    from_user_id: string
    to_user_id: string
    client_id: string
    context_token: string
    message_type: number
    item_list?: ILinkItem[]
  }>
  get_updates_buf: string
  errcode?: number
}

// ---- 文件下载结果 ----

export interface DownloadedFile {
  fileName: string
  fileSize: number
  mimeType: string
  buffer: Buffer
  textContent?: string
}

// ---- AES Key 解析（三种格式） ----

function decodeAesKey(encoded: string): Buffer | null {
  if (!encoded) return null

  // 格式 A: base64(原始 16 字节) → 解码后正好 16 字节
  try {
    const bufA = Buffer.from(encoded, 'base64')
    if (bufA.length === 16) return bufA
  } catch { /* continue */ }

  // 格式 C: 直接 hex 字符串 32 字符 → 16 字节
  if (/^[0-9a-fA-F]{32}$/.test(encoded)) {
    return Buffer.from(encoded, 'hex')
  }

  // 格式 B: base64(hex 字符串) → 先 base64 解码 → hex → 16 字节
  try {
    const bufB = Buffer.from(encoded, 'base64')
    const hexStr = bufB.toString('utf-8')
    if (/^[0-9a-fA-F]{32}$/.test(hexStr)) {
      return Buffer.from(hexStr, 'hex')
    }
  } catch { /* continue */ }

  console.error(`[WeChat iLink] Could not decode AES key: ${encoded.slice(0, 20)}...`)
  return null
}

// PKCS7 unpad
function pkcs7Unpad(data: Buffer): Buffer {
  if (data.length === 0) return data
  const padLen = data[data.length - 1]
  if (padLen < 1 || padLen > 16) return data
  // Verify all padding bytes are correct
  for (let i = data.length - padLen; i < data.length; i++) {
    if (data[i] !== padLen) return data
  }
  return data.subarray(0, data.length - padLen)
}

function getMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() || ''
  const map: Record<string, string> = {
    txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    xml: 'application/xml', csv: 'text/csv', yaml: 'text/yaml', yml: 'text/yaml',
    log: 'text/plain', js: 'text/javascript', ts: 'text/typescript',
    html: 'text/html', css: 'text/css', py: 'text/x-python',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  }
  return map[ext] || 'application/octet-stream'
}

const TEXT_EXTS = new Set([
  'txt', 'md', 'json', 'xml', 'csv', 'yaml', 'yml', 'log',
  'js', 'ts', 'html', 'css', 'py', 'jsx', 'tsx', 'vue', 'svelte',
  'env', 'ini', 'cfg', 'sh', 'bash', 'zsh', 'sql', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'toml', 'lock',
  'gitignore', 'dockerfile', 'makefile', 'editorconfig',
])

function isTextFile(fileName: string): boolean {
  const ext = fileName.toLowerCase().split('.').pop() || ''
  if (TEXT_EXTS.has(ext)) return true
  // No extension → try to read as text
  if (!fileName.includes('.')) return true
  return false
}

// ---- 下载并解密微信文件 ----

export async function downloadFile(
  token: string,
  item: ILinkItem,
): Promise<DownloadedFile | null> {
  try {
    let aesKey = ''
    let cdnUrl = ''
    let fileId = ''

    // 从 file_item 提取 CDN 信息
    if (item.file_item) {
      const fi = item.file_item
      if (fi.cdn_media) {
        aesKey = fi.cdn_media.aes_key || ''
        fileId = fi.cdn_media.file_id || ''
        cdnUrl = fi.cdn_media.url || ''
      }
      if (!aesKey) aesKey = fi.cdn_aes_key || ''
      if (!fileId) fileId = fi.cdn_file_id || ''
      if (!cdnUrl) cdnUrl = fi.cdn_url || ''

      // 无 URL → 用 file_id 拼接
      if (!cdnUrl && fileId) {
        cdnUrl = `${CDN_BASE}/c2c/download?fileid=${encodeURIComponent(fileId)}`
      }
    } else if (item.image_item) {
      const ii = item.image_item
      aesKey = ii.aeskey || ''
      fileId = ii.cdn_file_id || ''
      cdnUrl = ii.cdn_url || ''
      if (!cdnUrl && fileId) {
        cdnUrl = `${CDN_BASE}/c2c/download?fileid=${encodeURIComponent(fileId)}`
      }
    }

    if (!cdnUrl || !aesKey) {
      console.log('[WeChat iLink] File missing CDN URL or AES key')
      return null
    }

    console.log(`[WeChat iLink] Downloading: ${cdnUrl.slice(0, 100)}`)

    // GET 下载加密文件
    const res = await fetch(cdnUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'SUPERCRZY-BOT/1.0',
      },
    })

    if (!res.ok) {
      console.error(`[WeChat iLink] CDN download HTTP ${res.status}`)
      return null
    }

    const encrypted = Buffer.from(await res.arrayBuffer())
    console.log(`[WeChat iLink] Downloaded ${encrypted.length} bytes (encrypted)`)

    // AES-128-ECB 解密
    const key = decodeAesKey(aesKey)
    if (!key || key.length !== 16) {
      console.error(`[WeChat iLink] Invalid AES key length: ${key?.length || 0}`)
      return null
    }

    const decipher = createDecipheriv('aes-128-ecb', key, null)
    decipher.setAutoPadding(false)
    let decrypted: Buffer = Buffer.concat([decipher.update(encrypted), decipher.final()])
    decrypted = pkcs7Unpad(decrypted) as Buffer

    console.log(`[WeChat iLink] Decrypted: ${decrypted.length} bytes`)

    const fileName = item.file_item?.file_name || 'unknown'
    const fileSize = item.file_item?.file_size || decrypted.length

    // 尝试提取文本
    let textContent: string | undefined
    if (isTextFile(fileName) && decrypted.length < 5 * 1024 * 1024) {
      try {
        textContent = decrypted.toString('utf-8')
      } catch {
        // binary → skip
      }
    }

    return { fileName, fileSize, mimeType: getMimeType(fileName), buffer: decrypted, textContent }
  } catch (err: any) {
    console.error(`[WeChat iLink] downloadFile error:`, err.message)
    return null
  }
}

// ============================
// HTTP helper
// ============================

async function ilinkPost<T>(baseUrl: string, path: string, body: Record<string, any>, token?: string, timeoutMs = 30000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // 构建请求体 (含 base_info + bot_agent)
    const requestBody = { base_info: { channel_version: '2.0.0', bot_agent: 'SuperCrzyAgent/1.0' }, ...body }
    const bodyStr = JSON.stringify(requestBody)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
      'X-WECHAT-UIN': randomUin(),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '65536',
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const res = await fetch(`${baseUrl}/ilink/bot/${path}`, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`iLink HTTP ${res.status}`)
    }

    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

async function ilinkGet<T>(path: string): Promise<T> {
  const existingTokens = loadCredentials()?.token ? [loadCredentials()!.token] : []
  const bodyStr = JSON.stringify({
    base_info: { channel_version: '2.0.0', bot_agent: 'SuperCrzyAgent/1.0' },
    local_token_list: existingTokens,
  })

  const res = await fetch(`${ILINK_BASE}/ilink/bot/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
      'X-WECHAT-UIN': randomUin(),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '65536',
    },
    body: bodyStr,
  })
  if (!res.ok) throw new Error(`iLink POST ${path}: ${res.status}`)
  return (await res.json()) as T
}

// ============================
// 获取登录二维码
// ============================

export async function getBotQRCode(): Promise<QRCodeData> {
  const res = await ilinkGet<{ qrcode: string; qrcode_img_content?: string; ret: number }>(`get_bot_qrcode?bot_type=${BOT_TYPE}`)

  if (res.ret !== 0 || !res.qrcode) {
    throw new Error(`Failed to get QR code: ret=${res.ret}`)
  }

  // 关键：使用 qrcode_img_content（微信 liteapp 授权 URL）
  // 而不是原始 token 或手动构造的 polling URL
  const authUrl = res.qrcode_img_content || `https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(res.qrcode)}`

  const qrDataUrl = await QRCode.toDataURL(authUrl, {
    width: 280,
    margin: 2,
    color: { dark: '#18181b', light: '#ffffff' },
  })

  return {
    qrcode: res.qrcode,
    qrDataUrl,
    expiresAt: Date.now() + 180000,
  }
}

// ============================
// 轮询扫码状态
// ============================

export type QRStatus = 'wait' | 'scaned' | 'confirmed' | 'expired'

export interface QRStatusResult {
  status: QRStatus
  token?: string
  baseUrl?: string
  accountId?: string
  userId?: string
}

export async function pollQRCodeStatus(qrcode: string, maxAttempts = 60): Promise<QRStatusResult> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await ilinkGet<{
      ret: number
      status: string
      bot_token?: string
      baseurl?: string
      ilink_bot_id?: string
      ilink_user_id?: string
    }>(`get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`)

    if (res.status === 'confirmed') {
      return {
        status: 'confirmed',
        token: res.bot_token || '',
        baseUrl: res.baseurl || ILINK_BASE,
        accountId: res.ilink_bot_id || '',
        userId: res.ilink_user_id || '',
      }
    }

    if (res.status === 'expired') {
      return { status: 'expired' }
    }

    // wait or scaned — continue polling
    await new Promise(r => setTimeout(r, 2000))
  }

  return { status: 'expired' }
}

// ============================
// 消息轮询 (长轮询)
// ============================

export async function getUpdates(
  baseUrl: string,
  token: string,
  buf: string,
): Promise<GetUpdatesResp> {
  try {
    return await ilinkPost<GetUpdatesResp>(
      baseUrl,
      'getupdates',
      { get_updates_buf: buf },
      token,
      LONG_POLL_TIMEOUT + 5000,
    )
  } catch (err: any) {
    if (err.name === 'AbortError') {
      // Timeout is normal — return empty
      return { ret: 0, msgs: [], get_updates_buf: buf }
    }
    throw err
  }
}

// ============================
// 发送消息
// ============================

export async function sendMessage(
  baseUrl: string,
  token: string,
  toUserId: string,
  text: string,
  contextToken: string,
  clientId?: string,
): Promise<void> {
  await ilinkPost(baseUrl, 'sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId || randomUUID().slice(0, 16),
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: [{ type: 1, text_item: { text } }],
      context_token: contextToken,
    },
  }, token)
}

// ============================
// Bot 激活/停用
// ============================

export async function notifyStart(baseUrl: string, token: string): Promise<{ ret: number }> {
  return ilinkPost(baseUrl, 'msg/notifystart', {}, token)
}

export async function notifyStop(baseUrl: string, token: string): Promise<{ ret: number }> {
  return ilinkPost(baseUrl, 'msg/notifystop', {}, token)
}

// ============================
// 凭据持久化
// ============================

const CREDENTIALS_FILE = 'data/ilink-credentials.json'

export function saveCredentials(creds: LoginCredentials): void {
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 })
}

export function loadCredentials(): LoginCredentials | null {
  try {
    if (!existsSync(CREDENTIALS_FILE)) return null
    const data = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8'))
    if (!data.token || !data.accountId) return null
    return data as LoginCredentials
  } catch {
    return null
  }
}

export function clearCredentials(): void {
  try {
    writeFileSync(CREDENTIALS_FILE, '{}', { mode: 0o600 })
  } catch {}
}

// ============================
// 发送"正在输入"状态
// ============================

/** 发送 typing 状态：1=正在输入，2=取消 */
export async function sendTyping(
  baseUrl: string,
  token: string,
  typingTicket: string,
  status: 1 | 2 = 1
): Promise<void> {
  await ilinkPost(baseUrl, 'sendtyping', {
    typing_ticket: typingTicket,
    status, // 1=typing, 2=cancel
  }, token, 10000)
}

// ============================
// 媒体上传 API
// ============================

/** 从 iLink API 获取上传 URL */
async function getUploadUrl(
  baseUrl: string,
  token: string,
  params: {
    filekey: string
    media_type: number
    to_user_id: string
    rawsize: number
    rawfilemd5: string
    filesize: number
    aeskey: string
  }
): Promise<{ upload_full_url?: string; upload_param?: string }> {
  return ilinkPost(baseUrl, 'getuploadurl', {
    filekey: params.filekey,
    media_type: params.media_type,
    to_user_id: params.to_user_id,
    rawsize: params.rawsize,
    rawfilemd5: params.rawfilemd5,
    filesize: params.filesize,
    aeskey: params.aeskey,
    no_need_thumb: true,
  }, token)
}

// AES-128-ECB + PKCS7 加密
function encryptAesEcb(data: Buffer, key: Buffer): Buffer {
  const BLOCK = 16
  const pad = BLOCK - (data.length % BLOCK)
  const padded = Buffer.alloc(data.length + pad, pad)
  data.copy(padded)
  const cipher = require('crypto').createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()])
}

// 上传文件到 CDN
async function uploadToCdn(
  cdnBaseUrl: string,
  buf: Buffer,
  uploadUrl: string,
  filekey: string,
  aesKey: Buffer
): Promise<string> {
  const ciphertext = encryptAesEcb(buf, aesKey)
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext),
  })
  if (!res.ok) {
    const err = res.headers.get('x-error-message') || `status ${res.status}`
    throw new Error(`CDN upload failed: ${err}`)
  }
  const downloadParam = res.headers.get('x-encrypted-param')
  if (!downloadParam) throw new Error('CDN response missing x-encrypted-param')
  return downloadParam
}

// AES Key 编码（支持 base64 和 hex）
function encodeAesKey(key: Buffer): string {
  return key.toString('base64')
}

export interface UploadedMedia {
  filekey: string
  downloadEncryptedQueryParam: string
  aeskey: string
  fileSize: number
}

/** 上传本地文件到微信 CDN（图片/视频/附件） */
export async function uploadMediaFile(
  baseUrl: string,
  token: string,
  filePath: string,
  toUserId: string,
  mediaType: 'image' | 'video' | 'file'
): Promise<UploadedMedia> {
  const fs = await import('fs/promises')
  const crypto = await import('crypto')
  
  const buf = await fs.readFile(filePath)
  const rawsize = buf.length
  const rawfilemd5 = crypto.createHash('md5').update(buf).digest('hex')
  const filekey = crypto.randomBytes(16).toString('hex')
  const aeskey = crypto.randomBytes(16)
  
  // 计算 PKCS7 填充后的长度
  const pad = 16 - (rawsize % 16)
  const filesize = rawsize + pad
  
  // 获取上传 URL
  const typeMap = { image: 1, video: 2, file: 3 }
  const resp = await getUploadUrl(baseUrl, token, {
    filekey,
    media_type: typeMap[mediaType],
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString('hex'),
  })
  
  // 上传到 CDN
  let cdnUrl = resp.upload_full_url?.trim()
  if (!cdnUrl && resp.upload_param) {
    cdnUrl = `${CDN_BASE}/c2c/upload?ukey=${encodeURIComponent(resp.upload_param)}&filekey=${filekey}`
  }
  if (!cdnUrl) throw new Error('No upload URL from getuploadurl')
  
  const downloadParam = await uploadToCdn(CDN_BASE, buf, cdnUrl, filekey, aeskey)
  
  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: encodeAesKey(aeskey),
    fileSize: rawsize,
  }
}

// ============================
// 发送媒体消息
// ============================

/** 发送图片消息 */
export async function sendImageMessage(
  baseUrl: string,
  token: string,
  toUserId: string,
  contextToken: string,
  uploaded: UploadedMedia,
  caption?: string
): Promise<void> {
  const items: any[] = []
  if (caption) {
    items.push({ type: 1, text_item: { text: caption } })
  }
  items.push({
    type: 2, // IMAGE
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: uploaded.aeskey,
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSize,
    },
  })
  
  await ilinkPost(baseUrl, 'sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: randomUUID().slice(0, 16),
      message_type: 2,
      message_state: 2,
      item_list: items,
      context_token: contextToken,
    },
  }, token)
}

/** 发送文件消息 */
export async function sendFileMessage(
  baseUrl: string,
  token: string,
  toUserId: string,
  contextToken: string,
  fileName: string,
  uploaded: UploadedMedia,
  caption?: string
): Promise<void> {
  const items: any[] = []
  if (caption) {
    items.push({ type: 1, text_item: { text: caption } })
  }
  items.push({
    type: 4, // FILE
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: uploaded.aeskey,
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  })
  
  await ilinkPost(baseUrl, 'sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: randomUUID().slice(0, 16),
      message_type: 2,
      message_state: 2,
      item_list: items,
      context_token: contextToken,
    },
  }, token)
}

/** 发送视频消息 */
export async function sendVideoMessage(
  baseUrl: string,
  token: string,
  toUserId: string,
  contextToken: string,
  uploaded: UploadedMedia,
  caption?: string
): Promise<void> {
  const items: any[] = []
  if (caption) {
    items.push({ type: 1, text_item: { text: caption } })
  }
  items.push({
    type: 5, // VIDEO
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: uploaded.aeskey,
        encrypt_type: 1,
      },
      video_size: uploaded.fileSize,
    },
  })
  
  await ilinkPost(baseUrl, 'sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: randomUUID().slice(0, 16),
      message_type: 2,
      message_state: 2,
      item_list: items,
      context_token: contextToken,
    },
  }, token)
}

/** 自动识别文件类型并发送（支持本地路径和 HTTP URL） */
export async function sendMediaFileToWeChat(
  creds: LoginCredentials,
  toUserId: string,
  contextToken: string,
  mediaPath: string,
  caption?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const fs = await import('fs/promises')
    const path = await import('path')
    
    let filePath = mediaPath
    let isRemote = false
    
    // 如果是远程 URL，先下载
    if (mediaPath.startsWith('http://') || mediaPath.startsWith('https://')) {
      isRemote = true
      console.log(`[WeChat] Downloading remote media: ${mediaPath.slice(0, 80)}`)
      const res = await fetch(mediaPath)
      if (!res.ok) throw new Error(`Download failed: ${res.status}`)
      
      // 写入临时文件
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = mediaPath.split('.').pop() || 'tmp'
      filePath = `/tmp/wechat-outbound-${Date.now()}.${ext}`
      await fs.writeFile(filePath, buf)
      console.log(`[WeChat] Remote media saved to: ${filePath}`)
    }
    
    // 检查文件是否存在
    const stats = await fs.stat(filePath)
    if (!stats.isFile()) {
      if (isRemote) await fs.unlink(filePath).catch(() => {})
      throw new Error('Not a file')
    }
    
    const ext = path.extname(filePath).toLowerCase()
    const mime = getMimeType(filePath)
    
    // 根据 MIME 类型选择发送方式
    if (mime.startsWith('image/')) {
      const uploaded = await uploadMediaFile(creds.baseUrl, creds.token, filePath, toUserId, 'image')
      await sendImageMessage(creds.baseUrl, creds.token, toUserId, contextToken, uploaded, caption)
      console.log(`[WeChat] Image sent: ${filePath}`)
    } else if (mime.startsWith('video/')) {
      const uploaded = await uploadMediaFile(creds.baseUrl, creds.token, filePath, toUserId, 'video')
      await sendVideoMessage(creds.baseUrl, creds.token, toUserId, contextToken, uploaded, caption)
      console.log(`[WeChat] Video sent: ${filePath}`)
    } else {
      const fileName = path.basename(filePath)
      const uploaded = await uploadMediaFile(creds.baseUrl, creds.token, filePath, toUserId, 'file')
      await sendFileMessage(creds.baseUrl, creds.token, toUserId, contextToken, fileName, uploaded, caption)
      console.log(`[WeChat] File sent: ${filePath}`)
    }
    
    // 清理临时文件
    if (isRemote) {
      await fs.unlink(filePath).catch(() => {})
    }
    
    return { success: true }
  } catch (err: any) {
    console.error(`[WeChat] sendMediaFile failed:`, err.message)
    return { success: false, error: err.message }
  }
}
