<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h2>Skills</h2>
        <p class="page-desc">Manage reusable Agent skill modules</p>
      </div>
      <div class="header-actions">
        <n-input v-model:value="searchQuery" placeholder="Search skills..." size="small" clearable style="width: 200px">
          <template #prefix>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </template>
        </n-input>
        <n-select v-model:value="filterCategory" :options="categoryOptions" size="small" clearable placeholder="All categories" style="width: 140px" />
        <n-button size="small" type="primary" @click="showCreateModal = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          New Skill
        </n-button>
      </div>
    </header>

    <!-- Stats bar -->
    <div class="stats-bar">
      <span class="stat-item">{{ skills.length }} total</span>
      <span class="stat-item">{{ enabledCount }} enabled</span>
      <span class="stat-item">{{ builtinCount }} builtin</span>
    </div>

    <!-- Skills Grid -->
    <div class="skills-grid">
      <n-card v-for="s in filteredSkills" :key="s.id" size="small" class="skill-card" :class="{ disabled: !s.enabled }">
        <template #header>
          <div class="skill-header">
            <span class="skill-icon">{{ s.icon }}</span>
            <div class="skill-info">
              <div class="skill-name">{{ s.name }}</div>
              <n-tag size="tiny" :bordered="false" :type="s.enabled ? 'success' : 'default'">
                {{ s.enabled ? 'Active' : 'Inactive' }}
              </n-tag>
            </div>
          </div>
        </template>
        <p class="skill-desc">{{ s.description }}</p>
        <div class="skill-meta">
          <n-tag v-if="s.category" size="tiny" :bordered="false" type="info">{{ s.category }}</n-tag>
          <n-tag v-if="s.is_builtin" size="tiny" :bordered="false">builtin</n-tag>
          <span v-if="s.trigger_keywords" class="skill-keywords">{{ s.trigger_keywords.split(',').slice(0, 3).join(', ') }}</span>
        </div>
        <template #action>
          <div class="skill-actions">
            <n-button size="tiny" quaternary @click="editSkill(s)">Edit</n-button>
            <n-switch :value="!!s.enabled" @update:value="v => toggleSkill(s.id, v)" size="small" />
            <n-button v-if="!s.is_builtin" size="tiny" quaternary type="error" @click="deleteSkill(s.id)">Del</n-button>
          </div>
        </template>
      </n-card>
    </div>

    <n-empty v-if="filteredSkills.length === 0 && !loading" description="No skills found" style="margin-top: 60px" />

    <!-- Create/Edit Modal -->
    <n-modal v-model:show="showCreateModal" preset="card" :title="editingSkill ? 'Edit Skill' : 'New Skill'" style="max-width: 560px" :mask-closable="false">
      <n-form ref="formRef" :model="formData" label-placement="left" label-width="120">
        <n-form-item label="Name" path="name">
          <n-input v-model:value="formData.name" placeholder="Skill name" />
        </n-form-item>
        <n-form-item label="Icon" path="icon">
          <n-input v-model:value="formData.icon" placeholder="emoji" style="width: 80px" />
        </n-form-item>
        <n-form-item label="Description" path="description">
          <n-input v-model:value="formData.description" type="textarea" :rows="2" placeholder="What does this skill do?" />
        </n-form-item>
        <n-form-item label="Category" path="category">
          <n-select v-model:value="formData.category" :options="categoryOptions" />
        </n-form-item>
        <n-form-item label="Trigger Keywords" path="trigger_keywords">
          <n-input v-model:value="formData.trigger_keywords" placeholder="keyword1, keyword2, ..." />
        </n-form-item>
        <n-form-item label="Prompt Template" path="prompt_template">
          <n-input v-model:value="formData.prompt_template" type="textarea" :rows="3" placeholder="System prompt for this skill" />
        </n-form-item>
        <n-form-item label="Tools">
          <n-dynamic-tags v-model:value="formData.tools" />
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showCreateModal = false">Cancel</n-button>
        <n-button type="primary" @click="saveSkill">{{ editingSkill ? 'Update' : 'Create' }}</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface Skill {
  id: string
  name: string
  description: string
  icon: string
  category: string
  enabled: number
  trigger_keywords: string
  prompt_template: string
  tools: string
  sort_order: number
  is_builtin: number
}

