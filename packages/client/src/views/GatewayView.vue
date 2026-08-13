<template>
  <div class="page-container">
    <header class="page-header">
      <h2>{{ $t('gateway.title') }}</h2>
      <p class="page-desc">{{ $t('gateway.desc') }}</p>
    </header>

    <div class="gateway-body">
      <!-- Connected Channels -->
      <div v-if="savedChannels.length > 0" class="section">
        <h3 class="section-title">{{ $t('gateway.configuredChannels') }}</h3>
        <div class="channels-list">
          <div v-for="ch in savedChannels" :key="ch.id" class="channel-row"
            :class="{ enabled: ch.enabled }">
            <div class="channel-icon" :class="ch.platform">
              <SvgIcon :name="getPlatformIcon(ch.platform)" :size="18" />
            </div>
            <div class="channel-info">
              <div class="channel-name">{{ ch.name }}</div>
              <div class="channel-meta">{{ ch.platform }} · {{ ch.status }}</div>
            </div>
            <n-switch :value="ch.enabled" @update:value="(v: boolean) => toggleChannel(ch, v)" size="small" />
            <n-button size="tiny" quaternary @click="editChannel(ch)">{{ $t('common.edit') }}</n-button>
            <n-button size="tiny" quaternary type="error" @click="deleteChannel(ch)">{{ $t('common.delete') }}</n-button>
          </div>
        </div>
      </div>

      <!-- Platform Cards -->
      <h3 class="section-title">{{ $t('gateway.addChannel') }}</h3>
      <div class="platforms-grid">
        <n-card v-for="p in platforms" :key="p.id" size="small" class="platform-card"
          :class="{ connected: p.id==='wechat' && wechatStatus.connected }">
          <template #header>
            <div class="platform-title">
              <div class="platform-icon" :class="p.id">
                <SvgIcon :name="getPlatformIcon(p.id)" :size="20" />
              </div>
              <span>{{ p.name }}</span>
              <n-tag size="tiny" :type="p.id==='wechat'&&wechatStatus.connected?'success':'default'">
                {{ p.id==='wechat'&&wechatStatus.connected ? 'Connected' : (p.id==='wechat' ? 'Scan' : 'Add') }}
              </n-tag>
            </div>
          </template>
          <p class="platform-desc">{{ p.description }}</p>
          <div class="platform-actions">
            <n-button v-if="p.isILink" size="small" :type="wechatStatus.connected ? 'default' : 'primary'" @click="openWechatQR">
              {{ wechatStatus.connected ? 'Reconnect' : 'Scan QR Code' }}
            </n-button>
            <n-button v-if="p.isILink && wechatStatus.connected" size="small" quaternary type="error" @click="disconnectWechat">{{ $t('gateway.disconnect') }}</n-button>
            <n-button v-if="!p.isILink" size="small" type="primary" ghost @click="openConfigDialog(p)">{{ $t('gateway.configure') }}</n-button>
          </div>
        </n-card>
      </div>
    </div>

    <!-- Config Modal -->
    <n-modal v-model:show="showConfig" preset="card" :title="'Configure ' + editingPlatform?.name" style="max-width:500px">
      <n-form v-if="editingPlatform" label-placement="top" size="small">
        <n-form-item :label="$t('gateway.channelName')">
          <n-input v-model:value="editForm.name" placeholder="My Bot" />
        </n-form-item>
        <n-form-item v-for="f in editingPlatform.fields" :key="f.key" :label="f.label">
          <n-input v-if="f.type==='text'" v-model:value="editForm.config[f.key]" :placeholder="f.placeholder" />
          <n-input v-else-if="f.type==='password'" v-model:value="editForm.config[f.key]" :placeholder="f.placeholder" type="password" show-password-on="click" />
          <n-select v-else-if="f.type==='select'" v-model:value="editForm.config[f.key]" :options="(f.options||[]).map((o:string)=>({label:o,value:o}))" />
        </n-form-item>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
          <n-button size="small" @click="showConfig=false">{{ $t('common.cancel') }}</n-button>
          <n-button size="small" type="primary" @click="saveChannel" :loading="saving">{{ $t('common.save') }}</n-button>
          <n-button size="small" type="success" ghost @click="testChannel" :loading="testing">{{ $t('gateway.testConnection') }}</n-button>
        </div>
      </n-form>
    </n-modal>

    <!-- WeChat QR Code Modal -->
    <n-modal v-model:show="showWechatQR" preset="card" title="Connect WeChat" style="max-width:420px;text-align:center">
      <div v-if="qrPhase==='loading'" style="padding:40px;color:var(--text-muted)">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinning"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        <p style="margin-top:12px">{{ $t('gateway.generatingQr') }}</p>
      </div>
      <div v-else-if="qrPhase==='ready'" style="padding:16px">
        <img :src="qrImage" alt="QR" style="width:280px;height:280px;border-radius:8px;border:1px solid var(--border-color)" />
        <p style="font-size:13px;color:var(--text-secondary);margin-top:12px">
          Open WeChat and scan the QR code<br/>
          <span style="font-size:11px;color:var(--text-muted)">{{ $t('gateway.requiresClawBot') }}</span>
        </p>
        <n-button size="small" quaternary @click="pollQRStatus" :loading="qrPolling">{{ $t('gateway.startPolling') }}</n-button>
      </div>
      <div v-else-if="qrPhase==='confirmed'" style="padding:40px">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--success)"><polyline points="20 6 9 17 4 12"/></svg>
        <p style="margin-top:16px;font-weight:600;color:var(--success)">{{ $t('gateway.connected') }}</p>
        <p style="font-size:13px;color:var(--text-muted)">{{ $t('gateway.wechatLinked') }}</p>
      </div>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { errMsg } from '@/utils/i18n-error'
