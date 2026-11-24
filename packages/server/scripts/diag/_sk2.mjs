const BASE = 'http://127.0.0.1:3000'
async function main() {
  const s = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'sk' }) })
  const sid = (await s.json()).id
  const res = await fetch(`${BASE}/api/chat/agent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, messages: [{ role: 'user', content: '用 brainstorming 技能帮我理清一个需求' }] }),
  })
  let all = ''
  try {
    const buf = await res.arrayBuffer()
    all = Buffer.from(buf).toString('utf8')
  } catch (e) { console.log('READ_ERR', e.message); return }
  const tools = [...new Set([...all.matchAll(/"name":"([a-z_]+)"/g)].map(m => m[1]))]
  console.log('BYTES', all.length)
  console.log('TOOLS ' + (tools.join(',') || 'none'))
  console.log('SKILL_VIEW ' + (tools.includes('skill_view') ? 'YES' : 'NO'))
}
main().then(() => process.exit(0)).catch(e => { console.log('ERR', e.message); process.exit(1) })
