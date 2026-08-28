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
        <div v-if="gitBranch" class="git-bar" :title="'Git 分支'">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="6" y1="9" x2="6" y2="15"/><path d="M6 6h8a3 3 0 0 1 3 3v3"/></svg>
          <span class="git-branch">{{ gitBranch }}</span>
        </div>
        <FileTreeNode
          v-for="f in treeRoots"
          :key="f.path"
          :node="f"
          :depth="0"
          :dirty-set="gitDirty"
          @toggle="toggleDir"
          @open="openFile"
          @ctx="openContextMenu"
        />
        <n-empty v-if="files.length === 0" description="Empty" class="empty-hint" />
      </div>
      <div class="file-breadcrumb">
        <span class="bread-path">{{ currentDir.replace(workspaceRoot, '~') || '/' }}</span>
        <span class="bread-actions">
          <button class="bread-btn" :title="'新建文件'" @click="createItem(false)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
          <button class="bread-btn" :title="'新建文件夹'" @click="createItem(true)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg></button>
          <button class="bread-btn" :title="'刷新'" @click="listFiles(currentDir)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
        </span>
      </div>
      <!-- 右键菜单（文件 CRUD） -->
      <div v-if="ctxMenu.visible" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }" @contextmenu.prevent>
        <div v-if="ctxMenu.node" class="ctx-item" @click="renameItem">重命名</div>
        <div v-if="ctxMenu.node" class="ctx-item danger" @click="deleteItem">删除</div>
        <div class="ctx-item" @click="createItem(false)">新建文件</div>
        <div class="ctx-item" @click="createItem(true)">新建文件夹</div>
      </div>
    </aside>

    <!-- Resizable divider -->
    <div class="resizer" @mousedown="startResize('files', $event)"></div>

    <!-- Center: Editor + Terminal -->
    <div class="main-panel">
      <!-- AI 活动流（P1-1：AI 在聊天里干活时，工作区实时显示写到哪个文件 + 自动刷新文件树） -->
      <div v-if="aiActivities.length > 0" class="ai-activity">
        <div class="ai-activity-title">
          <span class="ai-pulse" /> AI 活动
        </div>
        <div v-for="a in aiActivities" :key="a.path + a.ts" class="ai-activity-item" @click="openAiActivity(a)">
          <span class="ai-action">{{ a.action }}</span>
          <span class="ai-file">{{ a.path.split('/').pop() }}</span>
          <span class="ai-time">{{ timeAgo(a.ts) }}</span>
        </div>
      </div>
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
              <!-- 工作区预览（L1）：html 文件一键切换 编辑器/预览 大屏模式 -->
              <n-button v-if="isHtmlFile" size="tiny" :type="previewMode ? 'primary' : 'default'" quaternary @click="previewMode = !previewMode">
                {{ previewMode ? $t('preview.editor') : $t('preview.view') }}
              </n-button>
              <span class="panel-status" v-if="editingFile">{{ editingFile }}</span>
              <span class="save-indicator" v-if="isDirty" :class="{ saved: isSaved }">
                {{ isSaved ? 'Saved' : 'Modified' }}
              </span>
              <n-button v-if="editingFile && isDirty" size="tiny" type="primary" @click="saveFile">
                Save
              </n-button>
            </div>
          </div>
          <HtmlPreview
            v-if="previewMode && isHtmlFile && fileContent"
            :content="fileContent"
            :path="editingFile"
            show-header
          />
          <!-- 图片预览（P2）：选中图片直接渲染，不走文本编辑器 -->
          <div v-else-if="editingFile && isImageFile" class="img-preview">
            <img :src="`/api/workspace/file?path=${encodeURIComponent(editingFile)}`" :alt="editingFile.split('/').pop()" />
            <div class="img-path">{{ editingFile.replace(workspaceRoot, '~') }}</div>
          </div>
          <!-- Markdown 预览（P2）：选中 .md 渲染排版 -->
          <div v-else-if="editingFile && isMdFile && fileContent !== null" class="md-preview" v-html="renderMd(fileContent)"></div>
          <!-- PDF 预览：浏览器原生渲染 -->
          <iframe v-else-if="editingFile && isPdfFile" :src="fileUrl(editingFile)" class="file-preview pdf-preview" />
          <!-- 视频/音频预览：原生播放器 -->
          <video v-else-if="editingFile && isVideoFile" :src="fileUrl(editingFile)" controls class="file-preview media-preview" />
          <audio v-else-if="editingFile && isAudioFile" :src="fileUrl(editingFile)" controls class="audio-preview" />
          <!-- Word 预览（docx-preview 前端渲染） -->
          <div v-else-if="editingFile && isDocxFile" ref="docxRef" class="file-preview docx-preview"></div>
          <!-- Excel 预览（sheetjs 渲染为表格） -->
          <div v-else-if="editingFile && isXlsxFile" class="file-preview xlsx-preview" v-html="xlsxHtml"></div>
          <!-- PPT 预览：暂不支持内嵌，提供下载 -->
          <div v-else-if="editingFile && isPptxFile" class="file-preview pptx-placeholder">
            <p>{{ $t('workspace.pptxHint') }}</p>
            <a :href="fileUrl(editingFile)" :download="editingFile.split('/').pop()">{{ $t('workspace.downloadFile') }}</a>
          </div>
          <div class="editor-area" ref="editorRef" v-else-if="editingFile && fileContent !== null && !previewMode"></div>
          <div class="editor-empty" v-else>
            <p>Select a file to edit</p>
            <p class="hint">Click a file in the browser to open it in the editor</p>
          </div>
        </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import HtmlPreview from '@/components/chat/HtmlPreview.vue'