import SvgIcon from '@/components/ui/SvgIcon.vue'

const nMessage = useMessage()
const { t } = useI18n({ useScope: 'global' })
const platforms = ref<any[]>([])
const savedChannels = ref<any[]>([])
const showConfig = ref(false)
const showWechatQR = ref(false)
const saving = ref(false)
const testing = ref(false)
const editingPlatform = ref<any>(null)
const editingChannel = ref<any>(null)
const editForm = reactive({ name: '', config: {} as Record<string,string> })
const qrPhase = ref<string>('loading')
const qrImage = ref('')
const qrCode = ref('')
const qrPolling = ref(false)
const wechatStatus = ref({ connected: false, running: false })
let pollTimer: ReturnType<typeof setInterval> | null = null

function getPlatformIcon(id: string): string {
  const map: Record<string,string> = { wechat:'message', wecom:'message', dingtalk:'zap', feishu:'send', qq:'user' }
  return map[id] || 'plug'
}

onMounted(async () => {
  await Promise.all([loadPlatforms(), loadChannels(), checkWechatStatus()])
})

onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })

async function loadPlatforms() {
  try { platforms.value = await (await fetch('/api/gateway/platforms')).json() } catch {}
}

async function loadChannels() {
  try { savedChannels.value = await (await fetch('/api/gateway/channels')).json() } catch {}
}

async function checkWechatStatus() {
  try { wechatStatus.value = await (await fetch('/api/gateway/wechat/status')).json() } catch {}
}

// ── Config Dialog ──────────────────────────────────────

function openConfigDialog(platform: any) {
  editingPlatform.value = platform
  editingChannel.value = null
  editForm.name = `${platform.name} Bot`
  editForm.config = {}
  for (const f of platform.fields || []) {
    editForm.config[f.key] = ''
  }
  showConfig.value = true
}

function editChannel(ch: any) {
  const def = platforms.value.find((p: any) => p.id === ch.platform)
  editingPlatform.value = def
  editingChannel.value = ch
  editForm.name = ch.name
  editForm.config = { ...ch.config }
  showConfig.value = true
}

async function saveChannel() {
  saving.value = true
  try {
    const body = {
      platform: editingPlatform.value.id,
      name: editForm.name,
      config: editForm.config,
    }
    if (editingChannel.value) {
      await fetch(`/api/gateway/channels/${editingChannel.value.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editForm.name, config: editForm.config }),
      })
    } else {
      await fetch('/api/gateway/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    showConfig.value = false
    nMessage.success(t('gateway.saved'))
    await loadChannels()
  } catch { nMessage.error('Failed to save') }
  saving.value = false
}

async function testChannel() {
  testing.value = true
  try {
    // 先保存
    if (!editingChannel.value) {
      const r = await fetch('/api/gateway/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: editingPlatform.value.id, name: editForm.name, config: editForm.config }),
      })
      const d = await r.json()
      editingChannel.value = { id: d.id }
    }
    const r = await fetch(`/api/gateway/channels/${editingChannel.value.id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: editForm.config }),
    })
    const d = await r.json()
    if (d.success) {
      nMessage.success('Connection successful')
    } else {
      nMessage.error(errMsg(d.code, d.message || 'Connection failed'))
    }
    await loadChannels()
  } catch { nMessage.error('Test failed') }
  testing.value = false
}

