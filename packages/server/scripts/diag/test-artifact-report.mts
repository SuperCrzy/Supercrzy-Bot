/** Confirms file_write and multi_edit report artifacts, which they never did. */
import { directoryTools } from '../../src/tools/registry.js'
import fs from 'node:fs'

const WORK = '/tmp/artcheck'
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })

const reported: any[] = []
const ctx: any = {
  cwd: WORK, workspaceDir: WORK,
  onOutput: () => {}, onProgress: () => {}, shouldStop: () => false,
  onFileChange: () => {},
  onArtifacts: (files: any[]) => reported.push(...files),
}

const write = directoryTools.find(t => t.name === 'file_write')!
const edit = directoryTools.find(t => t.name === 'multi_edit')!
const target = `${WORK}/sample.txt`

await write.execute({ path: target, content: 'hello\nworld\n' }, ctx)
await edit.execute({ path: target, edits: [{ oldText: 'hello', newText: 'HELLO' }] }, ctx)

console.log('reported count:', reported.length)
for (const r of reported) console.log(` ${r.action.padEnd(8)} ${r.size}B  ${r.name}  <- ${r.path}`)
console.log('after:', JSON.stringify(reported.map(r => r.action)))
