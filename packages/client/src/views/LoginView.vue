<template>
  <div class="login-screen">
    <div class="login-lang" role="group" :aria-label="t('account.language')">
      <button
        type="button"
        :class="['login-lang-btn', { active: locale === 'zh-CN' }]"
        @click="setLocale('zh-CN')"
      >中文</button>
      <span class="login-lang-sep" aria-hidden="true">/</span>
      <button
        type="button"
        :class="['login-lang-btn', { active: locale === 'en-US' }]"
        @click="setLocale('en-US')"
      >English</button>
    </div>
    <div class="login-card">
      <div class="login-brand">
        <img class="login-logo" src="/logo-96.png" alt="" width="40" height="40" />
        <span class="login-brand-text">SUPERCRZY BOT</span>
      </div>

      <h1 class="login-title">{{ t('account.loginTitle') }}</h1>
      <p class="login-subtitle">{{ t('account.loginSubtitle') }}</p>

      <button
        v-if="phase !== 'waiting'"
        type="button"
        class="login-primary"
        :disabled="phase === 'starting'"
        @click="beginLogin"
      >
        {{ phase === 'starting' ? t('account.opening') : t('account.loginButton') }}
      </button>

      <div v-else class="login-waiting">
        <span class="login-spinner" aria-hidden="true"></span>
        <p class="login-waiting-text">{{ t('account.waiting') }}</p>
        <p class="login-waiting-hint">{{ t('account.waitingHint') }}</p>
      </div>

      <p v-if="phase === 'timeout'" class="login-note warn">{{ t('account.timeout') }}</p>
      <p v-if="phase === 'error'" class="login-note warn">{{ t('account.error') }}</p>

      <a v-if="fallbackUrl" class="login-fallback" :href="fallbackUrl" target="_blank" rel="noreferrer">
        {{ t('account.openManually') }}
      </a>

      <!-- Sits right under the button on purpose: a first-time user decides
           here whether this screen needs a sign-up they have not done yet. -->
      <p class="login-hint">{{ t('account.needAccount') }}</p>

      <div class="login-foot">
        <p class="login-links">
          <a href="https://supercrzy.com/privacy" target="_blank" rel="noreferrer">{{ t('account.privacy') }}</a>
          <span aria-hidden="true">·</span>
          <a href="https://supercrzy.com/terms" target="_blank" rel="noreferrer">{{ t('account.terms') }}</a>
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAccountStore } from '@/stores/account'

const { t, locale } = useI18n({ useScope: 'global' })
const router = useRouter()
const account = useAccountStore()

type Phase = 'idle' | 'starting' | 'waiting' | 'timeout' | 'error'
const phase = ref<Phase>('idle')

// The app requires sign-in, so this screen is the only place a reader can flip
// the language before reaching Settings. The choice persists under the same key
// SettingsView uses.
function setLocale(next: 'zh-CN' | 'en-US'): void {
  locale.value = next
  try { localStorage.setItem('supercrzy-lang', next) } catch { /* private mode */ }
  try { document.documentElement.lang = next } catch { /* ignore */ }
}

// The document shell ships lang="zh-CN"; screen readers and hyphenation both
// key off it, so keep it in sync with the active locale from the first render.
watch(locale, (value) => {
  document.title = `${t('nav.login')} - SUPERCRZY BOT`
  document.documentElement.lang = value
}, { immediate: true })
const fallbackUrl = ref('')

const POLL_MS = 1500
const DEADLINE_MS = 3 * 60 * 1000

let pollTimer: number | null = null
let deadlineTimer: number | null = null

function stopPolling(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer)
  if (deadlineTimer !== null) window.clearTimeout(deadlineTimer)
  pollTimer = null
  deadlineTimer = null
}

async function beginLogin(): Promise<void> {
  if (phase.value === 'starting' || phase.value === 'waiting') return
  phase.value = 'starting'
  stopPolling()
  try {
    fallbackUrl.value = await account.startLogin()
    phase.value = 'waiting'
    // The browser now owns the flow; the callback lands on our own backend, so
    // polling status is the only thing this window has to do.
    pollTimer = window.setInterval(async () => {
      await account.reload()
      if (account.signedIn) {
        stopPolling()
        router.replace({ name: 'Chat' })
      }
    }, POLL_MS)
    deadlineTimer = window.setTimeout(() => {
      stopPolling()
      phase.value = 'timeout'
    }, DEADLINE_MS)
  } catch {
    phase.value = 'error'
  }
}

onUnmounted(stopPolling)
</script>

<style scoped>
.login-screen {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px 15vh;
  background: var(--bg-primary);
}

.login-card {
  width: 100%;
  max-width: 400px;
  display: flex;
  flex-direction: column;
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 26px;
}
.login-logo {
  width: 40px;
  height: 40px;
  display: block;
  flex-shrink: 0;
}
.login-brand-text {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.13em;
  color: var(--text-secondary);
}

.login-title {
  margin: 0 0 10px;
  font-size: 24px;
  line-height: 1.28;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.login-subtitle {
  margin: 0 0 30px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.login-primary {
  height: 42px;
  border: none;
  border-radius: 10px;
  background: var(--accent);
  color: #ffffff;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 160ms ease, opacity 160ms ease;
}

.login-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.login-primary:disabled {
  opacity: 0.6;
  cursor: default;
}

.login-waiting {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
}

.login-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent);
  animation: login-spin 700ms linear infinite;
}

@keyframes login-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .login-spinner { animation-duration: 2400ms; }
}

.login-waiting-text {
  margin: 0;
  font-size: 13.5px;
  color: var(--text-primary);
}

.login-waiting-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.login-note {
  margin: 14px 0 0;
  font-size: 12.5px;
  line-height: 1.55;
}

.login-note.warn {
  color: #b45309;
}

.login-fallback {
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--accent);
  text-decoration: none;
}

.login-fallback:hover {
  text-decoration: underline;
}

.login-foot {
  margin-top: 26px;
  padding-top: 14px;
  border-top: 1px solid var(--border-color);
}

.login-hint {
  margin: 16px 0 0;
  font-size: 13px;
  line-height: 1.62;
  color: var(--text-secondary);
}

.login-links {
  margin: 0;
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.login-links a {
  color: var(--text-muted);
  text-decoration: none;
}

.login-links a:hover {
  color: var(--text-secondary);
}

.login-lang {
  position: absolute;
  top: 20px;
  right: 22px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.login-lang-btn {
  background: none;
  border: none;
  padding: 2px 4px;
  font-family: inherit;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
}
.login-lang-btn:hover { color: var(--text-secondary); }
.login-lang-btn.active { color: var(--text-primary); font-weight: 600; }
.login-lang-sep { color: var(--border-color); }
</style>
