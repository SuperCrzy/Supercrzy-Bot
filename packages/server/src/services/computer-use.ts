/**
 * Computer Use 服务 — 通过 MCP 接入开源的 computer-use-mcp（nut.js 驱动）
 *
 * 设计（老板原则：能用成熟开源就不自研）：
 * - computer-use-mcp 是 stdio MCP server（npm 包，截屏/鼠标/键盘/剪贴板）
 * - 本模块负责：spawn 子进程 + MCP 客户端连接 + 工具调用包装
 * - 安全：仅在 permissionLevel = 'full' 时可用（工具确认机制在 tools.ts 层）
 *
 * 工具面（computer-use-mcp 提供）：screenshot / click / double_click / type /
 * key / scroll / move / clipboard_read / clipboard_write / app_launch 等
 */
import { spawn, type ChildProcess } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

let client: Client | null = null
let transport: StdioClientTransport | null = null
let proc: ChildProcess | null = null
let connecting: Promise<Client> | null = null

/** 是否已连接 */
export function isComputerUseReady(): boolean {
  return client !== null
}

/**
 * 启动并连接 computer-use-mcp（惰性：首次调用工具时连接）
 * 通过 npx 运行 npm 包（项目本地或全局均可）
 */
export async function getComputerUseClient(): Promise<Client> {
  if (client) return client
  if (connecting) return connecting

  connecting = (async () => {
    // 优先本地 npx 缓存，避免每次下载；找不到时回退到已安装的包
    const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    proc = spawn(cmd, ['-y', 'computer-use-mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    proc.stderr?.on('data', (d) => {
      const msg = String(d).trim()
      if (msg && !msg.includes('ExperimentalWarning')) console.log(`[ComputerUse] ${msg}`)
    })
    proc.on('exit', (code) => {
      console.log(`[ComputerUse] server exited (${code})`)
      client = null
      transport = null
      proc = null
    })

    transport = new StdioClientTransport({
      command: cmd,
      args: ['-y', 'computer-use-mcp'],
    })
    const c = new Client({ name: 'supercrzy-server', version: '1.0.0' })
    await c.connect(transport)
    client = c
    console.log('[ComputerUse] MCP server connected (screenshot/click/keyboard)')
    return c
  })()

  try {
    return await connecting
  } catch (err) {
    connecting = null
    throw err
  }
}

/** Agent 侧 action → computer-use-mcp 真实 action 映射 */
const ACTION_MAP: Record<string, string> = {
  screenshot: 'get_screenshot',
  click: 'left_click',
  right_click: 'right_click',
  double_click: 'double_click',
  drag: 'left_click_drag',
  type: 'type',
  key: 'key',
  scroll: 'scroll',
  move: 'mouse_move',
  cursor: 'get_cursor_position',
  open: 'key', // 打开应用走 cmd+space Spotlight 输入，或由用户手动；此处保留 key 通道
}

/**
 * 调用 computer-use-mcp 的 computer 工具
 * @param action Agent 侧操作名（screenshot/click/type/key/scroll/move/...）
 * @param args 参数：{ text?, coordinate?, ... }（Agent 传 {x,y} 时自动转 coordinate）
 */
export async function callComputerUse(
  action: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const c = await getComputerUseClient()
  const realAction = ACTION_MAP[action] || action
  const callArgs: Record<string, unknown> = { action: realAction }
  // 参数转换：Agent 用 {x,y} 坐标，MCP 用 coordinate: [x, y]
  if (typeof args.x === 'number' && typeof args.y === 'number') {
    callArgs.coordinate = [args.x, args.y]
  }
  if (args.text !== undefined) callArgs.text = args.text
  if (args.combo !== undefined) callArgs.text = args.combo // key 组合键走 text
  if (args.clicks !== undefined) callArgs.text = String(args.clicks) // scroll 方向
  if (args.name !== undefined) callArgs.text = args.name // open 应用名 → Spotlight
  try {
    const result = await c.callTool({ name: 'computer', arguments: callArgs })
    // MCP 结果可能是 text 数组
    const contents = (result?.content || []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    // 截屏（screenshot）：保存图片 + 本地 OCR 认字 → 返回给 AI（补上"眼睛"）
    if (action === 'screenshot') {
      const img = contents.find((item) => item.type === 'image')
      if (img?.data) {
        return await saveScreenshotWithOcr(img.data)
      }
    }
    return contents
      .map((item) => (item.type === 'text' ? item.text || '' : item.type === 'image' ? '[screenshot]' : JSON.stringify(item)))
      .join('\n')
  } catch (err: any) {
    return `❌ computer_use 工具 ${action} 调用失败: ${err.message}`
  }
}

/**
 * 保存截屏 PNG 并本地 OCR 认字（免费链路：截图→RapidOCR→文本注入 AI 上下文）
 * 返回给 Agent：截图路径 + 识别出的屏幕文字
 */
async function saveScreenshotWithOcr(base64Data: string): Promise<string> {
  const { mkdirSync, writeFileSync, existsSync } = await import('fs')
  const { join, dirname } = await import('path')
  const { fileURLToPath } = await import('url')
  try {
    const buf = Buffer.from(base64Data, 'base64')
    const shotDir = join(process.cwd(), 'uploads', 'screenshots')
    if (!existsSync(shotDir)) mkdirSync(shotDir, { recursive: true })
    const fname = `screen-${Date.now()}.png`
    const fpath = join(shotDir, fname)
    writeFileSync(fpath, buf)
    // 本地 OCR（与 /api/ocr 同一脚本，免费认字）
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execFileP = promisify(execFile)
      const __dirname = dirname(fileURLToPath(import.meta.url))
      const PYTHON_BIN = process.env.OCR_PYTHON_BIN || '/Users/chaojiphonekuang/.workbuddy/binaries/python/envs/default/bin/python'
      const OCR_SCRIPT = join(__dirname, '../../scripts/ocr_service.py')
      const { stdout } = await execFileP(PYTHON_BIN, [OCR_SCRIPT, fpath], { timeout: 30000 })
      const ocr = JSON.parse(stdout) as { texts?: string[]; error?: string }
      if (ocr.error) return `📸 截图已保存: ${fpath}\n（OCR 失败: ${ocr.error}）`
      const lines = (ocr.texts || []).map((t) => `- ${t}`).join('\n')
      return `📸 截图已保存: ${fpath}\n🔍 屏幕文字识别（OCR）:\n${lines || '（未识别到文字）'}`
    } catch (err: any) {
      return `📸 截图已保存: ${fpath}\n（OCR 调用失败: ${err.message}）`
    }
  } catch (err: any) {
    return `❌ 截屏保存失败: ${err.message}`
  }
}

/** 停止 MCP server（应用退出时调用） */
export function stopComputerUse(): void {
  try { transport?.close() } catch { /* ignore */ }
  if (proc) { proc.kill('SIGTERM'); proc = null }
  client = null
  transport = null
  connecting = null
}
