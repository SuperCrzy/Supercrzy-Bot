<template>
  <div class="docx-preview">
    <div v-if="error" class="dp-msg dp-err">{{ error }}</div>
    <div v-else-if="loading" class="dp-msg">{{ $t('preview.docxLoading') }}</div>
    <!-- docx-preview 把页面渲染进这个容器；styles 也注入到这里（styleContainer = 本容器），
         而不是 document.head —— 否则它会往 App 全局塞一套 .docx* 样式。 -->
    <div ref="host" class="dp-host" />
    <div v-if="truncatedHint" class="dp-msg">{{ truncatedHint }}</div>
  </div>
</template>

<script setup lang="ts">
/**
 * Word（.docx）预览 —— 右栏 preview tab 用。
 *
 * 为什么是**前端渲染**而不是后端转 HTML：docx-preview 是纯解析器（unzip + 画 DOM），
 * 不需要跑 Office/soffice 进程；后端只需按白名单把原始字节直出（`/api/filesystem/raw`）。
 *
 * 三个必须处理的现实问题：
 *   ① **画幅**：docx 页面是固定 px 宽（A4@96dpi ≈ 816px），右栏只有 ~420px ⇒ 必然横向溢出。
 *      这里渲染完量一次页面宽度，用 `zoom` 缩到容器宽度（`zoom` 会影响布局尺寸，
 *      所以滚动条/高度自然正确；`transform: scale` 不改布局尺寸，反而要手工补高度）。
 *   ② **样式隔离**：`styleContainer` 传本容器，别传 `undefined`（= document.head 全局污染）。
 *   ③ **竞态**：右栏可以连着点两个 docx，旧的渲染 promise 后完成会把新内容盖掉 ⇒ 用序号作废。
 *
 * 安全：渲染对象是本机/工作区内的文件（服务端已过 `assertSafeFilePath` 白名单），
 * 不是远程不可信内容；docx-preview 自己解析 OOXML 建 DOM，不走 `innerHTML` 直出文档 XML。
 */
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderAsync } from 'docx-preview'

const { t } = useI18n({ useScope: 'global' })

const props = defineProps<{
  /** `/api/filesystem/raw?path=…` 地址 */
  url: string
}>()

const host = ref<HTMLElement | null>(null)
const loading = ref(false)
const error = ref('')
const truncatedHint = ref('')

/** 每次加载自增；异步回来后若已不是最新一次，直接丢弃（见注释③） */
let seq = 0
let ro: ResizeObserver | null = null

/** 把 A4 固定宽度缩到容器宽度；只在需要缩小时生效，不放大（放大反而糊） */
function fit() {
  const el = host.value
  if (!el) return
  const page = el.querySelector('.docx-wrapper > section, section.docx') as HTMLElement | null
  const pageW = page?.offsetWidth || 0
  const availW = el.clientWidth
  if (!pageW || !availW) return
  const z = Math.min(1, Math.max(0.35, (availW - 12) / pageW))
  el.style.setProperty('--dp-zoom', z.toFixed(3))
}

async function load() {
  const my = ++seq
  error.value = ''
  truncatedHint.value = ''
  if (!props.url) return
  loading.value = true
  try {
    const r = await fetch(props.url)
    if (!r.ok) {
      // 后端对非白名单类型回 415、超限回 413 —— 原样报出来，别猜
      throw new Error(`HTTP ${r.status}`)
    }
    const buf = await r.arrayBuffer()
    if (my !== seq) return
    await nextTick()
    const el = host.value
    if (!el) return
    el.innerHTML = ''
    await renderAsync(buf, el, el, {
      className: 'docx',
      inWrapper: true,        // 生成 .docx-wrapper 分页容器
      breakPages: true,       // 按分页符切开，视觉上像文档
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      useBase64URL: true,     // 内嵌图片转 dataURL，避免相对路径 404
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
    })
    if (my !== seq) return
    fit()
    if (!ro) {
      ro = new ResizeObserver(() => fit())
      if (host.value) ro.observe(host.value)
    }
  } catch (e: any) {
    if (my !== seq) return
    const msg = String(e?.message || e)
    // 密码保护/损坏的 docx 会抛各种解析错 —— 统一给一条可行动的提示
    error.value = msg.includes('HTTP ')
      ? `${t('preview.docxFailed')} (${msg})`
      : t('preview.docxFailed')
  } finally {
    if (my === seq) loading.value = false
  }
}

watch(() => props.url, () => { load() }, { immediate: true })

onBeforeUnmount(() => {
  seq++          // 作废进行中的渲染
  ro?.disconnect()
  ro = null
})
</script>

<style scoped>
.docx-preview {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.dp-msg {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.dp-err {
  color: var(--error, #e5484d);
  white-space: pre-wrap;
  word-break: break-word;
}
.dp-host {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  background: var(--bg-primary);
  padding: 6px 0;
}
/* 只改观感，不动 docx-preview 的排版：
   - 去阴影（面板里叠阴影显脏）
   - 页面宽度按 --dp-zoom 缩放（见 fit()） */
.dp-host :deep(.docx-wrapper) {
  background: transparent;
  padding: 0 6px;
}
.dp-host :deep(.docx-wrapper > section.docx) {
  box-shadow: none;
  margin-bottom: 8px;
  zoom: var(--dp-zoom, 1);
}
.dp-host :deep(.docx) {
  color: #1a1a1a;
  background: #fff;
}
</style>
