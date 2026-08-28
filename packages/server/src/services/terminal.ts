/**
 * WebSocket 终端服务
 * 支持实时 Shell 交互、文件浏览、代码编辑
 */
import { WebSocketServer, WebSocket } from 'ws'
import { Server } from 'http'
import { spawn, exec } from 'child_process'
import { readFile, writeFile, readdir, stat, mkdir, rm, rename } from 'fs/promises'
import { join, resolve, basename, dirname } from 'path'
import { getDB } from './database'

interface TerminalSession {
  ws: WebSocket
  process: ReturnType<typeof spawn> | null
  cwd: string
  id: string
}

const sessions = new Map<string, TerminalSession>()
let sessionCounter = 0

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || process.cwd()

/**
 * 工作区初始目录：优先取最近会话的绑定目录（AI 真正干活的地方），
 * 避免"AI 写在会话绑定目录、文件树看 WORKSPACE_ROOT"的目录错位。
 */
function getInitialCwd(): string {
  try {
    const db = getDB()
    const row = db.prepare(`
      SELECT workspace_dir FROM sessions
      WHERE workspace_dir != '' AND workspace_dir IS NOT NULL
        AND COALESCE(is_playground, 0) = 0
      ORDER BY created_at DESC LIMIT 1
    `).get() as { workspace_dir?: string } | undefined
    return row?.workspace_dir || WORKSPACE_ROOT
  } catch {
    return WORKSPACE_ROOT
  }
}

export function createTerminalServer(server: Server) {
  // noServer 模式 + 手动 upgrade：避免与幽灵工作台（/ws/ghost）共享 server 时
  // {server,path} 实例对不匹配 path 的请求 abort(400)/干扰已升级连接
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname !== '/ws/terminal') return
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    const sessionId = `term_${++sessionCounter}`
    const session: TerminalSession = {
      ws,
      process: null,
      cwd: getInitialCwd(),
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
    case 'create_file':
      await handleCreateFile(session, msg.path)
      break
    case 'create_dir':
      await handleCreateDir(session, msg.path)
      break
    case 'delete_file':
      await handleDeleteFile(session, msg.path)
      break
    case 'rename_file':
      await handleRenameFile(session, msg.path, msg.newName)
      break
    case 'git_status':
      await handleGitStatus(session)
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

/** 安全路径校验：只允许在工作区根内操作 */
function assertWsPath(session: TerminalSession, p: string): string {
  const target = resolve(session.cwd, p || '')
  const root = resolve(session.cwd)
  if (!target.startsWith(root + '/') && target !== root) {
    throw new Error(`路径超出工作区: ${p}`)
  }
  return target
}

async function handleCreateFile(session: TerminalSession, filePath: string) {
  try {
    const target = assertWsPath(session, filePath)
    await writeFile(target, '', 'utf-8')
    session.ws.send(JSON.stringify({ type: 'file_created', path: target, name: basename(target) }))
  } catch (err: any) {
    session.ws.send(JSON.stringify({ type: 'error', message: `创建文件失败: ${err.message}` }))
  }
}

async function handleCreateDir(session: TerminalSession, dirPath: string) {
  try {
    const target = assertWsPath(session, dirPath)
    await mkdir(target, { recursive: false })
    session.ws.send(JSON.stringify({ type: 'dir_created', path: target, name: basename(target) }))
  } catch (err: any) {
    session.ws.send(JSON.stringify({ type: 'error', message: `创建目录失败: ${err.message}` }))
  }
}

async function handleDeleteFile(session: TerminalSession, filePath: string) {
  try {
    const target = assertWsPath(session, filePath)
    await rm(target, { recursive: true, force: true })
    session.ws.send(JSON.stringify({ type: 'file_deleted', path: target }))
  } catch (err: any) {
    session.ws.send(JSON.stringify({ type: 'error', message: `删除失败: ${err.message}` }))
  }
}

async function handleRenameFile(session: TerminalSession, filePath: string, newName: string) {
  try {
    if (!newName || newName.includes('/')) throw new Error('无效的新名称')
    const target = assertWsPath(session, filePath)
    const newPath = join(dirname(target), newName)
    await rename(target, newPath)
    session.ws.send(JSON.stringify({ type: 'file_renamed', path: newPath, oldPath: target, name: newName }))
  } catch (err: any) {
    session.ws.send(JSON.stringify({ type: 'error', message: `重命名失败: ${err.message}` }))
  }
}

async function handleGitStatus(session: TerminalSession) {
  try {
    const cwd = session.cwd
    const branch = await new Promise<string>((resolve2) => {
      exec('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 5000 }, (err, stdout) => {
        resolve2(err ? '' : stdout.trim())
      })
    })
    let modified: string[] = []
    if (branch) {
      const out = await new Promise<string>((resolve2) => {
        exec('git status --porcelain', { cwd, timeout: 8000 }, (err, stdout) => {
          resolve2(err ? '' : stdout)
        })
      })
      // git 输出相对路径 → 转绝对路径（前端文件树节点用绝对路径匹配）
      modified = out.split('\n').filter(Boolean).map((l) => {
        const rel = l.slice(3).trim()
        return rel ? join(cwd, rel) : ''
      }).filter(Boolean)
    }
    session.ws.send(JSON.stringify({ type: 'git_status', branch, modified }))
  } catch (err: any) {
    session.ws.send(JSON.stringify({ type: 'git_status', branch: '', modified: [] }))
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
