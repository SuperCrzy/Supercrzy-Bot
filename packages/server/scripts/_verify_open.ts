// e2e 验证：open 修复后是否真能唤起 App（走 Spotlight 组合键）
import { callComputerUse } from '../src/services/computer-use'

const log = (t: string) => console.log(`\n===== ${t} =====`)

log('A. 复现旧 bug 的报错签名（key 通道直接塞应用名）')
console.log(await callComputerUse('key', { combo: 'safari' }))

log('B. 新路径：open Safari（cmd+space → type Safari → enter）')
console.log(await callComputerUse('open', { name: 'Safari' }))

await new Promise((r) => setTimeout(r, 2500))

log('C. 截屏确认（返回截图路径 + OCR 文字）')
const shot = await callComputerUse('screenshot', {})
console.log(shot.slice(0, 1200))

process.exit(0)
