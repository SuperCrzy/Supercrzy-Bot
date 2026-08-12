<template>
  <div class="workspace">
    <!-- Left: File Browser -->
    <aside class="file-panel" :style="{ width: filePanelWidth + 'px' }">
      <div class="panel-header">
        <span>Files</span>
        <div class="panel-actions">
          <n-button size="tiny" quaternary @click="refreshFiles">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </n-button>
        </div>
      </div>
      <div class="file-tree">
        <div v-for="f in files" :key="f.name" class="file-item"
          :class="{ directory: f.isDirectory }"
          @click="f.isDirectory ? navigateTo(f.path) : openFile(f.path)">
          <span class="file-icon">{{ f.isDirectory ? '&#x1F4C1;' : fileIcon(f.name) }}</span>
          <span class="file-name">{{ f.name }}</span>
          <span class="file-size" v-if="!f.isDirectory">{{ formatSize(f.size) }}</span>
        </div>
        <n-empty v-if="files.length === 0" description="Empty" class="empty-hint" />
      </div>
      <div class="file-breadcrumb">
        <span class="bread-path">{{ currentDir.replace(workspaceRoot, '~') || '/' }}</span>
      </div>
    </aside>

    <!-- Resizable divider -->
    <div class="resizer" @mousedown="startResize('files', $event)"></div>

    <!-- Center: Editor + Terminal -->
    <div class="main-panel">
      <!-- Terminal -->
      <div class="terminal-panel" :style="{ height: terminalHeight + 'px' }">
        <div class="panel-header">
          <span>Terminal</span>
          <div class="panel-actions">
            <n-button size="tiny" quaternary @click="clearTerminal">Clear</n-button>
            <n-button size="tiny" quaternary @click="killTerminal">Kill</n-button>
          </div>
        </div>
        <div class="terminal-container" ref="terminalRef"></div>
      </div>

      <!-- Resizable divider -->
      <div class="resizer horizontal" @mousedown="startResize('terminal', $event)"></div>

      <!-- Code Editor (Monaco) -->
      <div class="editor-panel">
        <div class="panel-header">
          <span>{{ editingFile ? editingFile.split('/').pop() : 'Code Editor' }}</span>
          <div class="panel-actions">
            <span class="panel-status" v-if="editingFile">{{ editingFile }}</span>
            <span class="save-indicator" v-if="isDirty" :class="{ saved: isSaved }">
              {{ isSaved ? 'Saved' : 'Modified' }}
            </span>
            <n-button v-if="editingFile && isDirty" size="tiny" type="primary" @click="saveFile">
              Save
            </n-button>
          </div>
        </div>
        <div class="editor-area" ref="editorRef" v-if="editingFile && fileContent !== null"></div>
        <div class="editor-empty" v-else>
          <p>Select a file to edit</p>
          <p class="hint">Click a file in the browser to open it in the editor</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import * as monaco from 'monaco-editor'

interface FileEntry {
  name: string
  isDirectory: boolean
  size: number
  mtime: string
  path: string
}

const terminalRef = ref<HTMLElement>()
const editorRef = ref<HTMLElement>()
const files = ref<FileEntry[]>([])
const currentDir = ref('/')
const workspaceRoot = ref('/')
const editingFile = ref('')
const fileContent = ref<string | null>(null)
const filePanelWidth = ref(240)
const terminalHeight = ref(280)
const isDirty = ref(false)
const isSaved = ref(false)

let ws: WebSocket | null = null
let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let editor: monaco.editor.IStandaloneCodeEditor | null = null

const WS_URL = `ws://localhost:${location.port}/ws/terminal`

// WebSocket connection
function connectWS() {
  ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    console.log('[workspace] WS connected')
    listFiles(currentDir.value)
  }

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    switch (msg.type) {
      case 'connected':
        workspaceRoot.value = msg.cwd
        currentDir.value = msg.cwd
        break
      case 'output':
        term?.write(msg.data)
        break
      case 'exit':
        term?.write(`\r\n[Process exited with code ${msg.exitCode}]\r\n`)
        break
      case 'error':
        term?.write(`\r\n[Error: ${msg.message}]\r\n`)
        break
      case 'file_list':
        currentDir.value = msg.path
        files.value = msg.files
        break
      case 'file_content':
        editingFile.value = msg.path
        fileContent.value = msg.content
        isDirty.value = false
        isSaved.value = false
        nextTick(() => initEditor())
        break
      case 'file_saved':
        isSaved.value = true
        isDirty.value = false
        setTimeout(() => { isSaved.value = false }, 2000)
        break
      case 'cwd':
        currentDir.value = msg.cwd
        listFiles(msg.cwd)
        break
      case 'exec_result':
        term?.write(`\r\n$ ${msg.command}\r\n${msg.output}\r\n`)
        break
    }
  }

  ws.onclose = () => {
    setTimeout(connectWS, 2000)
  }
}

// Terminal initialization
onMounted(async () => {
  await nextTick()
  if (!terminalRef.value) return

  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#1a1a2e',
      foreground: '#e5e5e5',
      cursor: '#e5e5e5',
      selectionBackground: '#333366',
      black: '#1a1a2e',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#6272a4',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#e5e5e5',
    },
    allowProposedApi: true,
  })

  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new WebLinksAddon())

  term.open(terminalRef.value)
  fitAddon.fit()

  term.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }))
    }
  })

  term.writeln('SuperCrzy Terminal')
  term.writeln('Type commands to interact with the agent workspace.\r\n')

  connectWS()
  spawnShell()

  window.addEventListener('resize', () => fitAddon?.fit())
})

onUnmounted(() => {
  editor?.dispose()
  ws?.close()
  term?.dispose()
})

