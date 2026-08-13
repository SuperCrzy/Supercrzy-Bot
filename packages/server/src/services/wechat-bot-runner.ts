/**
 * WeChat iLink Bot Runner
 * 启动后持续长轮询微信消息，转发给 Agent 处理
 */
import { getUpdates, sendMessage, loadCredentials, clearCredentials, notifyStart, notifyStop, downloadFile, sendTyping, sendMediaFileToWeChat, type LoginCredentials, type DownloadedFile } from './wechat-ilink'
// @ts-ignore - StreamingMarkdownFilter 无类型声明，但运行时有效
import { StreamingMarkdownFilter } from '@tencent-weixin/openclaw-weixin/dist/src/messaging/markdown-filter.js'
import { randomBytes } from 'crypto'

// ---- 延迟导入文件解析库（避免服务器启动时报错） ----
async function tryParsePdf(buffer: Buffer): Promise<string | null> {
  try {
    const { PDFParse } = await import('pdf-parse')
    // PDFParse 是类，需要 new 实例
    const parser = new PDFParse({ data: buffer })
    const result = await parser.getText()
    return (result as any).text?.trim() || (result as any).toString().trim() || null
  } catch { return null }
}

async function tryParseDocx(buffer: Buffer): Promise<string | null> {
  try {
    const { default: mammoth } = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer })
    return result.value.trim() || null
  } catch { return null }
}

async function tryParseXlsx(buffer: Buffer): Promise<string | null> {
  try {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as any)
    const lines: string[] = []
    for (const ws of wb.worksheets) {
      const rows: string[] = []
      ws.eachRow((row: any) => {
        const vals = (row.values as any[]).slice(1).map((v: any) => (v == null ? '' : String(v)))
        rows.push(vals.join(','))
      })
      if (rows.length > 0) {
        lines.push(`=== Sheet: ${ws.name} ===`)
        lines.push(rows.join('\n'))
      }
    }
    return lines.length > 0 ? lines.join('\n') : null
  } catch { return null }
}

// ---- 语音识别 (ASR) ----
// 微信语音格式为 silk/silkv3，需要转换为 mp3/wav 才能被大多数 ASR 服务识别
async function tryTranscribeAudio(
  creds: LoginCredentials,
  item: any
): Promise<string | null> {
  try {
    // 1. 下载语音文件
    const df = await downloadFile(creds.token, item)
    if (!df) return null
    console.log(`[WeChat ASR] Downloaded audio: ${df.fileName}, ${df.fileSize} bytes`)
    
    // 2. 保存为临时文件
    const fs = await import('fs/promises')
    const tmpPath = `/tmp/wechat-voice-${Date.now()}.slk`
    await fs.writeFile(tmpPath, df.buffer)
    
    // 3. 转换为 mp3 (使用 ffmpeg)
    const mp3Path = `/tmp/wechat-voice-${Date.now()}.mp3`
    try {
      const { execSync } = await import('child_process')
      execSync(`ffmpeg -y -i "${tmpPath}" -acodec libmp3lame "${mp3Path}" 2>/dev/null`, { timeout: 30000 })
      console.log(`[WeChat ASR] Converted to MP3: ${mp3Path}`)
    } catch {
      // ffmpeg 不可用，尝试直接使用原始文件
      console.log(`[WeChat ASR] ffmpeg not available, trying direct transcription`)
      await fs.unlink(tmpPath).catch(() => {})
      return null
    }
    
    // 4. 调用 ASR API（支持 OpenAI Whisper / 阿里云 / 腾讯云）
    const deepseekApiKey = process.env.OPENAI_KEY || ''
    const whisperEndpoint = process.env.WHISPER_ENDPOINT || 'https://api.deepseek.com/v1/audio/transcriptions'
    
    // 检查配置
    if (!deepseekApiKey && !process.env.ASR_API_KEY) {
      console.log(`[WeChat ASR] No ASR API configured`)
      await fs.unlink(tmpPath).catch(() => {})
      await fs.unlink(mp3Path).catch(() => {})
      return null
    }
    
    // 使用 Whisper API
    const formData = new FormData()
    const audioBuffer = await fs.readFile(mp3Path)
    const blob = new Blob([audioBuffer], { type: 'audio/mpeg' })
    formData.append('file', blob, 'audio.mp3')
    formData.append('model', 'whisper-1')
    formData.append('language', 'zh') // 优先中文
    
    const apiKey = process.env.ASR_API_KEY || deepseekApiKey
    const endpoint = process.env.ASR_ENDPOINT || whisperEndpoint
    
    console.log(`[WeChat ASR] Calling ASR: ${endpoint}`)
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
    })
    
    if (!resp.ok) {
      const errText = await resp.text()
      console.error(`[WeChat ASR] API error: ${resp.status} ${errText}`)
      await fs.unlink(tmpPath).catch(() => {})
      await fs.unlink(mp3Path).catch(() => {})
      return null
    }
    
    const result = await resp.json() as { text?: string }
    const transcript = result.text?.trim()
    
    // 清理临时文件
    await fs.unlink(tmpPath).catch(() => {})
    await fs.unlink(mp3Path).catch(() => {})
    
    if (transcript) {
      console.log(`[WeChat ASR] Transcribed: ${transcript.slice(0, 50)}`)
      return transcript
    }
    return null
  } catch (err: any) {
    console.error(`[WeChat ASR] Error:`, err.message)
    return null
  }
}

