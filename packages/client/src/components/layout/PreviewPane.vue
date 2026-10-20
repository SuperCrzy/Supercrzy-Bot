<template>
  <!-- docx：二进制，交给专用渲染器（拉 raw 字节） -->
  <DocxPreview v-if="kind === 'docx'" :url="docUrl" class="pp-fill" />

  <!-- markdown：复用 .message-content 的全局排版（AI 正文样式唯一来源），不另造一套 -->
  <div v-else-if="kind === 'markdown'" class="pp-pane">
    <div class="pp-header" :title="path">{{ displayName }}</div>
    <div class="pp-scroll">
      <div class="message-content pp-md" v-html="renderMarkdown(text)"></div>
    </div>
  </div>

  <!-- 纯文本：等宽 + 保留换行（原来这个分支是**死代码**，见文件头注释） -->
  <div v-else-if="kind === 'text'" class="pp-pane">
    <div class="pp-header" :title="path">{{ displayName }}</div>
    <pre class="pp-code"><code>{{ text }}</code></pre>
  </div>

  <!-- 类型未知 = AI 实时预览 / .html 文件：沿用 iframe 沙箱渲染（含 storage 垫片） -->
  <HtmlPreview v-else-if="html" :content="html" :path="path" show-header />

  <!-- SVG 文件：内容是文本但要看图。走 iframe 而不是 v-html：
       既不放开 App 源（脚本关在 opaque origin 里），又保住了「点 .svg 看到图」的原有体验。 -->
  <HtmlPreview v-else-if="kind === 'svg'" :content="text" :path="path" show-header />

  <div v-else class="pp-empty">
    <n-empty :description="$t('detail.selectToPreview')" />
  </div>
</template>

<script setup lang="ts">
/**
 * 右栏 preview tab 的内容渲染器（2026-10-20 从 DetailPanel 抽出）。
 *
 * ## 为什么抽出来
 *
 * 两件事同时发生：DetailPanel 已经 956 行、体量闸门上限 1000（`__tests__/file-size-guard.test.ts`），
 * 而"按类型选渲染器"本来就是一整块独立逻辑 —— 塞回去只会让下一个人继续往巨石里加行。
 *
 * ## 修掉的 bug：`<pre class="preview-code">` 曾是死代码
 *
 * 旧版分支顺序是 `previewImage → empty → HtmlPreview(livePreviewContent) → pre(previewContent)`，
 * 而 `livePreviewContent` 由 `appStore.previewTs` 的 watcher 写入（**对所有文本文件都会写**），
 * 所以 `pre` 分支永远轮不到：`.md`/`.txt` 全被 `HtmlPreview` 当 HTML 塞进 iframe，
 * HTML 里换行会被折叠成空格 ⇒ 多行文本塌成一大段，`#`、`-` 原样露出。
 * 现在按 `kind` 显式分流：只有"类型未知"（AI 实时预览 / html 文件）才走 iframe。
 *
 * ## markdown 的安全边界
 *
 * `html: false`（markdown-it 会把裸 HTML 转义），因此 `v-html` 的输入是本组件自己生成的
 * 受控 HTML —— 与仓库里另外 4 个 MarkdownIt 实例同一口径，也满足
 * `__tests__/v-html-guard.test.ts` 的豁免条件（该文件已登记本组件）。
 */
import { computed } from 'vue'
import { NEmpty } from 'naive-ui'
import MarkdownIt from 'markdown-it'
import HtmlPreview from '@/components/chat/HtmlPreview.vue'
import DocxPreview from '@/components/layout/DocxPreview.vue'

const props = defineProps<{
  /** 渲染类型，唯一来源 = 后端 `/api/filesystem/read` 的 kind；`''` = 未知（当 HTML） */
  kind: '' | 'text' | 'markdown' | 'docx' | 'svg'
  /** 文本内容（text / markdown 用） */
  text: string
  /** 展示用路径（取 basename 当标题） */
  path: string
  /** HTML 内容（AI 实时预览或 .html 文件） */
  html: string
  /** docx 原始字节地址 */
  docUrl: string
}>()

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
// 链接一律新窗口：右栏里点站内链接会把 SPA 导航走掉，预览面板连带消失
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return self.renderToken(tokens, idx, options)
}
function renderMarkdown(src: string): string {
  return md.render(src || '')
}

const displayName = computed(() => {
  const p = props.path || ''
  return p.split(/[\\/]/).pop() || p
})
</script>

<style scoped>
.pp-fill {
  flex: 1 1 auto;
  min-height: 0;
}
.pp-pane {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  gap: 6px;
}
.pp-header {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
.pp-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 2px 2px 12px;
}
/* 等宽纯文本：换行保留、超长行横滚（不折行破坏对齐） */
.pp-code {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
  overflow: auto;
  padding: 8px;
  background: var(--bg-primary);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
}
/* markdown 排版来自 .message-content（全局），这里只补面板内的边距与可读性 */
.pp-md {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-primary);
}
.pp-md :deep(h1), .pp-md :deep(h2), .pp-md :deep(h3) {
  margin: 12px 0 6px;
  line-height: 1.35;
}
.pp-md :deep(h1) { font-size: 17px; }
.pp-md :deep(h2) { font-size: 15px; }
.pp-md :deep(h3) { font-size: 13.5px; }
.pp-md :deep(p) { margin: 6px 0; }
.pp-md :deep(ul), .pp-md :deep(ol) { margin: 6px 0; padding-left: 20px; }
.pp-md :deep(li) { margin: 2px 0; }
.pp-md :deep(blockquote) {
  margin: 8px 0;
  padding: 2px 10px;
  border-left: 2px solid var(--border-color);
  color: var(--text-secondary);
}
.pp-md :deep(code) {
  font-family: var(--font-mono);
  font-size: 11.5px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-primary);
}
.pp-md :deep(pre) {
  margin: 8px 0;
  padding: 8px;
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  overflow-x: auto;
}
.pp-md :deep(pre code) { padding: 0; background: transparent; }
.pp-md :deep(table) { border-collapse: collapse; margin: 8px 0; font-size: 11.5px; }
.pp-md :deep(th), .pp-md :deep(td) { border: 1px solid var(--border-color); padding: 4px 8px; }
.pp-md :deep(hr) { border: none; border-top: 1px solid var(--border-color); margin: 12px 0; }
.pp-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* 手机端：与 DetailPanel / HtmlPreview 同一套 flex 撑满口径（2026-10-20 已真机验过） */
@media (max-width: 768px) {
  .pp-pane, .pp-fill { flex: 1 1 auto; min-height: 0; }
}
</style>