import FileTreeNode, { type TreeNode } from '@/components/workspace/FileTreeNode.vue'
import MarkdownIt from 'markdown-it'
import { useAppStore } from '@/stores/app'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
function renderMd(content: string): string {
  return md.render(content || '')
}

const appStore = useAppStore()
import * as monaco from 'monaco-editor'

interface FileEntry {
  name: string
  isDirectory: boolean
  size: number
  mtime: string
  path: string
}

// ===== 递归目录树 / 文件 CRUD / Git 状态 / 图片·MD 预览（P1/P2/P3）=====
interface DirNode extends FileEntry {
  children?: DirNode[]
  expanded?: boolean
}
const gitBranch = ref('')
const gitDirty = ref<Set<string>>(new Set())
const ctxMenu = ref<{ visible: boolean; x: number; y: number; node: TreeNode | null }>({ visible: false, x: 0, y: 0, node: null })

/** 根目录树（直接引用 files 数组元素，保持 expanded/children 状态持久） */
const treeRoots = computed<DirNode[]>(() => files.value as unknown as DirNode[])

/** 图片 / Markdown 预览模式 */
const isImageFile = computed(() => {
  const f = editingFile.value.toLowerCase()
  return /\.(png|jpe?g|gif|webp|svg|ico)$/.test(f)
})
const isMdFile = computed(() => {
  return editingFile.value.toLowerCase().endsWith('.md')
})
/* ---- 扩展预览类型（P0：pdf/视频/音频/docx/xlsx/pptx） ---- */
const isPdfFile = computed(() => editingFile.value.toLowerCase().endsWith('.pdf'))
const isVideoFile = computed(() => /\.(mp4|webm|mov|mkv|avi)$/i.test(editingFile.value))
const isAudioFile = computed(() => /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(editingFile.value))
const isDocxFile = computed(() => editingFile.value.toLowerCase().endsWith('.docx'))
const isXlsxFile = computed(() => editingFile.value.toLowerCase().endsWith('.xlsx'))
const isPptxFile = computed(() => editingFile.value.toLowerCase().endsWith('.pptx'))
const xlsxHtml = ref('')
const docxRef = ref<HTMLDivElement | null>(null)

/** 文件流 URL（后端 /api/workspace/file 按 mime 返回） */
function fileUrl(path: string): string {
  return `/api/workspace/file?path=${encodeURIComponent(path)}`
}
async function renderDocx(path: string) {
  if (!docxRef.value) return
  try {
    const blob = await (await fetch(fileUrl(path))).blob()
    const docx = await import('docx-preview')
    await docx.renderAsync(blob, docxRef.value as HTMLElement, undefined, {
      inWrapper: true,
      ignoreWidth: false,
      breakPages: false,
    })
  } catch {
    if (docxRef.value) docxRef.value.innerHTML = '<p style="padding:16px;color:var(--text-muted)">Word 预览失败，请下载后用本机软件打开</p>'
  }
}

/** Excel 渲染：sheetjs 读取并转 HTML 表格（仅第一个 sheet） */
async function renderXlsx(path: string) {
  xlsxHtml.value = ''
  try {
    const buf = await (await fetch(fileUrl(path))).arrayBuffer()
    const XLSX = await import('xlsx')
    const wb = XLSX.read(buf, { type: 'array' })
    const first = wb.SheetNames[0]
    if (first) xlsxHtml.value = XLSX.utils.sheet_to_html(wb.Sheets[first])
  } catch {
    xlsxHtml.value = '<p style="padding:16px;color:var(--text-muted)">Excel 预览失败，请下载后用本机软件打开</p>'
  }
}