/** 尝试解析二进制文件内容，返回文本或 null */
async function extractBinaryContent(name: string, buffer: Buffer, mimeType: string): Promise<string | null> {
  const ext = name.toLowerCase().split('.').pop() || ''
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    return await tryParsePdf(buffer)
  }
  if (ext === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return await tryParseDocx(buffer)
  }
  if (ext === 'xlsx' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return await tryParseXlsx(buffer)
  }
  return null
}

/** 移除 emoji */
function stripEmoji(text: string): string {
  return text.replace(
    /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E0}-\u{1F1FF}\u{1FA00}-\u{1FAFF}]/gu,
    ''
  )
}

const RETRY_LIMIT = 5

let running = false
let getUpdatesBuf = ''

export interface MessageHandler {
  (userId: string, text: string): Promise<string>
}

export interface MessageHandlerFull {
  (userId: string, text: string, sessionId: string, contextToken: string): Promise<string>
}

let messageHandler: MessageHandler | null = null
let messageHandlerFull: MessageHandlerFull | null = null

export function setMessageHandler(handler: MessageHandler): void {
  messageHandler = handler
}

export function setMessageHandlerFull(handler: MessageHandlerFull): void {
  messageHandlerFull = handler
}

/**
 * 从微信消息的 item_list 中提取文本 + 文件内容 + 语音
 * 返回: { text: 合并后的完整文本, files: 微信文件项列表, voiceItems: 语音项列表 }
 */
interface WechatFileItem { type: number; item: any }
interface WechatVoiceItem { item: any }
async function extractMessageContent(
  _creds: LoginCredentials,
  msg: any,
): Promise<{ text: string; files: WechatFileItem[]; voiceItems: WechatVoiceItem[] }> {
  let text = ''
  const files: WechatFileItem[] = []
  const voiceItems: WechatVoiceItem[] = []

  if (!msg.item_list) {
    if (msg.content) text = msg.content
    return { text, files, voiceItems }
  }

  for (const item of msg.item_list) {
    switch (item.type) {
      case 1: {
        // 文本
        const t = item.text_item?.text || item.text || ''
        if (t) text += (text ? '\n' : '') + t
        break
      }
      case 3: {
        // 语音：加入语音处理队列
        console.log(`[WeChat] Voice detected (type=3), queuing for ASR`)
        voiceItems.push({ item })
        break
      }
      case 4: {
        // 文件：加入下载队列
        console.log(`[WeChat] File detected: type=4, name=${item.file_item?.file_name || 'unknown'}`)
        files.push({ type: item.type, item })
        break
      }
    }
  }

  return { text, files, voiceItems }
}