function spawnShell() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'spawn', command: /win/i.test(navigator.platform + ' ' + navigator.userAgent) ? 'cmd.exe' : '/bin/zsh' }))
  }
}

function sendCmd(cmd: string) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'exec', command: cmd }))
  }
}

function listFiles(path: string) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'list_files', path }))
  }
}

function navigateTo(path: string) {
  listFiles(path)
}

function openFile(path: string) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'read_file', path }))
  }
}

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    vue: 'html', py: 'python', rs: 'rust', go: 'go', java: 'java',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    md: 'markdown', html: 'html', css: 'css', scss: 'scss', less: 'less',
    xml: 'xml', svg: 'xml', sh: 'shell', bash: 'shell',
    sql: 'sql', graphql: 'graphql', dockerfile: 'dockerfile',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', rb: 'ruby', php: 'php',
    swift: 'swift', kt: 'kotlin', dart: 'dart',
  }
  return map[ext] || 'plaintext'
}

function initEditor() {
  if (!editorRef.value || fileContent.value === null) return

  if (editor) {
    editor.dispose()
  }

  const lang = getLanguage(editingFile.value)

  editor = monaco.editor.create(editorRef.value, {
    value: fileContent.value,
    language: lang,
    theme: document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    minimap: { enabled: true, maxColumn: 80 },
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    automaticLayout: true,
    tabSize: 2,
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    suggestOnTriggerCharacters: true,
    quickSuggestions: true,
    padding: { top: 8 },
  })

  editor.onDidChangeModelContent(() => {
    isDirty.value = true
    isSaved.value = false
  })

  // Ctrl+S / Cmd+S save
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    saveFile()
  })
}

function saveFile() {
  if (!editor || !editingFile.value) return
  const content = editor.getValue()
  fileContent.value = content
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'write_file', path: editingFile.value, content }))
  }
}

function refreshFiles() {
  listFiles(currentDir.value)
}

function clearTerminal() {
  term?.clear()
}

function killTerminal() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'kill' }))
  }
  setTimeout(spawnShell, 500)
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  const icons: Record<string, string> = {
    ts: '&#x1F4D8;', tsx: '&#x1F4D8;', js: '&#x1F4DC;', jsx: '&#x1F4DC;',
    vue: '&#x1F49A;', py: '&#x1F40D;', rs: '&#x1F980;', go: '&#x1F43F;',
    json: '&#x2699;', yaml: '&#x2699;', yml: '&#x2699;', toml: '&#x2699;',
    md: '&#x1F4DD;', html: '&#x1F310;', css: '&#x1F3A8;', scss: '&#x1F3A8;',
    svg: '&#x1F5BC;', png: '&#x1F5BC;', jpg: '&#x1F5BC;', gif: '&#x1F5BC;',
    sh: '&#x1F4BB;', bash: '&#x1F4BB;', dockerfile: '&#x1F433;',
    pdf: '&#x1F4C4;', zip: '&#x1F4E6;', gz: '&#x1F4E6;',
  }
  return icons[ext || ''] || '&#x1F4C4;'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// Resize handling
function startResize(panel: string, e: MouseEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startY = e.clientY
  const startWidth = filePanelWidth.value
  const startHeight = terminalHeight.value

  function onMove(ev: MouseEvent) {
    if (panel === 'files') {
      filePanelWidth.value = Math.max(160, Math.min(500, startWidth + ev.clientX - startX))
    } else {
      terminalHeight.value = Math.max(120, Math.min(600, startHeight + ev.clientY - startY))
    }
    fitAddon?.fit()
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}
</script>

<style scoped>
.workspace { display: flex; height: 100vh; background: var(--bg-primary); }

/* File Panel */
.file-panel { border-right: 1px solid var(--border-color); display: flex; flex-direction: column; background: var(--bg-secondary); min-width: 160px; }
.panel-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--border-color); font-size: 12px; font-weight: 600; color: var(--text-secondary); flex-shrink: 0; }
.panel-actions { display: flex; gap: 2px; }
.file-tree { flex: 1; overflow-y: auto; padding: 4px 0; }
.file-item { display: flex; align-items: center; gap: 6px; padding: 5px 12px; cursor: pointer; font-size: 13px; color: var(--text-primary); transition: background .1s; }
.file-item:hover { background: var(--bg-primary); }
.file-icon { font-size: 14px; flex-shrink: 0; }
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.file-size { font-size: 11px; color: var(--text-muted); }
.file-breadcrumb { padding: 6px 12px; border-top: 1px solid var(--border-color); font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
.bread-path { font-family: monospace; }
.empty-hint { margin-top: 40px; transform: scale(0.7); }

/* Resizer */
.resizer { width: 4px; cursor: col-resize; background: transparent; transition: background .2s; flex-shrink: 0; }
.resizer:hover { background: var(--accent); }
.resizer.horizontal { width: 100%; height: 4px; cursor: row-resize; }

/* Main Panel */
.main-panel { flex: 1; display: flex; flex-direction: column; min-width: 0; }

/* Terminal */
.terminal-panel { border-bottom: 1px solid var(--border-color); display: flex; flex-direction: column; flex-shrink: 0; }
.terminal-container { flex: 1; padding: 4px; overflow: hidden; }
.terminal-container :deep(.xterm) { height: 100%; }
.terminal-container :deep(.xterm-viewport) { overflow-y: auto; }

/* Editor */
.editor-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.editor-area { flex: 1; overflow: hidden; }
.save-indicator { font-size: 11px; padding: 2px 8px; border-radius: 4px; color: var(--text-muted); }
.save-indicator.saved { color: #50fa7b; }
.editor-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-muted); gap: 8px; }
.editor-empty p { margin: 0; font-size: 13px; }
.editor-empty .hint { font-size: 12px; }
.panel-status { font-size: 11px; color: var(--text-muted); font-family: monospace; }
</style>