const skills = ref<Skill[]>([])
const loading = ref(false)
const searchQuery = ref('')
const filterCategory = ref<string | null>(null)
const showCreateModal = ref(false)
const editingSkill = ref<Skill | null>(null)

const categoryOptions = [
  { label: 'Coding', value: 'coding' },
  { label: 'Research', value: 'research' },
  { label: 'System', value: 'system' },
  { label: 'Automation', value: 'automation' },
  { label: 'Analysis', value: 'analysis' },
  { label: 'Writing', value: 'writing' },
  { label: 'General', value: 'general' },
]

const formData = ref({
  name: '',
  icon: '',
  description: '',
  category: 'general',
  trigger_keywords: '',
  prompt_template: '',
  tools: [] as string[],
})

const filteredSkills = computed(() => {
  let list = skills.value
  if (filterCategory.value) {
    list = list.filter(s => s.category === filterCategory.value)
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.trigger_keywords.toLowerCase().includes(q)
    )
  }
  return list
})

const enabledCount = computed(() => skills.value.filter(s => s.enabled).length)
const builtinCount = computed(() => skills.value.filter(s => s.is_builtin).length)

async function loadSkills() {
  loading.value = true
  try {
    const resp = await fetch('/api/skills')
    skills.value = await resp.json()
  } catch (err) {
    console.error('Failed to load skills:', err)
  }
  loading.value = false
}

async function toggleSkill(id: string, enabled: boolean) {
  try {
    await fetch(`/api/skills/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    await loadSkills()
  } catch (err) {
    console.error('Failed to toggle skill:', err)
  }
}

async function deleteSkill(id: string) {
  try {
    await fetch(`/api/skills/${id}`, { method: 'DELETE' })
    await loadSkills()
  } catch (err) {
    console.error('Failed to delete skill:', err)
  }
}

function editSkill(skill: Skill) {
  editingSkill.value = skill
  formData.value = {
    name: skill.name,
    icon: skill.icon,
    description: skill.description,
    category: skill.category,
    trigger_keywords: skill.trigger_keywords,
    prompt_template: skill.prompt_template,
    tools: JSON.parse(skill.tools || '[]'),
  }
  showCreateModal.value = true
}

function resetForm() {
  editingSkill.value = null
  formData.value = { name: '', icon: '', description: '', category: 'general', trigger_keywords: '', prompt_template: '', tools: [] }
}

async function saveSkill() {
  const body = {
    ...formData.value,
    tools: JSON.stringify(formData.value.tools),
  }

  try {
    if (editingSkill.value) {
      await fetch(`/api/skills/${editingSkill.value.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } else {
      await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    showCreateModal.value = false
    resetForm()
    await loadSkills()
  } catch (err) {
    console.error('Failed to save skill:', err)
  }
}

onMounted(() => {
  loadSkills()
})
</script>

<style scoped>
.page-container { height: 100vh; display: flex; flex-direction: column; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--border-color); flex-shrink: 0; }
.page-header h2 { font-size: 16px; font-weight: 600; margin: 0; }
.page-desc { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
.header-actions { display: flex; gap: 8px; align-items: center; }
.stats-bar { display: flex; gap: 16px; padding: 8px 24px; font-size: 12px; color: var(--text-muted); border-bottom: 1px solid var(--border-color); flex-shrink: 0; }
.stat-item { padding: 2px 0; }

.skills-grid { flex: 1; overflow-y: auto; padding: 24px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); align-content: start; }

.skill-card { border: 1px solid var(--border-color); transition: border-color 0.2s; }
.skill-card:hover { border-color: var(--border-secondary); }
.skill-card.disabled { opacity: 0.6; }

.skill-header { display: flex; gap: 12px; align-items: center; }
.skill-icon { font-size: 24px; flex-shrink: 0; }
.skill-info { flex: 1; min-width: 0; }
.skill-name { font-weight: 600; font-size: 14px; }
.skill-desc { font-size: 13px; color: var(--text-secondary); margin: 8px 0 0; line-height: 1.6; }
.skill-meta { display: flex; gap: 6px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.skill-keywords { font-size: 11px; color: var(--text-muted); margin-left: 4px; }
.skill-actions { display: flex; gap: 4px; align-items: center; }
</style>
