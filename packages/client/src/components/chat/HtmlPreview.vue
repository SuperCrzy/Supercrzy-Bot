<template>
  <div class="html-preview" :class="{ 'is-updating': updating }">
    <!-- 头部：文件名 + 行数 + 更新状态 + 刷新/打开 -->
    <div v-if="showHeader" class="hp-header">
      <span class="hp-name" :title="path">{{ fileName }}</span>
      <span class="hp-lines">{{ lineCount }} {{ $t('preview.lines') }}</span>
      <span v-if="updating" class="hp-updating">
        <span class="hp-dot" /> {{ $t('preview.updating') }}
      </span>
      <span v-else-if="loaded" class="hp-loaded">{{ $t('preview.live') }}</span>
      <div class="hp-actions">
        <button class="hp-btn" :title="$t('preview.refresh')" @click="reload">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
        </button>
        <button class="hp-btn" :title="$t('preview.openInTab')" @click="openInTab">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
      </div>
    </div>
    <!-- iframe 沙箱渲染 -->
    <iframe
      v-if="srcdocContent"
      :srcdoc="srcdocContent"
      class="hp-iframe"
      sandbox="allow-scripts"
      :key="iframeKey"
    />
    <div v-else class="hp-empty">
      {{ $t('preview.empty') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n({ useScope: 'global' })

// ---- props ----
const props = defineProps<{
  content?: string       // 实时预览内容（SSE preview_update）
  path?: string          // 文件名（显示用）
  showHeader?: boolean   // 是否显示头部（DetailPanel 显示 / 工作区可选）
}>()

const updating = ref(false)
const loaded = ref(false)
const iframeKey = ref(0)

const fileName = computed(() => {
  const p = props.path || ''
  return p.split(/[\\/]/).pop() || p
})
const lineCount = computed(() => (props.content || '').split('\n').length)
/**
 * 🔴 2026-10-20 修老板报「预览里点『开始游戏』没反应，是不是没有内核」。
 *
 * **不是没有内核**——iframe 本身是完整的浏览器渲染引擎。真因是沙箱与 Web Storage 的冲突：
 * iframe 用 `sandbox="allow-scripts"`，但刻意**不给** `allow-same-origin`（预览的是 AI 生成的
 * 不可信 HTML；两个 flag 同时给等于沙箱失效，它能读父页面的 localStorage）。
 * 代价是 iframe 变成 opaque origin ⇒ **读 `localStorage` 直接抛 SecurityError**。
 *
 * 真机实测现场（CDP 进 iframe 的 execution context 抓到）：
 *   `Uncaught SecurityError: ... The document is sandboxed and lacks the 'allow-same-origin' flag`
 *   at about:srcdoc:435 —— 该版本 snake.html 在**顶层**无条件读 localStorage 且没有 try/catch，
 *   一行异常把整个 IIFE 打断 ⇒ 事件监听器一个都没绑上 ⇒ 点按钮无反应。
 *   判据：点击前后 `canvas.toDataURL()` 哈希完全一致、overlay 的 display 一直是 flex。
 * AI 生成的网页几乎都会用 localStorage 存最高分/进度，所以这不是个例。
 *
 * 修法：在内容最前面注入一段**内存版存储垫片**，沙箱隔离保持不变（不放开 allow-same-origin）。
 * 只在真的抛错时才覆盖；存储能用的场景（如 blob 打开的标签页）原样不动。
 */
const STORAGE_SHIM = '<script data-scz="storage-shim">(function(){try{void window.localStorage;return}catch(e){}var mem={};var api={getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:null},setItem:function(k,v){mem[String(k)]=String(v)},removeItem:function(k){delete mem[String(k)]},clear:function(){mem={}},key:function(i){return Object.keys(mem)[i]||null}};try{Object.defineProperty(api,"length",{get:function(){return Object.keys(mem).length}})}catch(e){}["localStorage","sessionStorage"].forEach(function(n){try{Object.defineProperty(window,n,{configurable:true,value:api})}catch(e){}})})()<\/script>'

const srcdocContent = computed(() => {
  const raw = props.content || ''
  if (!raw) return ''
  if (raw.includes('data-scz="storage-shim"')) return raw
  // 插在 <head> 之后 —— 必须早于页面自己的脚本；没有 head 就放最前面。
  const m = /<head[^>]*>/i.exec(raw)
  if (m) {
    const at = m.index + m[0].length
    return raw.slice(0, at) + STORAGE_SHIM + raw.slice(at)
  }
  return STORAGE_SHIM + raw
})

// 内容更新 → 显示"更新中"标记 + 刷新 iframe（防抖由调用方控制，这里只负责渲染）
watch(() => props.content, (v, old) => {
  if (v && v !== old) {
    updating.value = true
    loaded.value = true
    iframeKey.value++  // key 变化强制 iframe 重建
    // 短暂展示更新标记后隐藏
    clearTimeout((watch as any)._t)
    ;(watch as any)._t = setTimeout(() => { updating.value = false }, 1200)
  }
})

function reload() {
  iframeKey.value++
}
function openInTab() {
  if (props.content) {
    const blob = new Blob([props.content], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
}
</script>

<style scoped>
.html-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  position: relative;
}

/* 🔴 2026-10-20 手机端：预览 iframe 之前是"扁"的。
   `.html-preview` 只有 height:100%，在 flex 布局里仍是 flex item 的默认尺寸
   （flex-shrink:1 会被同排其它内容挤压）。显式给 flex:1 + min-height:0，
   配合 DetailPanel 里 `.tab-content.preview-tab` 的撑满，iframe 才真正拿到高度。
   桌面端高度本就够、且改前已验证正常，故只在移动端断点内生效。 */
@media (max-width: 768px) {
  .html-preview {
    flex: 1 1 auto;
    min-height: 0;
  }
}
.hp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, #e3e3e6);
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.hp-name {
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}
.hp-lines { font-size: 10px; color: var(--text-muted); }
.hp-updating {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent, #4f7cff);
}
.hp-dot {
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: var(--accent, #4f7cff);
  animation: hp-pulse 1s infinite;
}
@keyframes hp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .3; }
}
.hp-loaded { color: var(--success, #4caf50); }
.hp-actions { margin-left: auto; display: flex; gap: 2px; }
.hp-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 3px;
  display: flex;
  border-radius: 4px;
}
.hp-btn:hover { background: var(--border-color, #e3e3e6); color: var(--text-primary); }
.hp-iframe {
  flex: 1;
  border: none;
  width: 100%;
  min-height: 0;
  background: #fff;
}
.hp-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
