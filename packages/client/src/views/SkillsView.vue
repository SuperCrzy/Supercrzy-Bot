<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h2>Skills</h2>
        <p class="page-desc">Manage reusable Agent skill modules</p>
      </div>
      <div class="header-actions">
        <div class="search-wrap">
          <SvgIcon name="search" :size="14" class="search-icon-prefix" />
          <input v-model="searchQuery" placeholder="Search skills..." class="search-input" />
        </div>
        <n-select v-model:value="filterCategory" :options="categoryOptions" size="small" clearable placeholder="All" style="width:120px" />
        <n-button size="small" quaternary @click="showInstallModal = true">
          <template #icon><SvgIcon name="download" :size="14" /></template>
          Install
        </n-button>
        <n-button size="small" type="primary" @click="openCreateModal">
          <template #icon><SvgIcon name="plus" :size="14" /></template>
          New
        </n-button>
      </div>
    </header>

    <div class="stats-bar">
      <span class="stat-item"><strong>{{ skills.length }}</strong> total</span>
      <span class="stat-item"><strong>{{ enabledCount }}</strong> active</span>
      <span class="stat-item"><strong>{{ builtinCount }}</strong> builtin</span>
    </div>

    <div class="skills-grid">
      <n-card v-for="s in filteredSkills" :key="s.id" size="small" class="skill-card" :class="{ disabled: !s.enabled }">
        <template #header>
          <div class="skill-header">
            <div class="skill-icon" :class="'cat-' + s.category">
              <SvgIcon :name="getCategoryIcon(s.category)" :size="18" />
            </div>
            <div class="skill-info">
              <div class="skill-name">{{ s.name }}</div>
              <div class="skill-tags">
                <n-tag size="tiny" :bordered="false" :type="s.enabled ? 'success' : 'default'">{{ s.enabled ? 'Active' : 'Off' }}</n-tag>
                <span class="skill-cat" :class="'cat-' + s.category">{{ s.category }}</span>
              </div>
            </div>
          </div>
        </template>
        <p class="skill-desc">{{ s.description }}</p>
        <div class="skill-meta">
          <n-tag v-if="s.is_builtin" size="tiny" :bordered="false">builtin</n-tag>
          <span v-if="s.trigger_keywords" class="skill-kw">{{ s.trigger_keywords.split(',').slice(0,3).join(', ') }}</span>
        </div>
        <template #action>
          <div class="skill-actions">
            <n-button size="tiny" quaternary @click="editSkill(s)">Edit</n-button>
            <n-switch :value="!!s.enabled" @update:value="(v: boolean) => toggleSkill(s.id, v)" size="small" />
            <n-button v-if="!s.is_builtin" size="tiny" quaternary type="error" @click="deleteSkill(s.id)">Del</n-button>
          </div>
        </template>
      </n-card>
    </div>

    <n-empty v-if="filteredSkills.length===0&&!loading" description="No skills found" style="margin-top:60px">
      <template #extra>
        <n-button size="small" type="primary" :loading="syncing" @click="doSync">初始化内置技能</n-button>
      </template>
    </n-empty>

    <!-- Create/Edit Modal -->
    <n-modal v-model:show="showCreateModal" preset="card" :title="editingSkill?'Edit Skill':'New Skill'" style="max-width:560px" :mask-closable="false">
      <n-form ref="formRef" :model="formData" label-placement="left" label-width="120">
        <n-form-item label="Name"><n-input v-model:value="formData.name" placeholder="Skill name" /></n-form-item>
        <n-form-item label="Icon"><n-input v-model:value="formData.icon" placeholder="SVG icon name" style="width:120px" /></n-form-item>
        <n-form-item label="Description"><n-input v-model:value="formData.description" type="textarea" :rows="2" /></n-form-item>
        <n-form-item label="Category"><n-select v-model:value="formData.category" :options="categoryOptions" /></n-form-item>
        <n-form-item label="Keywords"><n-input v-model:value="formData.trigger_keywords" placeholder="kw1, kw2, ..." /></n-form-item>
        <n-form-item label="Prompt"><n-input v-model:value="formData.prompt_template" type="textarea" :rows="3" /></n-form-item>
        <n-form-item label="Tools"><n-dynamic-tags v-model:value="formData.tools" /></n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showCreateModal=false">Cancel</n-button>
        <n-button type="primary" @click="saveSkill">{{ editingSkill?'Update':'Create' }}</n-button>
      </template>
    </n-modal>

    <!-- Install Modal -->
    <n-modal v-model:show="showInstallModal" preset="card" title="Install from GitHub" style="max-width:480px" :mask-closable="false">
      <div style="display:flex;flex-direction:column;gap:16px">
        <p style="font-size:13px;color:var(--text-secondary)">Enter a GitHub URL containing a SKILL.md file.</p>
        <n-input v-model:value="installUrl" placeholder="https://github.com/user/skill-repo" />
        <div v-if="installError" style="color:var(--error);font-size:12px">{{ installError }}</div>
        <div v-if="installSuccess" style="color:var(--success);font-size:12px">{{ installSuccess }}</div>
      </div>
      <template #action>
        <n-button @click="closeInstallModal">Cancel</n-button>
        <n-button type="primary" :loading="installing" @click="doInstall">{{ installing?'Installing...':'Install' }}</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'

