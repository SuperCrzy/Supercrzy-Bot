<template>
  <div v-if="links.length > 0" class="source-cards">
    <div class="source-title">{{ $t('chatui.sources') }}</div>
    <div class="source-list">
      <a
        v-for="(l, i) in links"
        :key="i"
        class="source-card"
        :href="l.url"
        target="_blank"
        rel="noopener noreferrer"
        :title="l.url"
      >
        <span class="source-idx">{{ i + 1 }}</span>
        <span class="source-domain">{{ domain(l.url) }}</span>
        <span class="source-text">{{ l.text || l.url }}</span>
      </a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'

const props = defineProps<{
  text: string
}>()

interface SourceLink {
  text: string
  url: string
}

const markdown = new MarkdownIt({ html: false, linkify: true })
/** Links are extracted from rendered prose, never code blocks or inline code. */
const links = computed<SourceLink[]>(() => {
  const out: SourceLink[] = []
  const seen = new Set<string>()
  for (const block of markdown.parse(props.text || '', {})) {
    if (block.type !== 'inline' || !block.children) continue
    let url = ''
    let label = ''
    for (const token of block.children) {
      if (token.type === 'link_open') { url = token.attrGet('href') || ''; label = '' }
      else if (token.type === 'link_close') {
        if (/^https?:\/\//i.test(url) && !seen.has(url)) { seen.add(url); out.push({ text: label || url, url }) }
        url = ''
      } else if (url && (token.type === 'text' || token.type === 'code_inline')) label += token.content
    }
  }
  return out.slice(0, 12)
})

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 30)
  }
}
</script>

<style scoped>
.source-cards {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}
.source-title {
  font-size: 11px;
  color: var(--text-muted, #888);
  margin-bottom: 6px;
  letter-spacing: 0.02em;
}
.source-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.source-card {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  padding: 3px 10px 3px 4px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-secondary, #bbb);
  text-decoration: none;
  transition: border-color 0.15s, background 0.15s;
  overflow: hidden;
}
.source-card:hover {
  border-color: var(--accent, #f59e0b);
  background: var(--accent-subtle);
}
.source-idx {
  flex: none;
  min-width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent, #f59e0b);
  color: #fff;
  font-size: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.source-domain {
  flex: none;
  font-weight: 500;
  color: var(--text-primary);
}
.source-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