function wsSend(type: string, payload: Record<string, any> = {}) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }))
  }
}

/** 展开/折叠目录：展开时懒加载子目录 */
function toggleDir(node: TreeNode) {
  if (node.expanded) {
    node.expanded = false
    node.children = []
    return
  }
  node.expanded = true
  wsSend('list_files', { path: node.path })
}

/** 右键菜单 */
function openContextMenu(ev: MouseEvent, node: TreeNode) {
  const panel = document.querySelector('.file-panel') as HTMLElement | null
  if (!panel) return
  const rect = panel.getBoundingClientRect()
  ctxMenu.value = {
    visible: true,
    x: Math.min(ev.clientX - rect.left, rect.width - 130),
    y: Math.min(ev.clientY - rect.top, rect.height - 120),
    node,
  }
}
function closeContextMenu() {
  ctxMenu.value.visible = false
}
window.addEventListener('click', () => { if (ctxMenu.value.visible) closeContextMenu() })

/** 新建文件/文件夹 */
function createItem(isDir: boolean) {
  const base = ctxMenu.value.node?.isDirectory ? ctxMenu.value.node.path : currentDir.value
  const name = window.prompt(isDir ? '新建文件夹名称：' : '新建文件名称：', isDir ? 'new-folder' : 'untitled.txt')
  if (!name || !name.trim()) return
  ctxMenu.value.visible = false
  wsSend(isDir ? 'create_dir' : 'create_file', { path: `${base}/${name.trim()}` })
}

/** 重命名 */
function renameItem() {
  const node = ctxMenu.value.node
  if (!node) return
  const newName = window.prompt('重命名为：', node.name)
  if (!newName || !newName.trim() || newName.trim() === node.name) return
  ctxMenu.value.visible = false
  wsSend('rename_file', { path: node.path, newName: newName.trim() })
}