async function processMessage(
  creds: LoginCredentials,
  msg: any,
): Promise<void> {
  const contextToken = msg.context_token || ''
  const toUserId = msg.from_user_id || ''
  // 记录最后用户 ID，供 notifier 主动推送使用
  if (toUserId) lastToUserId = toUserId
  if (contextToken) lastContextToken = contextToken
  if (!contextToken || !toUserId) return

  // 提取文本 + 文件 + 语音
  const { text: rawText, files: rawFiles, voiceItems } = await extractMessageContent(creds, msg)

  // 处理语音识别（ASR）
  let voiceText = ''
  for (const vi of voiceItems) {
    const transcribed = await tryTranscribeAudio(creds, vi.item)
    if (transcribed) {
      voiceText += (voiceText ? '\n' : '') + `[语音]: ${transcribed}`
    } else {
      voiceText += (voiceText ? '\n' : '') + '[语音消息，识别失败]'
    }
  }

  // 如果既没有文字也没有文件也没有语音，跳过
  if (!rawText && rawFiles.length === 0 && !voiceText) return

  console.log(`[WeChat] Message from ${toUserId}: text=${rawText.slice(0, 80) || '(none)'}, files=${rawFiles.length}, voice=${voiceItems.length}`)

  // 发送"正在输入"状态
  const typingTicket = msg.typing_ticket || ''
  if (typingTicket) {
    sendTyping(creds.baseUrl, creds.token, typingTicket, 1).catch(() => {})
  }

  // 下载并处理文件
  let fileContentText = ''
  const downloadedFiles: DownloadedFile[] = []

  for (const rf of rawFiles) {
    try {
      const df = await downloadFile(creds.token, rf.item)
      if (df) {
        downloadedFiles.push(df)
        console.log(`[WeChat] File downloaded: ${df.fileName} (${df.fileSize} bytes, hasText=${!!df.textContent})`)

        if (df.textContent) {
          // 文本文件：直接内联
          const snippet = df.textContent.length > 8000 ? df.textContent.slice(0, 8000) + '\n... (内容过长已截断)' : df.textContent
          fileContentText += `\n\n--- [${df.fileName}] ---\n${snippet}\n--- EOF ---`
        } else {
          // 二进制文件：尝试 PDF / DOCX / XLSX 解析
          const extracted = await extractBinaryContent(df.fileName, df.buffer, df.mimeType)
          if (extracted) {
            const snippet = extracted.length > 8000 ? extracted.slice(0, 8000) + '\n... (内容过长已截断)' : extracted
            fileContentText += `\n\n--- [${df.fileName}] ---\n${snippet}\n--- EOF ---`
            console.log(`[WeChat] Binary file parsed: ${df.fileName}, extracted ${extracted.length} chars`)
          } else {
            fileContentText += `\n\n[文件: ${df.fileName} (${(df.fileSize / 1024).toFixed(1)}KB, ${df.mimeType})]`
          }
        }
      }
    } catch (err: any) {
      console.error(`[WeChat] File download failed:`, err.message)
      fileContentText += `\n\n[文件下载失败: ${rf.item?.file_item?.file_name || 'unknown'}]`
    }
  }

  // 合并文本（文字 + 语音 + 文件内容）
  const fullText = rawText + voiceText + fileContentText

  // Generate session ID from WeChat user ID (stable per user)
  const sessionId = toUserId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)

  try {
    let reply = ''
    console.log(`[WeChat] Processing message, hasHandlerFull=${!!messageHandlerFull}, hasHandler=${!!messageHandler}`)
    if (messageHandlerFull) {
      reply = await messageHandlerFull(toUserId, fullText, sessionId, contextToken)
    } else if (messageHandler) {
      reply = await messageHandler(toUserId, fullText)
    }
    console.log(`[WeChat] Handler returned: "${reply?.slice(0, 50)}..."`)

    if (!reply) {
      console.log(`[WeChat] No reply from handler, skipping`)
      // 取消 typing 状态
      if (typingTicket) sendTyping(creds.baseUrl, creds.token, typingTicket, 2).catch(() => {})
      return
    }
    console.log(`[WeChat] Agent reply: ${reply.slice(0, 80)}`)

    // 流式 Markdown 过滤：去掉微信不支持的语法，保留代码/表格/加粗等
    const mdFilter = new StreamingMarkdownFilter()
    // 过滤 emoji（用户要求不用 emoji）：移除所有非 ASCII、非 CJK、非基本拉丁的字符
    const noEmoji = reply.replace(
      /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E0}-\u{1F1FF}\u{1FA00}-\u{1FAFF}]/gu,
      ''
    )
    const filtered = mdFilter.feed(noEmoji) + mdFilter.flush()

    // ---- 处理 Agent 产物（MEDIA: 指令） ----
    // 匹配 MEDIA:/path/to/file 或 MEDIA: /path/to/file
    const mediaRegex = /^MEDIA:\s*(\S+)/gm
    const mediaMatches: { path: string; index: number; length: number }[] = []
    let match
    while ((match = mediaRegex.exec(filtered)) !== null) {
      mediaMatches.push({ path: match[1], index: match.index, length: match[0].length })
    }
    
    // 发送所有媒体文件
    for (const m of mediaMatches) {
      const caption = filtered.slice(0, m.index).trim()
      await sendMediaFileToWeChat(creds, toUserId, contextToken, m.path, caption)
      console.log(`[WeChat] Media sent: ${m.path}`)
    }

    // 提取纯文本（移除 MEDIA: 指令）
    const pureText = filtered.replace(/^MEDIA:\s*\S+/gm, '').trim()

    // 分段发送（微信建议单条 ≤ 2000 字符）
    const CHUNK = 1800
    if (pureText.length <= CHUNK) {
      await sendMessage(creds.baseUrl, creds.token, toUserId, pureText, contextToken)
    } else {
      const chunks: string[] = []
      for (let i = 0; i < pureText.length; i += CHUNK) {
        chunks.push(pureText.slice(i, i + CHUNK))
      }
      for (let i = 0; i < chunks.length; i++) {
        const prefix = i === 0 ? '' : `\n(${i + 1}/${chunks.length})\n`
        await sendMessage(creds.baseUrl, creds.token, toUserId, prefix + chunks[i], contextToken)
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400))
      }
    }
    
    // 取消 typing 状态
    if (typingTicket) sendTyping(creds.baseUrl, creds.token, typingTicket, 2).catch(() => {})
    
    console.log('[WeChat] Reply sent successfully')
  } catch (err: any) {
    console.error(`[WeChat] Reply failed:`, err.message)
    // 取消 typing 状态
    if (typingTicket) sendTyping(creds.baseUrl, creds.token, typingTicket, 2).catch(() => {})
  }
}

