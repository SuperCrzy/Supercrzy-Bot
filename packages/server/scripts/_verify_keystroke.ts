// 判定键盘事件是否真的落到系统上：发 cmd+space 后立刻截图，看 Spotlight 是否弹出
import { callComputerUse } from '../src/services/computer-use'

const log = (t: string) => console.log(`\n===== ${t} =====`)

log('1) 发 cmd+space')
console.log(await callComputerUse('key', { combo: 'cmd+space' }))
await new Promise((r) => setTimeout(r, 1500))

log('2) 截图 OCR，找 Spotlight 特征词')
const shot = await callComputerUse('screenshot', {})
const text = shot
const hit = /Spotlight|搜索|聚焦|Search/i.test(text)
console.log('OCR 是否出现 Spotlight 特征词:', hit)
console.log(text.slice(text.indexOf('OCR') >= 0 ? text.indexOf('OCR') : 0, 1400))

log('3) 收尾：按 esc 关掉 Spotlight')
console.log(await callComputerUse('key', { combo: 'escape' }))
process.exit(0)
