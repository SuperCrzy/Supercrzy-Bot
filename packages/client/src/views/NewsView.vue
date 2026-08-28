<template>
  <div class="news-view">
    <div class="nv-header">
      <div class="nv-title-row">
        <h2 class="nv-title">{{ $t('news.title') }}</h2>
        <span class="nv-subtitle">{{ $t('news.subtitle') }}</span>
      </div>
      <div class="nv-toolbar">
        <!-- 分类筛选 -->
        <div class="nv-cats">
          <button
            v-for="c in categories"
            :key="c"
            class="nv-cat"
            :class="{ active: activeCat === c }"
            @click="activeCat = c; loadNews()"
          >{{ c === 'all' ? $t('news.all') : c }}</button>
        </div>
        <!-- 搜索 -->
        <input
          v-model="query"
          class="nv-search"
          :placeholder="$t('news.searchPlaceholder')"
          @keydown.enter="loadNews()"
        />
        <button class="nv-refresh" :title="$t('news.refresh')" :disabled="loading" @click="loadNews">↻</button>
      </div>
    </div>

    <!-- 加载/空态 -->
    <div v-if="loading" class="nv-state">{{ $t('news.loading') }}</div>
    <div v-else-if="news.length === 0" class="nv-state">{{ $t('news.empty') }}</div>

    <!-- 新闻列表 -->
    <div v-else class="nv-list">
      <div v-for="it in news" :key="it.url" class="nv-item">
        <div class="nv-item-body">
          <div class="nv-item-top">
            <span class="nv-cat-tag">{{ it.category }}</span>
            <span class="nv-date">{{ fmtDate(it.date) }}</span>
          </div>
          <a class="nv-item-title" :href="it.url" target="_blank" rel="noopener">{{ it.title }}</a>
          <p class="nv-item-summary">{{ it.summary }}</p>
          <div class="nv-item-actions">
            <a class="nv-open" :href="it.url" target="_blank" rel="noopener">{{ $t('news.open') }} →</a>
            <button class="nv-research" @click="deepResearch(it)">{{ $t('news.deepResearch') }}</button>
          </div>
        </div>
        <!-- 封面图放在标题右边（卡片右侧，2026-08-28 改） -->
        <a v-if="imgSrc(it.image)" class="nv-thumb" :href="it.url" target="_blank" rel="noopener">
          <img :src="imgSrc(it.image)" :alt="it.title" loading="lazy" />
        </a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

// 新闻看板（2026-08-28 加，阶段二）：读 supercrzy.com 实时 AI 新闻，每条可"一键深入研究"
const { t } = useI18n({ useScope: 'global' })
const router = useRouter()

interface NewsItem { title: string; url: string; summary: string; date: string; category: string; image?: string }

const news = ref<NewsItem[]>([])
const categories = ref<string[]>(['all', 'Models', 'Business', 'Hardware', 'Agents', 'Open Source', 'Research'])
const activeCat = ref('all')
const query = ref('')
const loading = ref(false)

function fmtDate(d: string): string {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return ''
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime()
  const diff = Math.round((today - day) / 86400000)
  if (diff === 0) return t('news.today')
  if (diff === 1) return t('news.yesterday')
  return dt.toLocaleDateString(locale(), { month: 'short', day: 'numeric' })
}
function locale(): string { return (localStorage.getItem('supercrzy:lang') || 'zh-CN') }

/** 封面图走后端代理加载（规避浏览器直连 supercrzy.com 的跨域/网络问题，2026-08-28 加） */
function imgSrc(url: string | undefined): string {
  if (!url) return ''
  return `/api/news/image?url=${encodeURIComponent(url)}`
}

async function loadNews() {
  loading.value = true
  try {
    const p = new URLSearchParams()
    if (activeCat.value !== 'all') p.set('category', activeCat.value)
    if (query.value.trim()) p.set('query', query.value.trim())
    p.set('limit', '20')
    const r = await fetch(`/api/news?${p.toString()}`)
    const data = await r.json()
    news.value = data.items || []
  } catch {
    news.value = []
  } finally {
    loading.value = false
  }
}

/** 一键深入研究：跳到聊天页并预填 prompt 触发 deep_research */
function deepResearch(it: NewsItem) {
  const query = `深度研究这条新闻并给出判断：${it.title}\n来源：${it.url}\n请用深度研究能力交叉全网信息，分析这件事的来龙去脉、影响和相关方，输出带来源的完整报告。`
  // 通过 query 参数传递研究 prompt，ChatView 读取后预填并发送
  router.push({ path: '/', query: { research: query } })
}

onMounted(loadNews)
</script>

<style scoped>
.news-view {
  padding: 24px;
  max-width: 880px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.nv-header { margin-bottom: 20px; }
.nv-title-row { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
.nv-title { font-size: 20px; font-weight: 600; margin: 0; color: var(--text-primary); }
.nv-subtitle { font-size: 13px; color: var(--text-secondary); }
.nv-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.nv-cats { display: flex; gap: 6px; flex-wrap: wrap; }
.nv-cat {
  font-size: 12px; padding: 4px 10px; border-radius: 14px;
  border: 1px solid var(--border-color); background: transparent;
  color: var(--text-secondary); cursor: pointer;
}
.nv-cat.active { background: var(--accent, #6366f1); color: #fff; border-color: transparent; }
.nv-search {
  font-size: 13px; padding: 5px 10px; border-radius: 8px;
  border: 1px solid var(--border-color); background: var(--bg-primary, transparent);
  color: var(--text-primary); flex: 1; min-width: 160px;
}
.nv-refresh { border: 1px solid var(--border-color); background: transparent; border-radius: 8px; padding: 4px 10px; cursor: pointer; color: var(--text-secondary); }
.nv-state { padding: 40px; text-align: center; color: var(--text-secondary); font-size: 14px; }
.nv-list { display: flex; flex-direction: column; gap: 12px; }
.nv-item {
  border: 1px solid var(--border-color, rgba(128,128,128,0.25));
  border-radius: 12px; padding: 14px 16px;
  background: var(--bg-secondary, rgba(128,128,128,0.03));
  display: flex; gap: 14px;
}
/* 封面图（2026-08-28 加） */
.nv-thumb { flex-shrink: 0; width: 120px; height: 76px; border-radius: 8px; overflow: hidden; display: block; }
.nv-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.nv-item-body { flex: 1; min-width: 0; }
.nv-item-top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.nv-cat-tag { font-size: 11px; padding: 1px 8px; border-radius: 10px; background: rgba(99,102,241,0.12); color: var(--accent, #6366f1); }
.nv-date { font-size: 11px; color: var(--text-tertiary, #68738d); margin-left: auto; }
.nv-item-title { font-size: 15px; font-weight: 600; color: var(--text-primary); text-decoration: none; display: block; line-height: 1.4; }
.nv-item-title:hover { color: var(--accent, #6366f1); }
.nv-item-summary { font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin: 6px 0 10px; }
.nv-item-actions { display: flex; align-items: center; gap: 12px; }
.nv-open { font-size: 12px; color: var(--accent, #6366f1); text-decoration: none; }
.nv-research {
  font-size: 12px; padding: 4px 12px; border-radius: 8px;
  border: 1px solid var(--accent, rgba(99,102,241,0.4)); background: rgba(99,102,241,0.08);
  color: var(--accent, #6366f1); cursor: pointer;
}
.nv-research:hover { background: rgba(99,102,241,0.15); }
</style>
