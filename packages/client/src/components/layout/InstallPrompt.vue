<template>
  <transition name="pwa-fade">
    <div v-if="show" class="pwa-prompt">
      <div class="pwa-body">
        <div class="pwa-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 3v12" /><path d="M8 11l4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        </div>
        <div class="pwa-text">
          <div class="pwa-title">{{ isIos ? $t('pwa.iosTitle') : $t('pwa.title') }}</div>
          <div class="pwa-desc">{{ isIos ? $t('pwa.iosDesc') : $t('pwa.desc') }}</div>
        </div>
        <button v-if="!isIos" class="pwa-install" @click="install">{{ $t('pwa.install') }}</button>
        <button class="pwa-close" @click="dismiss" :title="$t('pwa.dismiss')">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const show = ref(false)
const isIos = ref(false)
let deferredPrompt: BeforeInstallPromptEvent | null = null

const UA = typeof navigator !== 'undefined' ? navigator.userAgent : ''
const isStandalone = typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches

onMounted(() => {
  if (isStandalone) return  // 已安装，不提示

  // 桌面/安卓：捕获安装事件
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e as BeforeInstallPromptEvent
    // 延迟 5 秒再提示，避免干扰首次使用
    setTimeout(() => { show.value = true }, 5000)
  })

  // iOS Safari：无 beforeinstallprompt，只能引导"添加到主屏幕"
  const isIOS = /iphone|ipad|ipod/i.test(UA)
  if (isIOS && !window.matchMedia('(display-mode: standalone)').matches) {
    isIos.value = true
    // 仅在访问过几次后提示（sessionStorage 去重）
    const key = 'supercrzy:pwa-ios-hint'
    const seen = sessionStorage.getItem(key)
    if (!seen) {
      setTimeout(() => { show.value = true }, 8000)
      sessionStorage.setItem(key, '1')
    }
  }
})

async function install() {
  if (!deferredPrompt) { dismiss(); return }
  await deferredPrompt.prompt()
  const choice = await deferredPrompt.userChoice
  deferredPrompt = null
  show.value = false
  if (choice.outcome === 'accepted') console.log('[PWA] installed')
}

function dismiss() {
  show.value = false
  deferredPrompt = null
}
</script>

<style scoped>
.pwa-prompt {
  position: fixed;
  bottom: 18px;
  right: 18px;
  z-index: 1000;
  max-width: 340px;
}
.pwa-body {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-secondary, #f7f7f8);
  border: 1px solid var(--border-color, #e3e3e6);
  border-radius: 12px;
  padding: 10px 12px;
  position: relative;
}
.pwa-icon {
  color: var(--accent, #4f7cff);
  flex-shrink: 0;
}
.pwa-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pwa-title { font-size: 13px; font-weight: 500; color: var(--text-primary, #222); }
.pwa-desc { font-size: 11px; color: var(--text-muted, #888); line-height: 1.5; }
.pwa-install {
  flex-shrink: 0;
  background: var(--accent, #4f7cff);
  color: #fff;
  border: none;
  border-radius: 16px;
  padding: 5px 14px;
  font-size: 12px;
  cursor: pointer;
}
.pwa-install:hover { opacity: 0.92; }
.pwa-close {
  position: absolute;
  top: 6px;
  right: 6px;
  background: transparent;
  border: none;
  color: var(--text-muted, #999);
  cursor: pointer;
  padding: 2px;
  display: flex;
}
.pwa-close:hover { color: var(--text-primary, #222); }
.pwa-fade-enter-active, .pwa-fade-leave-active { transition: opacity .3s, transform .3s; }
.pwa-fade-enter-from, .pwa-fade-leave-to { opacity: 0; transform: translateY(8px); }
</style>
