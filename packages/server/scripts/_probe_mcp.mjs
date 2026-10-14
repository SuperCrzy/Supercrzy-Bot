// 一次性探针：列出 computer-use-mcp 真实暴露的工具与 action 枚举
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const transport = new StdioClientTransport({
  command: cmd,
  args: ['-y', 'computer-use-mcp'],
  stderr: 'pipe',
})
const client = new Client({ name: 'probe', version: '0.0.1' })
await client.connect(transport)

const list = await client.listTools()
for (const t of list.tools) {
  console.log('TOOL:', t.name)
  const props = t.inputSchema?.properties || {}
  for (const [k, v] of Object.entries(props)) {
    if (k === 'action' && v.enum) {
      console.log('  action enum =', JSON.stringify(v.enum))
    } else {
      console.log('  param:', k, v.type)
    }
  }
}
await transport.close()
process.exit(0)