export async function startBot(handler: MessageHandler): Promise<{ success: boolean; error?: string }> {
  const creds = loadCredentials()
  if (!creds) {
    return { success: false, error: 'No credentials' }
  }

  if (running) {
    console.log('[WeChat] Bot already running, updating handler')
    messageHandler = handler
    return { success: true }
  }

  setMessageHandler(handler)
  running = true
  getUpdatesBuf = ''
  let failCount = 0

  console.log(`[WeChat] Bot starting (account: ${creds.accountId})`)

  // 关键步骤：通知 iLink 服务器 bot 已上线
  try {
    const startResp = await notifyStart(creds.baseUrl, creds.token)
    console.log(`[WeChat] notifyStart: ret=${startResp.ret}`)
  } catch (err: any) {
    console.error(`[WeChat] notifyStart failed:`, err.message)
  }

  // Run in background
  ;(async () => {
    while (running) {
      try {
        const resp = await getUpdates(creds.baseUrl, creds.token, getUpdatesBuf)
        console.log(`[WeChat] Poll resp: ret=${resp.ret}, msgs=${resp.msgs?.length || 0}, buf=${resp.get_updates_buf?.slice(0, 20)}...`)

        if (resp.errcode === -14 || resp.ret === -14) {
          console.log('[WeChat] Session expired, clearing credentials')
          clearCredentials()
          running = false
          return
        }

        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf
        }

        if (resp.msgs && resp.msgs.length > 0) {
          // 并发处理消息，最多同时 2 条（避免资源争抢）
          const CONCURRENCY = 2
          for (let i = 0; i < resp.msgs.length; i += CONCURRENCY) {
            const batch = resp.msgs.slice(i, i + CONCURRENCY)
            await Promise.allSettled(batch.map((msg: any) => processMessage(creds, msg)))
          }
        }

        failCount = 0
      } catch (err: any) {
        failCount++
        console.error(`[WeChat] Poll error (${failCount}/${RETRY_LIMIT}):`, err.message)
        const delay = failCount > RETRY_LIMIT ? 30000 : 2000
        await new Promise(r => setTimeout(r, delay))
      }
    }
  })()

  return { success: true }
}

export function stopBot(): void {
  running = false
  const creds = loadCredentials()
  if (creds) {
    notifyStop(creds.baseUrl, creds.token).catch(() => {})
  }
  console.log('[WeChat] Bot stopped')
}

export function isBotRunning(): boolean {
  return running
}

// ── Notifier 导出: 记录最后处理的用户 ID，供 scheduler 主动推送 ──
let lastToUserId = ''
let lastContextToken = ''

export function getLastWeChatUserId(): string {
  return lastToUserId
}

export function getLastContextToken(): string {
  return lastContextToken
}
