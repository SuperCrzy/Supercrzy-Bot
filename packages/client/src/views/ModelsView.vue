<template>
  <div class="page-container">
    <header class="page-header">
      <h2>模型管理</h2>
      <p class="page-desc">浏览所有 DeepSeek 模型，按系列分组。⭐ 标记为推荐模型。</p>
      <div class="header-actions">
        <n-input
          v-model:value="searchQuery"
          placeholder="搜索模型..."
          clearable
          size="small"
          class="search-input"
        >
          <template #prefix>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </template>
        </n-input>
        <n-select
          v-model:value="filterSeries"
          :options="seriesFilterOpts"
          placeholder="全部系列"
          size="small"
          clearable
          style="width: 140px"
        />
      </div>
    </header>

    <div class="models-content" v-for="series in filteredSeries" :key="series.id">
      <div class="series-header">
        <span class="series-emoji">{{ series.emoji }}</span>
        <div class="series-info">
          <h3 class="series-name">{{ series.name }}</h3>
          <p class="series-desc">{{ series.description }}</p>
        </div>
        <n-tag size="small" :bordered="false" type="info">{{ series.models.length }} 个模型</n-tag>
      </div>

      <div class="models-grid">
        <n-card
          v-for="model in series.models"
          :key="model.id"
          size="small"
          class="model-card"
          :class="{
            recommended: model.recommended,
            'is-current': model.id === appStore.currentModel,
          }"
        >
          <div class="card-top">
            <div class="model-title-row">
              <span class="model-name">{{ model.name }}</span>
              <n-tag v-if="model.recommended" size="tiny" :bordered="false" type="warning">⭐ 推荐</n-tag>
              <n-tag v-if="model.id === appStore.currentModel" size="tiny" :bordered="false" type="success">当前</n-tag>
            </div>
            <n-tag size="tiny" :bordered="false" :type="model.tier === 'flagship' ? 'error' : model.tier === 'budget' ? 'success' : 'info'">
              {{ tierLabel(model.tier) }}
            </n-tag>
          </div>

          <p class="model-desc">{{ model.description }}</p>

          <div class="model-tags">
            <n-tag v-for="tag in model.tags" :key="tag" size="tiny" :bordered="false" type="default">{{ tag }}</n-tag>
          </div>

          <div class="model-specs">
            <div class="spec-item">
              <span class="spec-label">上下文</span>
              <span class="spec-value">{{ formatContext(model.contextWindow) }}</span>
            </div>
            <div class="spec-item">
              <span class="spec-label">输入价格</span>
              <span class="spec-value">{{ formatPrice(model.inputPrice) }}</span>
            </div>
            <div class="spec-item">
              <span class="spec-label">输出价格</span>
              <span class="spec-value">{{ formatPrice(model.outputPrice) }}</span>
            </div>
            <div class="spec-item" v-if="model.thinkingCapable">
              <span class="spec-label">推理模式</span>
              <span class="spec-value">✅ 支持</span>
            </div>
          </div>

          <div class="model-footer">
            <span class="model-id-text">{{ model.id }}</span>
            <n-switch
              :value="enabledModels.has(model.id)"
              @update:value="(v: boolean) => toggleModel(model.id, v)"
              size="small"
            />
          </div>
        </n-card>
      </div>
    </div>

    <n-empty v-if="filteredSeries.length === 0" description="没有匹配的模型" class="empty-hint" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '@/stores/app'
import { allModels, modelSeries, type ModelInfo } from '@/data/models'

const appStore = useAppStore()

const searchQuery = ref('')
const filterSeries = ref<string | null>(null)
const enabledModels = ref(new Set(allModels.map((m) => m.id)))

const seriesFilterOpts = computed(() => [
  { label: '全部系列', value: null },
  ...modelSeries.map((s) => ({ label: `${s.emoji} ${s.name}`, value: s.id })),
])

const filteredSeries = computed(() => {
  let series = modelSeries
  if (filterSeries.value) {
    series = series.filter((s) => s.id === filterSeries.value)
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    series = series
      .map((s) => ({
        ...s,
        models: s.models.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.id.toLowerCase().includes(q) ||
            m.description.toLowerCase().includes(q) ||
            m.tags.some((t) => t.toLowerCase().includes(q))
        ),
      }))
      .filter((s) => s.models.length > 0)
  }
  return series
})

function toggleModel(id: string, enabled: boolean) {
  if (enabled) {
    enabledModels.value.add(id)
  } else {
    enabledModels.value.delete(id)
  }
}

function tierLabel(tier: ModelInfo['tier']): string {
  const map: Record<string, string> = {
    flagship: '旗舰',
    standard: '标准',
    budget: '性价比',
    specialized: '专项',
  }
  return map[tier] || tier
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`
  return tokens.toString()
}

function formatPrice(price: number): string {
  if (price === 0) return '—'
  return `$${price.toFixed(3)}/M`
}
</script>

<style scoped>
.page-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.page-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.page-header h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}
.page-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin: 4px 0 12px;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.search-input {
  width: 240px;
}

/* Series Sections */
.models-content {
  flex-shrink: 0;
}

.series-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px 24px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
}
.series-emoji {
  font-size: 22px;
}
.series-info {
  flex: 1;
}
.series-name {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}
.series-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin: 2px 0 0;
}

/* Models Grid */
.models-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
  padding: 16px 24px;
}

.model-card {
  border: 1px solid var(--border-color);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.model-card:hover {
  border-color: var(--accent);
}
.model-card.recommended {
  border-color: #f59e0b44;
  background: linear-gradient(135deg, #f59e0b08, transparent);
}
.model-card.is-current {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}
.model-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.model-name {
  font-size: 14px;
  font-weight: 600;
}

.model-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.55;
  margin: 0 0 10px;
}

.model-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 10px;
}

.model-specs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
  padding: 10px;
  background: var(--bg-secondary);
  border-radius: 8px;
  margin-bottom: 10px;
}
.spec-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.spec-label {
  font-size: 11px;
  color: var(--text-muted);
}
.spec-value {
  font-size: 12px;
  font-weight: 500;
  font-family: 'SF Mono', monospace;
}

.model-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}
.model-id-text {
  font-size: 11px;
  color: var(--text-muted);
  font-family: monospace;
}

.empty-hint {
  margin-top: 60px;
}
</style>
