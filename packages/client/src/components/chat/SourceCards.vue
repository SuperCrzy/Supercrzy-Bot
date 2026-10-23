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

const props = defineProps<{
  text: string
}>()

interface SourceLink {
  text: string
  url: string
}

/** 提取来源链接（2026-08-25 增强）：①所有 [文字](url) markdown 链接（模型常用"[新浪财经1](url)"自由格式，
 *  原正则只认"来源/出处/参考"标注导致漏提取、链接裸在正文）②显式"来源/出处/参考/source"标注 ③裸 http 链接。
 *  统一按 url 去重（同 url 保留第一个文字标签） */
const links = computed<SourceLink[]>(() => {
  const t = props.text || ''
  const out: SourceLink[] = []
  const seen = new Set<string>()

  // 1) 所有 [文字](url) markdown 链接（text=链接文字；url 去重）
  const mdLink = /\[([^\]]{1,60})\]\(\s*(https?:\/\/[^)\s]+)\s*\)/g
  let m: RegExpExecArray | null
  while ((m = mdLink.exec(t)) !== null) {
    const url = m[2]
    if (!seen.has(url)) { seen.add(url); out.push({ text: m[1] || url, url }) }
  }

  // 2) 补充裸 http 链接（模型可能直接写 URL，无 markdown 链接包裹）
  const bare = /https?:\/\/[^\s)\]>,，。！？;；]+/g
  while ((m = bare.exec(t)) !== null) {
    const url = m[0].replace(/[)）】]$/, '')
    if (!seen.has(url)) { seen.add(url); out.push({ text: url, url }) }
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
