/**
 * WebSocket 终端服务
 * 支持实时 Shell 交互、文件浏览、代码编辑
 */
import { WebSocketServer, WebSocket } from 'ws'
import { Server } from 'http'
import { spawn, exec } from 'child_process'
import { readFile, writeFile, readdir, stat } from 'fs/promises'
import { join, resolve } from 'path'

interface TerminalSession {
  ws: WebSocket
  process: ReturnType<typeof spawn> | null
  cwd: string
  id: string
}

const sessions = new Map<string, TerminalSession>()
let sessionCounter = 0

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || process.cwd()

export function createTerminalServer(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws/terminal' })

  wss.on('connection', (ws) => {
    const sessionId = `term_${++sessionCounter}`
    const session: TerminalSession = {
      ws,
      process: null,
      cwd: WORKSPACE_ROOT,
      id: sessionId,
    }
    sessions.set(sessionId, session)

    ws.send(JSON.stringify({
      type: 'connected',
      sessionId,
      cwd: session.cwd,
    }))

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        await handleMessage(session, msg)
      } catch (err: any) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }))
      }
    })

    ws.on('close', () => {
      killProcess(session)
      sessions.delete(sessionId)
    })
  })

  console.log('[terminal] WebSocket server ready at /ws/terminal')
}

function killProcess(session: TerminalSession) {
  if (session.process) {
    session.process.kill()
    session.process = null
  }
}

async function handleMessage(session: TerminalSession, msg: any) {
  switch (msg.type) {
    case 'exec':
      await handleExec(session, msg.command)
      break
    case 'spawn':
      await handleSpawn(session, msg.command, msg.args || [])
      break
    case 'input':
      if (session.process?.stdin?.writable) {
        session.process.stdin.write(msg.data)
      }
      break
    case 'resize':
      if (session.process?.stdout) {
        (session.process.stdout as any).rows = msg.rows
        ;(session.process.stdout as any).columns = msg.cols
      }
      break
    case 'kill':
      killProcess(session)
      break
    case 'list_files':
      await handleListFiles(session, msg.path || session.cwd)
      break
    case 'read_file':
      await handleReadFile(session, msg.path)
      break
    case 'write_file':
      await handleWriteFile(session, msg.path, msg.content)
      break
    case 'cd':
      session.cwd = resolve(session.cwd, msg.path)
      session.ws.send(JSON.stringify({ type: 'cwd', cwd: session.cwd }))
      break
  }
}

// 一次性命令执行
async function handleExec(session: TerminalSession, command: string) {
  exec(command, { cwd: session.cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      session.ws.send(JSON.stringify({
        type: 'exec_result',
        command,
        output: stderr || error.message,
        exitCode: error.code,
      }))
    } else {
      session.ws.send(JSON.stringify({
        type: 'exec_result',
        command,
        output: stdout + (stderr ? '\n' + stderr : ''),
        exitCode: 0,
      }))
    }
  })
}

// 交互式 Shell
async function handleSpawn(session: TerminalSession, command: string, args: string[]) {
  killProcess(session)

  const proc = spawn(command, args, {
    cwd: session.cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
    shell: true,
  })

  session.process = proc

  proc.stdout?.on('data', (data: Buffer) => {
    session.ws.send(JSON.stringify({ type: 'output', data: data.toString() }))
  })

  proc.stderr?.on('data', (data: Buffer) => {
    session.ws.send(JSON.stringify({ type: 'output', data: data.toString() }))
  })

  proc.on('close', (code) => {
    session.ws.send(JSON.stringify({ type: 'exit', exitCode: code }))
    session.process = null
  })

  proc.on('error', (err) => {
    session.ws.send(JSON.stringify({ type: 'error', message: err.message }))
  })
}

// 文件浏览器
async function handleListFiles(session: TerminalSession, dirPath: string) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const files = await Promise.all(
      entries
        .filter(e => !e.name.startsWith('.') || e.name === '.gitignore')
        .map(async (e) => {
          const fullPath = join(dirPath, e.name)
          let size = 0
          let mtime = ''
          try {
            const s = await stat(fullPath)
            size = s.size
            mtime = s.mtime.toISOString()
          } catch {}
          return {
            name: e.name,
            isDirectory: e.isDirectory(),
            size,
            mtime,
            path: fullPath,
          }
        })
    )
    // 排序：目录在前，按名称排序
    files.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    session.ws.send(JSON.stringify({ type: 'file_list', path: dirPath, files }))
  } catch (err: any) {
    session.ws.send(JSON.stringify({ type: 'error', message: err.message }))
  }
}

async function handleReadFile(session: TerminalSession, filePath: string) {
  try {
    const content = await readFile(filePath, 'utf-8')
    session.ws.send(JSON.stringify({
      type: 'file_content',
      path: filePath,
      content: content.slice(0, 100000), // 限制 100KB
    }))
  } catch (err: any) {
    session.ws.send(JSON.stringify({ type: 'error', message: err.message }))
  }
}

async function handleWriteFile(session: TerminalSession, filePath: string, content: string) {
  try {
    await writeFile(filePath, content, 'utf-8')
    session.ws.send(JSON.stringify({ type: 'file_saved', path: filePath }))
  } catch (err: any) {
    session.ws.send(JSON.stringify({ type: 'error', message: err.message }))
  }
}