async function toggleChannel(ch: any, enabled: boolean) {
  try {
    await fetch(`/api/gateway/channels/${ch.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    await loadChannels()
    nMessage.success(enabled ? t('gateway.enabled') : t('gateway.disabled'))
  } catch { nMessage.error(t('gateway.failed')) }
}

async function deleteChannel(ch: any) {
  try {
    await fetch(`/api/gateway/channels/${ch.id}`, { method: 'DELETE' })
    await loadChannels()
    nMessage.success(t('gateway.deleted'))
  } catch { nMessage.error(t('gateway.failed')) }
}

// ── WeChat QR ──────────────────────────────────────────

async function openWechatQR() {
  showWechatQR.value = true; qrPhase.value = 'loading'
  try {
    const r = await fetch('/api/gateway/wechat/qrcode')
    const d = await r.json()
    if (d.error) { qrPhase.value='expired'; return }
    qrImage.value = d.qrDataUrl; qrCode.value = d.qrcode
    qrPhase.value = 'ready'
  } catch { qrPhase.value = 'expired' }
}

async function pollQRStatus() {
  if (!qrCode.value) return
  qrPolling.value = true; qrPhase.value = 'polling'
  pollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/gateway/wechat/qrcode/status?qrcode=${encodeURIComponent(qrCode.value)}`)
      const d = await r.json()
      if (d.status==='confirmed') { qrPhase.value='confirmed'; clearInterval(pollTimer!); qrPolling.value=false; await checkWechatStatus(); setTimeout(() => { showWechatQR.value=false }, 2500) }
      else if (d.status==='expired') { qrPhase.value='expired'; clearInterval(pollTimer!); qrPolling.value=false }
    } catch { clearInterval(pollTimer!); qrPolling.value=false; qrPhase.value='expired' }
  }, 3000)
}

async function disconnectWechat() {
  try {
    await fetch('/api/gateway/wechat/disconnect', { method:'POST' })
    wechatStatus.value = { connected:false, running:false }; nMessage.success(t('gateway.disconnected'))
  } catch { nMessage.error(t('gateway.failed')) }
}
</script>

<style scoped>
.page-container { height:100vh; display:flex; flex-direction:column; background:var(--bg-secondary) }
.page-header { padding:16px 24px; border-bottom:1px solid var(--border-color); background:var(--bg-primary); flex-shrink:0 }
.page-header h2 { font-size:16px; font-weight:600; margin:0 }
.page-desc { font-size:12px; color:var(--text-muted); margin:4px 0 0 }
.gateway-body { flex:1; overflow-y:auto; padding:24px; max-width:700px }

.section { margin-bottom:24px }
.section-title { font-size:13px; font-weight:600; margin:0 0 12px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.5px }

.channels-list { display:flex; flex-direction:column; gap:4px; margin-bottom:20px }
.channel-row { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:8px; background:var(--bg-primary); border:1px solid var(--border-color); transition:border-color .2s }
.channel-row.enabled { border-color:var(--accent) }
.channel-icon { width:32px; height:32px; border-radius:6px; display:flex; align-items:center; justify-content:center; flex-shrink:0 }
.channel-icon.qq { background:rgba(18,150,222,.1); color:#1296de }
.channel-icon.wecom { background:rgba(5,193,101,.1); color:#05c165 }
.channel-icon.dingtalk { background:rgba(0,130,255,.1); color:#0082ff }
.channel-icon.feishu { background:rgba(51,126,255,.1); color:#337eff }
.channel-info { flex:1; min-width:0 }
.channel-name { font-size:13px; font-weight:500 }
.channel-meta { font-size:11px; color:var(--text-muted) }

.platforms-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:16px }
.platform-card { border:1px solid var(--border-color) }
.platform-card.connected { border-color:var(--accent) }
.platform-title { display:flex; align-items:center; gap:8px; font-weight:600 }
.platform-icon { width:36px; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center; background:var(--bg-secondary); color:var(--text-secondary) }
.platform-icon.wechat { background:rgba(5,150,105,.1); color:#059669 }
.platform-desc { font-size:13px; color:var(--text-secondary); margin:0 0 12px; line-height:1.6 }
.platform-actions { display:flex; gap:8px }

.spinning { animation:spin 1.5s linear infinite }
@keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
</style>
