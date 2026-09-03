/**
 * 视频字幕抓取 · video-transcript（2026-09-03）
 * 免第三方 key：对 YouTube 链接，用服务端 fetch 解析字幕轨(xml timedtext)。
 * 后续可按同样思路扩 Bilibili(有开放接口)。
 * 若拿不到字幕轨则回退：返回空由上层用"页正文文本"兜底。
 */
function extractYouTubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,18})/)
  return m ? m[1] : null
}

/** 从字幕 XML(fmt srv1/xml 或 json3) 提取文字行 */
function parseXmlText(xml: string): string[] {
  const lines: string[] = []
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(xml)) !== null) {
    const txt = mm[1]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
      .replace(/<br\s*\/?>/gi, '\n')
      .trim()
    if (txt) lines.push(txt)
  }
  return lines
}

/** 从 json3(fmt=json3) 提取文字行 */
function parseJson3(json: string): string[] {
  try {
    const d = JSON.parse(json)
    const lines: string[] = []
    for (const ev of (d?.events || [])) {
      const segs = ev?.segs || []
      const t = segs.map((s: any) => s?.utf8 || '').join('').trim()
      if (t) lines.push(t)
    }
    return lines
  } catch { return [] }
}

/** 从已加载的 YouTube 页上下文提取带签名 captionTracks baseUrl(真实浏览器跑页面 JS，绕过反爬) */
async function tryExtractCaptionHrefs(): Promise<string[]> {
  try {
    const { browserEvalJS } = await import('./ai-browser')
    // 页面里 ytInitialPlayerResponse 有 captionTracks；也可能需微延迟等 JS。用 arg 探测两次
    const src = `var out=[];
      var hit=(window||{}).ytInitialPlayerResponse||(window||{}).ytplayer&&(window.ytplayer.config||{}).args.player_response;
      var parse=(obj)=>{ try{ var d=typeof obj==='string'?JSON.parse(obj):obj; var ts=(d&&d.captions&&d.captions.playerCaptionsTracklistRenderer&&d.captions.playerCaptionsTracklistRenderer.captionTracks)||[]; for(var i=0;i<ts.length;i++){ if(ts[i].baseUrl) out.push({url:ts[i].baseUrl.replace(/\\\\u0026/g,'&'),lang:ts[i].languageCode||'',kind:ts[i].kind||'',name:(ts[i].name&&(ts[i].name.simpleText||ts[i].name.runs&&ts[i].name.runs[0].text)||ts[i].languageCode||'')}); } }catch(e){} };
      if(hit)parse(hit); else { var m=(document.documentElement.innerHTML).match(/ytInitialPlayerResponse\\s*=\\s*({.+?});/); if(m)parse(m[1]); }
      var seen={},out2=[]; for(var i=0;i<out.length;i++){ if(!seen[out[i].url]){seen[out[i].url]=1; out2.push(out[i]);} }
      return out2;`
    const raw = await browserEvalJS<any[]>(src)
    const arr = (Array.isArray(raw) ? raw : []).map((x) => ({ ...x, url: String(x?.url || '') }))
    // 中文优先(与做成中文稿最对口)，其次英文、手动(译者)、最后 asr
    const score = (x: any) => (x.lang === 'zh-Hans' || x.lang === 'zh-CN' || x.lang === 'zh' ? 0 : x.lang?.startsWith?.('zh') ? 1 : x.lang === 'en' ? 2 : 3)
    arr.sort((a, b) => score(a) - score(b))
    return arr.map((x) => x.url).filter(Boolean).slice(0, 6)
  } catch { return [] }
}

/** 免 key 抓一段 YouTube 字幕：用真实浏览器(ai-browser/Playwright Chrome)打开视频页，
 *  规避签名反爬，从页面提取 captionTracks 后 fetch；正文容器文本作兜底 */
export async function fetchYouTubeTranscript(url: string): Promise<{ ok: boolean; text: string; lang: string }> {
  const vid = extractYouTubeId(url)
  if (!vid) return { ok: false, text: '', lang: '' }
  try {
    const { browserNavigate } = await import('./ai-browser')
    await browserNavigate(url)
    // 从已加载页提取所有 timedtext baseUrl(带签名)+所属语言
    const hrefs = await tryExtractCaptionHrefs()
    for (const h of hrefs) {
      try {
        const r = await fetch(h, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) })
        if (!r.ok) continue
        const body = await r.text()
        const lines = parseXmlText(body)
        if (lines.length > 4) {
          const lang = (h.match(/lang=([a-z-]+)/) || [])[1] || 'en'
          return { ok: true, text: lines.join('\n').slice(0, 40000), lang }
        }
      } catch { /* next */ }
    }
    return { ok: false, text: '', lang: '' }
  } catch {
    return { ok: false, text: '', lang: '' }
  }
}