/** 删除 */
function deleteItem() {
  const node = ctxMenu.value.node
  if (!node) return
  if (!window.confirm(`确定删除 ${node.name} 吗？此操作不可恢复。`)) return
  ctxMenu.value.visible = false
  wsSend('delete_file', { path: node.path })
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
// 工作区预览（L1）：html 文件切换 编辑器/预览 大屏模式
const previewMode = ref(false)
/** 切换编辑文件时触发 docx/xlsx 专用渲染（docx 需等容器 DOM 挂载） */
watch(editingFile, async (p) => {
  if (isDocxFile.value) {
    await nextTick()
    renderDocx(p)
  } else if (isXlsxFile.value) {
    renderXlsx(p)
  }
})
const isHtmlFile = computed(() => {
  const f = editingFile.value.toLowerCase()
  return f.endsWith('.html') || f.endsWith('.htm')
})

// ===== AI 活动流（P1-1）：监听 appStore（聊天 SSE 持续写入），实时显示 AI 文件操作 =====
interface AiActivity { path: string; action: string; ts: number }
const aiActivities = ref<AiActivity[]>([])
function syncAiActivities() {
  const acts: AiActivity[] = []
  if (appStore.previewPath) acts.push({ path: appStore.previewPath, action: '写', ts: appStore.previewTs })
  for (const c of appStore.fileChanges.slice(-4)) {
    acts.push({ path: c.path, action: c.oldContent ? '修改' : '创建', ts: c.ts })
  }
  aiActivities.value = acts.slice(-5)
}
// 进入工作区时初始化（AI 可能已写完 → 显示历史活动）；运行中增量更新
watch(
  () => [appStore.previewTs, appStore.fileChanges.length],
  () => {
    syncAiActivities()
    // 自动刷新当前目录文件树（AI 干活时目录内容在变）
    if (ws?.readyState === WebSocket.OPEN && currentDir.value) {
      listFiles(currentDir.value)
    }
  },
)
onMounted(() => {
  syncAiActivities()
})
function timeAgo(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s} 秒前`
  return `${Math.round(s / 60)} 分前`
}
function openAiActivity(a: AiActivity) {
  // 工作区目录内匹配则直接打开，否则切到对应目录
  const name = a.path.split('/').pop() || ''
  if (currentDir.value && name && files.value.some((f) => f.name === name)) {
    openFile(a.path)
  }
}

let ws: WebSocket | null = null
let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let editor: monaco.editor.IStandaloneCodeEditor | null = null

const WS_URL = `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}/ws/terminal`

// WebSocket connection
function connectWS() {
  ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    console.log('[workspace] WS connected')
    // 目录等 connected 消息（服务器下发真实 cwd）后再列，避免用初始 '/' 列错目录
  }

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    switch (msg.type) {
      case 'connected':
        workspaceRoot.value = msg.cwd
        currentDir.value = msg.cwd
        listFiles(msg.cwd)
        wsSend('git_status')
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
        // 若是某个已展开目录的懒加载 → 更新该节点 children；否则刷新根列表
        const expandedParent = findExpandedParent(msg.path)
        if (expandedParent) {
          expandedParent.children = msg.files
        } else {
          files.value = msg.files
        }
        break
      case 'git_status':
        gitBranch.value = msg.branch || ''
        gitDirty.value = new Set(msg.modified || [])
        break
      case 'file_created':
      case 'dir_created':
      case 'file_deleted':
      case 'file_renamed':
        // CRUD 后刷新当前目录（或父目录）
        listFiles(currentDir.value)
        wsSend('git_status')
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

  term.writeln('SUPERCRZY BOT Terminal')
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

/** 在根列表中查找已展开目录节点（懒加载子目录的落点） */
function findExpandedParent(path: string): DirNode | null {
  const search = (nodes: DirNode[]): DirNode | null => {
    for (const n of nodes) {
      if (n.isDirectory && n.path === path) return n
      if (n.children?.length) {
        const hit = search(n.children)
        if (hit) return hit
      }
    }
    return null
  }
  return search(files.value as DirNode[])
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
  editingFile.value = path
  previewMode.value = false
  if (ws?.readyState === WebSocket.OPEN) {
    if (isBinaryLike(path)) {
      // 二进制类（图片/pdf/视频/音频/docx/xlsx/pptx）：不读文本，走 /api/workspace/file 二进制流或专用渲染
      fileContent.value = null
      return
    }
    ws.send(JSON.stringify({ type: 'read_file', path }))
  }
}

/** 二进制类文件判断（不进入文本编辑器） */
function isBinaryLike(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|ico|pdf|mp4|webm|mov|mkv|avi|mp3|wav|ogg|m4a|flac|aac|docx|xlsx|pptx)$/i.test(p)
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
.workspace { display: flex; height: 100%; background: var(--bg-primary); }

/* File Panel */
.file-panel { border-right: 1px solid var(--border-color); display: flex; flex-direction: column; background: var(--bg-secondary); min-width: 160px; position: relative; }
.panel-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--border-color); font-size: 12px; font-weight: 600; color: var(--text-secondary); flex-shrink: 0; }
.panel-actions { display: flex; gap: 2px; }
.file-tree { flex: 1; overflow-y: auto; padding: 4px 0; }
.file-item { display: flex; align-items: center; gap: 6px; padding: 5px 12px; cursor: pointer; font-size: 13px; color: var(--text-primary); transition: background .1s; }
.file-item:hover { background: var(--bg-primary); }
.file-icon { font-size: 14px; flex-shrink: 0; }
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.file-size { font-size: 11px; color: var(--text-muted); }
.file-breadcrumb { padding: 6px 12px; border-top: 1px solid var(--border-color); font-size: 11px; color: var(--text-muted); flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.bread-path { font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bread-actions { display: inline-flex; gap: 2px; flex-shrink: 0; }
.bread-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 4px;
  background: transparent; border: none; color: var(--text-muted); cursor: pointer;
}
.bread-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.empty-hint { margin-top: 40px; transform: scale(0.7); }

/* Git 分支徽标（P3） */
.git-bar {
  display: flex; align-items: center; gap: 5px;
  margin: 4px 8px 6px; padding: 4px 8px;
  border: 1px solid var(--border-color); border-radius: 6px;
  font-size: 11px; color: var(--text-secondary); background: var(--bg-tertiary);
}
.git-branch { font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 右键菜单（文件 CRUD） */
.ctx-menu {
  position: absolute; z-index: 100;
  min-width: 120px; padding: 4px;
  background: var(--bg-secondary); border: 1px solid var(--border-color);
  border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.15);
  font-size: 12px;
}
.ctx-item {
  padding: 6px 10px; border-radius: 5px; cursor: pointer;
  color: var(--text-primary); white-space: nowrap;
}
.ctx-item:hover { background: var(--bg-hover); }
.ctx-item.danger { color: #ef4444; }

/* 图片预览（P2） */
.img-preview {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 16px; overflow: auto;
}
.img-preview img { max-width: 100%; max-height: calc(100% - 30px); object-fit: contain; border-radius: 6px; }
.img-path { font-size: 11px; color: var(--text-muted); font-family: monospace; }

/* Markdown 预览（P2） */
.md-preview {
  flex: 1; overflow: auto; padding: 16px 20px;
  font-size: 13px; line-height: 1.7; color: var(--text-primary);
}
.md-preview h1, .md-preview h2, .md-preview h3 { margin: 14px 0 8px; font-weight: 600; }
.md-preview h1 { font-size: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 6px; }
.md-preview h2 { font-size: 17px; }
.md-preview h3 { font-size: 15px; }

/* 扩展预览（P0）：pdf/视频/音频/docx/xlsx/pptx */
.file-preview {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.pdf-preview {
  width: 100%;
  height: 100%;
  border: none;
  background: var(--bg-tertiary);
}
.media-preview {
  max-width: 100%;
  max-height: 100%;
  margin: auto;
  display: block;
}
.audio-preview {
  width: 100%;
  margin: auto;
  padding: 16px;
}
.docx-preview {
  background: #fff;
  padding: 20px;
}
.docx-preview .docx-wrapper {
  background: #fff;
  color: #1a1a1a;
}
.docx-preview table {
  border-collapse: collapse;
}
.docx-preview td, .docx-preview th {
  border: 1px solid #ccc;
  padding: 4px 8px;
}
.xlsx-preview {
  padding: 16px;
}
.xlsx-preview table {
  border-collapse: collapse;
  font-size: 12px;
}
.xlsx-preview td, .xlsx-preview th {
  border: 1px solid var(--border-color);
  padding: 4px 10px;
  white-space: nowrap;
}
.xlsx-preview th {
  background: var(--bg-secondary);
  font-weight: 600;
}
.pptx-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-muted);
  font-size: 13px;
}
.pptx-placeholder a {
  color: var(--accent);
  text-decoration: none;
  border: 1px solid var(--accent);
  padding: 6px 16px;
  border-radius: 8px;
}
.md-preview p { margin: 8px 0; }
.md-preview code {
  background: var(--bg-tertiary); padding: 2px 5px; border-radius: 4px;
  font-family: var(--font-mono); font-size: 12px;
}
.md-preview pre {
  background: var(--bg-tertiary); padding: 10px 12px; border-radius: 8px;
  overflow-x: auto; margin: 10px 0;
}
.md-preview pre code { background: none; padding: 0; }
.md-preview ul, .md-preview ol { padding-left: 20px; margin: 8px 0; }
.md-preview li { margin: 3px 0; }
.md-preview blockquote {
  border-left: 3px solid var(--border-color); padding-left: 12px; margin: 10px 0;
  color: var(--text-muted);
}
.md-preview table { border-collapse: collapse; margin: 10px 0; }
.md-preview th, .md-preview td { border: 1px solid var(--border-color); padding: 5px 10px; }
.md-preview a { color: var(--accent); }

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

/* AI 活动流横幅 */
.ai-activity {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 5px 12px;
  background: var(--bg-secondary, #f7f7f8);
  border-bottom: 1px solid var(--border, #e3e3e6);
  font-size: 11px;
  overflow-x: auto;
  white-space: nowrap;
  flex-shrink: 0;
}
.ai-activity-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 500;
  color: var(--accent, #4f7cff);
}
.ai-pulse {
  width: 7px;
  height: 7px;
  border-radius: 4px;
  background: var(--accent, #4f7cff);
  animation: ai-pulse 1.2s infinite;
}
@keyframes ai-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .25; }
}
.ai-activity-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.ai-activity-item:hover { background: var(--border, #e3e3e6); }
.ai-action { color: var(--text-muted, #888); }
.ai-file { font-weight: 500; color: var(--text-primary, #222); }
.ai-time { color: var(--text-muted, #aaa); font-size: 10px; }
.editor-area { flex: 1; overflow: hidden; }
.save-indicator { font-size: 11px; padding: 2px 8px; border-radius: 4px; color: var(--text-muted); }
.save-indicator.saved { color: #50fa7b; }
.editor-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-muted); gap: 8px; }
.editor-empty p { margin: 0; font-size: 13px; }
.editor-empty .hint { font-size: 12px; }
.panel-status { font-size: 11px; color: var(--text-muted); font-family: monospace; }
</style>
