/**
 * 文件上传处理（选文件 → 上传 → 自动 OCR）。
 *
 * 抽自 `ChatView.vue`（I10 低风险批）。`uploadedFiles` 本体仍留在组件里 —— 发送管线要读它，
 * 这里只负责"往里面加"和"从里面删"。
 *
 * 两个刻意的行为：
 *   · OCR 是**旁路**的：上传成功即返回，OCR 结果晚到就补写到对应附件上，失败静默 ——
 *     不能让 OCR 拖慢或阻断发送（图片文字只是增强，不是必需品）
 *   · 无论成败都要清空 `<input type=file>` 的 value —— 否则同一个文件第二次选不上（change 不触发）
 */
import { ref, type Ref } from 'vue'
import type { Attachment } from '@/types'
import { errMsg } from '@/utils/i18n-error'

export interface UseAttachmentsOptions {
  /** 已选附件列表（组件持有，本组合式只读写内容） */
  uploadedFiles: Ref<Attachment[]>
  /** 当前会话 id（作为上传归属，后端按会话关联文件） */
  sessionId: () => string | undefined
  /** 隐藏的 file input（用于上传结束后重置 value） */
  fileInputRef: Ref<HTMLInputElement | undefined | null>
  t: (key: string, params?: Record<string, unknown>) => string
  /** 错误出口（组件传 naive-ui 的 message.error 之类） */
  onError: (msg: string) => void
  /** 上传接口，默认 /api/upload（测试可替换） */
  uploadUrl?: string
  /** OCR 接口，默认 /api/ocr（测试可替换） */
  ocrUrl?: string
}

export function useAttachments(opts: UseAttachmentsOptions) {
  const uploading = ref(false)
  const uploadUrl = opts.uploadUrl ?? '/api/upload'
  const ocrUrl = opts.ocrUrl ?? '/api/ocr'

  /** 上传成功后旁路跑 OCR，结果回填到附件上（失败静默，不影响发送） */
  function runOcr(file: Attachment) {
    fetch(ocrUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file.url }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (res && Array.isArray(res.texts) && res.texts.length > 0) {
          const att = opts.uploadedFiles.value.find((a) => a.id === file.id)
          if (att) att.ocrTexts = res.texts
        }
      })
      .catch(() => { /* OCR 失败不影响发送 */ })
  }

  async function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement
    const rawFiles = input.files
    if (!rawFiles || rawFiles.length === 0) return

    uploading.value = true
    const formData = new FormData()

    // 上传归属：后端按 session_id 归档，缺了会导致文件散落在会话之外
    const sid = opts.sessionId()
    if (sid) formData.append('session_id', sid)

    for (let i = 0; i < rawFiles.length; i++) {
      formData.append('files', rawFiles[i])
    }

    try {
      const res = await fetch(uploadUrl, { method: 'POST', body: formData })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(errMsg(err.code, err.error || opts.t('chat.uploadFailed')))
      }

      const data = await res.json()
      opts.uploadedFiles.value.push(...data.files)
      // 自动 OCR：图片上传后本地识别文字（RapidOCR，免费开源）→ 发消息时注入对话
      for (const f of data.files as Attachment[]) {
        if (f.type?.startsWith('image/') && f.url) runOcr(f)
      }
    } catch (err: any) {
      opts.onError(opts.t('chat.uploadFailMsg', { msg: err.message }))
    } finally {
      uploading.value = false
      // Reset input so same file can be re-selected
      if (opts.fileInputRef.value) opts.fileInputRef.value.value = ''
    }
  }

  function removeFile(index: number) {
    opts.uploadedFiles.value.splice(index, 1)
  }

  function openAttachment(att: Attachment) {
    window.open(att.url, '_blank')
  }

  return { uploading, handleFileSelect, removeFile, openAttachment }
}