interface Skill {
  id: string; name: string; description: string; icon: string; category: string
  enabled: number; trigger_keywords: string; prompt_template: string; tools: string
  sort_order: number; is_builtin: number
}

const skills = ref<Skill[]>([])
const loading = ref(false)
const syncing = ref(false)
const searchQuery = ref('')
const filterCategory = ref<string|null>(null)
const showCreateModal = ref(false)
const showInstallModal = ref(false)
const editingSkill = ref<Skill|null>(null)
const installUrl = ref('')
const installing = ref(false)
const installError = ref('')
const installSuccess = ref('')

const catIcons: Record<string,string> = { coding:'code', research:'search', system:'settings', automation:'zap', analysis:'activity', writing:'pen', general:'star' }
function getCategoryIcon(c:string) { return catIcons[c] || 'star' }

const categoryOptions = [
  { label:'Coding', value:'coding' },{ label:'Research', value:'research' },{ label:'System', value:'system' },
  { label:'Automation', value:'automation' },{ label:'Analysis', value:'analysis' },{ label:'Writing', value:'writing' },{ label:'General', value:'general' },
]

const formData = ref({ name:'', icon:'star', description:'', category:'general', trigger_keywords:'', prompt_template:'', tools:[] as string[] })

const filteredSkills = computed(() => {
  let list = skills.value
  if (filterCategory.value) list = list.filter(s=>s.category===filterCategory.value)
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(s=>s.name.toLowerCase().includes(q)||s.description.toLowerCase().includes(q)||s.trigger_keywords.toLowerCase().includes(q))
  }
  return list
})

const enabledCount = computed(() => skills.value.filter(s=>s.enabled).length)
const builtinCount = computed(() => skills.value.filter(s=>s.is_builtin).length)

async function loadSkills() {
  loading.value = true
  try { const r=await fetch('/api/skills'); skills.value=await r.json() } catch(e){}
  loading.value = false
}

async function doSync() {
  syncing.value = true
  try {
    await fetch('/api/skills/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    loading.value = true
    try { const r=await fetch('/api/skills'); skills.value=await r.json() } catch(e){}
    loading.value = false
  } catch(e){} finally { syncing.value = false }
}

async function toggleSkill(id:string,enabled:boolean){ await fetch(`/api/skills/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})}); await loadSkills() }
async function deleteSkill(id:string){ await fetch(`/api/skills/${id}`,{method:'DELETE'}); await loadSkills() }

function openCreateModal(){ editingSkill.value=null; formData.value={name:'',icon:'star',description:'',category:'general',trigger_keywords:'',prompt_template:'',tools:[]}; showCreateModal.value=true }
function editSkill(s:Skill){ editingSkill.value=s; formData.value={name:s.name,icon:s.icon||'star',description:s.description,category:s.category,trigger_keywords:s.trigger_keywords,prompt_template:s.prompt_template,tools:JSON.parse(s.tools||'[]')}; showCreateModal.value=true }

async function saveSkill(){
  const body={...formData.value,tools:JSON.stringify(formData.value.tools)}
  try {
    if(editingSkill.value){ await fetch(`/api/skills/${editingSkill.value.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}) }
    else { await fetch('/api/skills',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}) }
    showCreateModal.value=false; await loadSkills()
  } catch(e){}
}

