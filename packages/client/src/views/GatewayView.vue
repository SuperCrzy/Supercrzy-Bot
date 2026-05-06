<template>
  <div class="page-container">
    <header class="page-header">
      <h2>Channel Gateway</h2>
      <p class="page-desc">接入企业微信、钉钉、飞书、QQ 等多平台消息通道</p>
    </header>

    <div class="gateway-body">
      <!-- Platform cards -->
      <div class="platforms-grid">
        <n-card v-for="p in platforms" :key="p.id" size="small" class="platform-card"
          :class="{ configured: getChannel(p.id) }">
          <template #header>
            <div class="platform-title">
              <span class="platform-icon">{{ platformIcons[p.id] || '🔌' }}</span>
              <span>{{ p.name }}</span>
              <n-tag size="tiny" :type="getChannel(p.id)?.enabled ? 'success' : 'default'">
                {{ getChannel(p.id)?.enabled ? 'Connected' : 'Not configured' }}
              </n-tag>
            </div>
          </template>
          <p class="platform-desc">{{ p.description }}</p>
          <n-button size="small" type="primary" ghost @click="openConfig(p)">
            {{ getChannel(p.id) ? 'Edit' : 'Configure' }}
          </n-button>
        </n-card>
      </div>

      <!-- Configured channels list -->
      <div v-if="channels.length > 0" style="margin-top:24px">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:12px">Configured Channels</h3>
        <div class="channel-list">
          <div v-for="ch in channels" :key="ch.id" class="channel-row">
            <span class="ch-icon">{{ platformIcons[ch.platform] || '🔌' }}</span>
            <div class="ch-info">
              <span class="ch-name">{{ ch.name }}</span>
              <span class="ch-platform">{{ ch.platform }}</span>
            </div>
            <n-switch :value="ch.enabled" @update:value="v => toggleChannel(ch, v)" size="small" />
            <n-tag size="tiny" :type="ch.status === 'connected' ? 'success' : ch.status === 'error' ? 'error' : 'default'">
              {{ ch.status }}
            </n-tag>
            <n-button size="tiny" quaternary @click="testChannel(ch)">Test</n-button>
            <n-button size="tiny" quaternary type="error" @click="deleteChannel(ch)">Del</n-button>
          </div>
        </div>
      </div>
    </div>

    <!-- Config Modal -->
    <n-modal v-model:show="showConfig" preset="card" title="Configure Channel" style="width:520px">
      <n-form label-placement="left" label-width="130px" size="small">
        <n-form-item label="Name">
          <n-input v-model:value="editForm.name" placeholder="My Bot" />
        </n-form-item>
        <n-form-item v-for="f in currentPlatform?.fields || []" :key="f.key" :label="f.label">
          <template v-if="f.type === 'select'">
            <n-select v-model:value="editForm.config[f.key]" :options="(f.options || []).map((o: string) => ({ label: o, value: o }))" />
          </template>
          <template v-else>
            <n-input v-model:value="editForm.config[f.key]" :type="f.type" :placeholder="f.placeholder" />
          </template>
        </n-form-item>
      </n-form>
      <template #footer>
        <n-button @click="showConfig = false">Cancel</n-button>
        <n-button type="primary" @click="saveConfig">Save</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useMessage } from 'naive-ui'

interface PlatformDef {
  id: string
  name: string
  icon: string
  description: string
  fields: Array<{ key: string; label: string; type: string; placeholder: string; required: boolean; options?: string[] }>
}

interface Channel {
  id: string
  platform: string
  name: string
  enabled: boolean
  config: Record<string, any>
  status: string
}

const nMessage = useMessage()
const platforms = ref<PlatformDef[]>([])
const channels = ref<Channel[]>([])
const showConfig = ref(false)
const currentPlatform = ref<PlatformDef | null>(null)
const editForm = reactive({ id: '', name: '', platform: '', config: {} as Record<string, any> })

const platformIcons: Record<string, string> = {
  wecom: '💼',
  dingtalk: '📌',
  feishu: '🐦',
  qq: '🐧',
}

onMounted(async () => {
  await loadPlatforms()
  await loadChannels()
})

async function loadPlatforms() {
  try {
    const res = await fetch('/api/gateway/platforms')
    platforms.value = await res.json()
  } catch (err) {
    console.error('[Gateway] load platforms failed:', err)
  }
}

async function loadChannels() {
  try {
    const res = await fetch('/api/gateway/channels')
    channels.value = await res.json()
  } catch (err) {
    console.error('[Gateway] load channels failed:', err)
  }
}

function getChannel(platformId: string) {
  return channels.value.find(c => c.platform === platformId)
}

function openConfig(p: PlatformDef) {
  currentPlatform.value = p
  const existing = getChannel(p.id)
  if (existing) {
    editForm.id = existing.id
    editForm.name = existing.name
    editForm.platform = existing.platform
    editForm.config = { ...existing.config }
  } else {
    editForm.id = ''
    editForm.name = p.name + ' Bot'
    editForm.platform = p.id
    editForm.config = {}
  }
  showConfig.value = true
}

async function saveConfig() {
  try {
    const body = {
      id: editForm.id,
      platform: editForm.platform,
      name: editForm.name,
      config: editForm.config,
    }
    const method = editForm.id ? 'PUT' : 'POST'
    const url = editForm.id ? `/api/gateway/channels/${editForm.id}` : '/api/gateway/channels'

    await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    showConfig.value = false
    await loadChannels()
    nMessage.success('Channel saved')
  } catch (err: any) {
    nMessage.error('Save failed: ' + err.message)
  }
}

async function toggleChannel(ch: Channel, enabled: boolean) {
  await fetch(`/api/gateway/channels/${ch.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  await loadChannels()
}

async function testChannel(ch: Channel) {
  try {
    const res = await fetch(`/api/gateway/channels/${ch.id}/test`, { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      nMessage.success('Connection test passed')
    } else {
      nMessage.error(data.message || 'Connection test failed')
    }
    await loadChannels()
  } catch (err: any) {
    nMessage.error('Test failed: ' + err.message)
  }
}

async function deleteChannel(ch: Channel) {
  await fetch(`/api/gateway/channels/${ch.id}`, { method: 'DELETE' })
  await loadChannels()
  nMessage.success('Channel deleted')
}
</script>

<style scoped>
.page-container { height: 100vh; display: flex; flex-direction: column; background: var(--bg-secondary); }
.page-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color); background: var(--bg-primary); flex-shrink: 0; }
.page-header h2 { font-size: 16px; font-weight: 600; margin: 0; }
.page-desc { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
.gateway-body { flex: 1; overflow-y: auto; padding: 24px; max-width: 900px; }

.platforms-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.platform-card { border: 1px solid var(--border-color); }
.platform-card.configured { border-color: var(--accent); }
.platform-title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.platform-icon { font-size: 20px; }
.platform-desc { font-size: 13px; color: var(--text-secondary); margin: 0 0 12px; line-height: 1.6; }

.channel-list { display: flex; flex-direction: column; gap: 8px; }
.channel-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; }
.ch-icon { font-size: 18px; }
.ch-info { flex: 1; display: flex; flex-direction: column; }
.ch-name { font-size: 13px; font-weight: 500; }
.ch-platform { font-size: 11px; color: var(--text-muted); }
</style>
