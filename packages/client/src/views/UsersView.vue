<template>
  <div class="page-container"><header class="page-header"><h2>用户管理</h2><p class="page-desc">管理 SuperCrzy 用户和访问权限</p></header>
    <div class="users-list">
      <div class="user-card" v-for="u in users" :key="u.id">
        <div class="user-avatar">{{ u.name[0] }}</div>
        <div class="user-info"><div class="user-name">{{ u.name }} <n-tag size="tiny" :bordered="false" :type="u.role === 'admin' ? 'error' : 'info'">{{ u.role }}</n-tag></div><div class="user-email">{{ u.email }}</div><div class="user-last">最后活跃: {{ u.lastActive }}</div></div>
        <n-switch :value="u.active" size="small" />
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue'
const users = ref([{ id: '1', name: 'Admin', email: 'admin@supercrzy.local', role: 'admin', active: true, lastActive: '刚刚' }, { id: '2', name: 'API User', email: 'api@supercrzy.local', role: 'user', active: true, lastActive: '2 小时前' }])
</script>
<style scoped>
.page-container { height: 100vh; display: flex; flex-direction: column; }
.page-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color); }
.page-header h2 { font-size: 16px; font-weight: 600; margin: 0; } .page-desc { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
.users-list { flex: 1; overflow-y: auto; padding: 24px; max-width: 640px; display: flex; flex-direction: column; gap: 8px; }
.user-card { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border: 1px solid var(--border-color); border-radius: 10px; }
.user-avatar { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #4F46E5, #06B6D4); color: white; font-weight: 700; font-size: 16px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.user-info { flex: 1; }
.user-name { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.user-email { font-size: 12px; color: var(--text-secondary); margin: 2px 0; }
.user-last { font-size: 11px; color: var(--text-muted); }
</style>
