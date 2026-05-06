<template>
  <div class="page-container"><header class="page-header"><h2>技能管理</h2><p class="page-desc">管理 AI Agent 的可复用技能模块</p><n-button size="small" type="primary"><template #icon><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></template>安装技能</n-button></header>
    <div class="skills-grid">
      <n-card v-for="s in skills" :key="s.name" size="small" class="skill-card">
        <template #header><div class="skill-header"><span class="skill-icon">{{ s.icon }}</span><div><div class="skill-name">{{ s.name }}</div><n-tag size="tiny" :bordered="false" :type="s.enabled ? 'success' : 'default'">{{ s.enabled ? '已启用' : '已禁用' }}</n-tag></div></div></template>
        <p class="skill-desc">{{ s.description }}</p>
        <template #action><n-switch :value="s.enabled" @update:value="v => s.enabled = v" size="small" /></template>
      </n-card>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'

const SKILLS_STORAGE_KEY = 'deepseek-agent-skills'

interface Skill {
  name: string
  icon: string
  description: string
  enabled: boolean
}

const defaultSkills: Skill[] = [
  { name: '代码生成', icon: '💻', description: '根据自然语言描述生成代码，支持多种编程语言', enabled: true },
  { name: '文件操作', icon: '📂', description: '读写本地文件系统，管理项目文件结构', enabled: true },
  { name: '网络搜索', icon: '🌐', description: '搜索互联网获取最新信息和资料', enabled: true },
  { name: 'Shell 执行', icon: '⚡', description: '执行 Shell 命令完成系统操作任务', enabled: false },
  { name: '浏览器自动化', icon: '🖥️', description: '控制浏览器进行网页交互和数据采集', enabled: false },
  { name: '图片生成', icon: '🎨', description: '根据文本描述生成 AI 图片', enabled: false },
  { name: 'PDF 处理', icon: '📄', description: '创建、编辑和转换 PDF 文档', enabled: false },
  { name: '数据可视化', icon: '📊', description: '将数据转换为图表和可视化报告', enabled: true },
]

// 从 localStorage 恢复或使用默认值
function loadSkills(): Skill[] {
  try {
    const saved = localStorage.getItem(SKILLS_STORAGE_KEY)
    if (saved) {
      const savedSkills = JSON.parse(saved) as Skill[]
      // 合并：保留已保存的 enabled 状态，补充新增的默认技能
      return defaultSkills.map(d => {
        const saved = savedSkills.find((s: Skill) => s.name === d.name)
        return saved ? { ...d, enabled: saved.enabled } : d
      })
    }
  } catch {}
  return [...defaultSkills]
}

const skills = ref<Skill[]>(loadSkills())

// 每次切换开关自动保存
watch(skills, (val) => {
  localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(val))
}, { deep: true })

onMounted(() => {
  skills.value = loadSkills()
})
</script>
<style scoped>
.page-container { height: 100vh; display: flex; flex-direction: column; }
.page-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--border-color); flex-shrink: 0; }
.page-header h2 { font-size: 16px; font-weight: 600; margin: 0; } .page-desc { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
.skills-grid { flex: 1; overflow-y: auto; padding: 24px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); align-content: start; }
.skill-card { border: 1px solid var(--border-color); }
.skill-header { display: flex; gap: 12px; align-items: center; }
.skill-icon { font-size: 24px; }
.skill-name { font-weight: 600; font-size: 14px; }
.skill-desc { font-size: 13px; color: var(--text-secondary); margin: 0; line-height: 1.6; }
</style>