async function doInstall(){
  if(!installUrl.value.trim()){ installError.value='Enter a GitHub URL'; return }
  installing.value=true; installError.value=''; installSuccess.value=''
  try {
    const r=await fetch('/api/skills/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:installUrl.value.trim()})})
    const d=await r.json()
    if(d.success){ installSuccess.value=`Installed: ${d.name}`; installUrl.value=''; setTimeout(()=>{showInstallModal.value=false;installSuccess.value=''},1500); await loadSkills() }
    else { installError.value=d.error||'Failed' }
  } catch(e:any){ installError.value=e.message }
  finally { installing.value=false }
}

function closeInstallModal(){ showInstallModal.value=false; installUrl.value=''; installError.value=''; installSuccess.value='' }

onMounted(async () => {
  await loadSkills()
  if (skills.value.length === 0) await doSync()
})
</script>

<style scoped>
.page-container { height:100vh; display:flex; flex-direction:column }
.page-header { display:flex; align-items:flex-start; justify-content:space-between; padding:16px 24px; border-bottom:1px solid var(--border-color); flex-shrink:0 }
.page-header h2 { font-size:var(--text-lg); font-weight:600; margin:0 }
.page-desc { font-size:var(--text-sm); color:var(--text-muted); margin:4px 0 0 }
.header-actions { display:flex; gap:8px; align-items:center }
.search-wrap { position:relative; width:200px }
.search-icon-prefix { position:absolute; left:8px; top:50%; transform:translateY(-50%); color:var(--text-muted); pointer-events:none }
.search-input { width:100%; height:30px; padding:4px 8px 4px 28px; border-radius:var(--radius-sm); border:1px solid var(--border-color); background:var(--bg-primary); color:var(--text-primary); font-size:var(--text-sm); outline:none }
.search-input:focus { border-color:var(--accent) }
.stats-bar { display:flex; gap:16px; padding:8px 24px; font-size:var(--text-xs); color:var(--text-muted); border-bottom:1px solid var(--border-color); flex-shrink:0 }
.stats-bar strong { color:var(--text-secondary) }
.skills-grid { flex:1; overflow-y:auto; padding:24px; display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); align-content:start }
.skill-card { border:1px solid var(--border-color) }
.skill-card:hover { border-color:var(--border-hover) }
.skill-card.disabled { opacity:.6 }
.skill-header { display:flex; gap:12px; align-items:center }
.skill-icon { width:36px; height:36px; border-radius:var(--radius-md); display:flex; align-items:center; justify-content:center; flex-shrink:0; background:var(--bg-secondary); color:var(--text-secondary) }
.skill-icon.cat-coding { background:rgba(37,99,235,.1); color:var(--cat-coding) }
.skill-icon.cat-research { background:rgba(124,58,237,.1); color:var(--cat-research) }
.skill-icon.cat-system,.skill-icon.cat-general { background:rgba(100,116,139,.1); color:var(--cat-system) }
.skill-icon.cat-automation { background:rgba(217,119,6,.1); color:var(--cat-automation) }
.skill-icon.cat-analysis { background:rgba(5,150,105,.1); color:var(--cat-analysis) }
.skill-icon.cat-writing { background:rgba(219,39,119,.1); color:var(--cat-writing) }
.skill-info { flex:1; min-width:0 }
.skill-name { font-weight:600; font-size:var(--text-base) }
.skill-tags { display:flex; gap:6px; align-items:center; margin-top:3px }
.skill-cat { font-size:10px; font-weight:600; padding:1px 5px; border-radius:3px; text-transform:uppercase }
.skill-cat.cat-coding { background:rgba(37,99,235,.08); color:var(--cat-coding) }
.skill-cat.cat-research { background:rgba(124,58,237,.08); color:var(--cat-research) }
.skill-cat.cat-system,.skill-cat.cat-general { background:rgba(100,116,139,.08); color:var(--cat-system) }
.skill-cat.cat-automation { background:rgba(217,119,6,.08); color:var(--cat-automation) }
.skill-cat.cat-analysis { background:rgba(5,150,105,.08); color:var(--cat-analysis) }
.skill-cat.cat-writing { background:rgba(219,39,119,.08); color:var(--cat-writing) }
.skill-desc { font-size:13px; color:var(--text-secondary); margin:8px 0 0; line-height:1.6 }
.skill-meta { display:flex; gap:6px; align-items:center; margin-top:8px; flex-wrap:wrap }
.skill-kw { font-size:var(--text-xs); color:var(--text-muted); margin-left:4px }
.skill-actions { display:flex; gap:4px; align-items:center }
</style>
