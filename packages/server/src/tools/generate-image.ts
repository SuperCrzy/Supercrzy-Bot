/**
 * generate_image — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import { WORKSPACE_ROOT, assertSafeFilePath } from '../services/sandbox'
import { readSetting } from './shared'

const tool: ToolDef = {
  name: 'generate_image',
  description: '用 AI 生成图片（文生图）。支持 op 为：generate(文生图)。通过 provider 选择生图通道：pollinations(免key默认) / doubao(火山方舟Seedream,需Doubao key) / gemini(谷歌Nano Banana,需Gemini key)。用户可在设置里配置 provider 和对应 API key。输入 prompt(画面描述，越具体越好)，可选 width/height。生成的图为交付产物，对话内显示+右侧预览tab展示。',
  category: 'system',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '本次生图目的的一句话说明（人读标题）' },
      prompt: { type: 'string', description: '画面描述文字（描述主体/场景/风格/光线，尽量具体），如"一只在雪地里奔跑的红狐狸，电影感光影，高清"' },
      width: { type: 'number', description: '宽度(可选，pollinations 用)，默认1024' },
      height: { type: 'number', description: '高度(可选，pollinations 用)，默认1024' },
      provider: { type: 'string', enum: ['pollinations', 'doubao', 'gemini', 'stability', 'replicate', 'openai'], description: '生图通道：pollinations免key / doubao(火山方舟) / gemini(谷歌) / stability(Stability AI) / replicate(Replicate FLUX) / openai(gpt-image)；默认按设置' },
    },
    required: ['description', 'prompt'],
  },
  async execute(args, ctx) {
    const prompt = String(args.prompt || '').trim()
    if (!prompt) return '❌ generate_image 需要 prompt 参数（画面描述）'
    const width = Number(args.width) || 1024
    const height = Number(args.height) || 1024
    // provider 选择：显式传 provider > 设置 imageProvider > 默认 pollinations(免key)
    const configured = readSetting('imageProvider') || 'pollinations'
    const provider = (args.provider || configured || 'pollinations').toLowerCase()
    const apiKey = readSetting('imageApiKey') || ''
    const doubaoModel = readSetting('doubaoModel') || 'doubao-seedream-5-0-260128'
    const geminiModel = readSetting('geminiImageModel') || 'gemini-2.5-flash-image'
    const title = String(args.description || prompt).slice(0, 40)
    // 产物落盘目录（工作区内）
    const cwd = ctx?.cwd || WORKSPACE_ROOT
    const fileName = `generated_${Date.now()}.png`
    const outPath = join(cwd, fileName)
    // 必须带上 permissionLevel：不传时沙箱按 'sandbox' 兜底，full 授权对产物目录不生效
    // （2026-10-26 自检发现：此处与 video-edit 是仅有的两处漏传）。
    try {
      assertSafeFilePath(outPath, { level: ctx?.permissionLevel, workspaceDir: cwd, extraAllowed: [cwd] })
    } catch (e: any) { return `❌ 输出路径不允许: ${fileName}` }
    const stream = (c: string) => { if (ctx?.onOutput) ctx.onOutput('', c) }
    const pushImage = (data: string, isUrl: boolean) => { stream(isUrl ? `已生成图: ${data.slice(0, 120)}` : '图片已生成'); try { if (ctx?.onImage) ctx.onImage(data, isUrl, title) } catch {} }

    try {
      let imageData = ''  // dataURL 或 URL
      let isUrl = false
      if (provider === 'doubao') {
        // 火山方舟 Seedream：OpenAI 兼容 images/generations
        if (!apiKey) return '❌ doubao provider 需要先在设置里填 API key（火山方舟 ARK API Key）'
        const resp = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: doubaoModel, prompt, size: '1K', response_format: 'url', watermark: false }),
        })
        if (!resp.ok) return `❌ 豆包生图失败: ${resp.status} ${(await resp.text()).slice(0, 200)}`
        const data = await resp.json() as any
        const url = data?.data?.[0]?.url
        if (!url) return '❌ 豆包生图未返回图片 URL'
        imageData = url; isUrl = true
      } else if (provider === 'gemini') {
        // 谷歌 Gemini Nano Banana：generateContent，返回 base64 PNG
        if (!apiKey) return '❌ gemini provider 需要先在设置里填 API key（Google AI Studio）'
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
        })
        if (!resp.ok) return `❌ Gemini 生图失败: ${resp.status} ${(await resp.text()).slice(0, 200)}`
        const data = await resp.json() as any
        const part = data?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inline_data?.data)
        if (!part?.inline_data?.data) return '❌ Gemini 未返回图片'
        imageData = `data:image/${(part.inline_data.mimeType || 'png').replace('image/', '')};base64,${part.inline_data.data}`; isUrl = false
      } else if (provider === 'stability') {
        // Stability AI：multipart/form-data，返回图片二进制
        if (!apiKey) return '❌ stability provider 需要填 Stability API key'
        const form = new FormData()
        form.append('prompt', prompt)
        form.append('aspect_ratio', '1:1')
        form.append('output_format', 'png')
        const resp = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'image/*' },
          body: form,
        })
        if (!resp.ok) return `❌ Stability 生图失败: ${resp.status} ${(await resp.text()).slice(0, 200)}`
        const buf = Buffer.from(await resp.arrayBuffer())
        imageData = `data:image/png;base64,${buf.toString('base64')}`; isUrl = false
      } else if (provider === 'openai' || provider === 'dalle' || provider === 'gpt-image') {
        // OpenAI gpt-image-1（DALL-E API 已下线，用 gpt-image-1 替代）：返回 base64 或 URL
        if (!apiKey) return '❌ openai provider 需要填 OpenAI API key'
        const model = readSetting('openaiImageModel') || 'gpt-image-1'
        const resp = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, prompt, size: '1024x1024', response_format: 'b64_json' }),
        })
        if (!resp.ok) return `❌ OpenAI 生图失败: ${resp.status} ${(await resp.text()).slice(0, 200)}`
        const data = await resp.json() as any
        const b64 = data?.data?.[0]?.b64_json || data?.data?.[0]?.url
        if (!b64) return '❌ OpenAI 未返回图片'
        if (data.data[0].b64_json) { imageData = `data:image/png;base64,${b64}`; isUrl = false }
        else { imageData = b64; isUrl = true }
      } else if (provider === 'replicate') {
        // Replicate FLUX：异步创建 prediction + 轮询
        if (!apiKey) return '❌ replicate provider 需要填 Replicate API token'
        const version = readSetting('replicateModel') || 'black-forest-labs/flux-schnell'
        const pred = await fetch('https://api.replicate.com/v1/predictions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'Prefer': 'wait' },
          body: JSON.stringify({ version, input: { prompt, width, height } }),
        })
        if (!pred.ok) return `❌ Replicate 创建失败: ${pred.status} ${(await pred.text()).slice(0, 200)}`
        const p = await pred.json() as any
        const out = p?.output?.[0] || (Array.isArray(p?.output) ? p.output[0] : null)
        if (out) { imageData = String(out); isUrl = true }
        else if (p?.outputs && Array.isArray(p.outputs)) { imageData = String(p.outputs[0]); isUrl = true }
        else return '❌ Replicate 未返回图片'
      } else {
        // Pollinations 免 key（也作兜底）：纯 URL 拉图
        imageData = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true`; isUrl = true
      }
      // 落盘 & 上报（pollinations 下载 / doubao下载 / gemini已有dataURL）
      // 用 fs/promises 写：图片动辄几 MB，writeFileSync 会按大小同步占住事件循环，
      // 而生图过程本身一直在等网络，没有任何理由在最后一步同步写（2026-09-18）。
      let writtenSize = 0
      try {
        if (isUrl) {
          const resp = await fetch(imageData)
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer())
            await writeFile(outPath, buf)
            writtenSize = buf.length
          }
        } else {
          const base64 = imageData.slice(imageData.indexOf(',') + 1)
          const buf = Buffer.from(base64, 'base64')
          await writeFile(outPath, buf)
          writtenSize = buf.length
        }
      } catch {}
      if (ctx?.onArtifacts) { try { ctx.onArtifacts([{ name: fileName, path: outPath, action: 'created', size: writtenSize }]) } catch {} }
      pushImage(imageData, isUrl)
      return `✅ 图片已生成（${provider}）: ${fileName}${isUrl ? `\nURL: ${imageData.slice(0,150)}` : ''}`
    } catch (e: any) {
      return `❌ 生图失败: ${e.message}`
    }
  },
}

export default tool
