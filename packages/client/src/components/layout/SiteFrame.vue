<!--
  Embeds one of the site's own mobile pages instead of re-implementing it.

  Why: every page on supercrzy.com is already responsive and already carries the mobile dock,
  the CRAZE reading lens and the article typography. Rebuilding any of that here would drift
  from the site the moment the site changes — and it is not our content to redesign.

  How it works: the page is fetched through /site (our own origin, see routes/site.ts) because
  the site sends `X-Frame-Options: DENY` and cannot be framed from anywhere else.

  Why the frame is taller than its box and clipped, rather than styled from the inside: the
  site's own scripts rewrite its chrome on load, so an injected stylesheet gets undone. Clipping
  is a decision made entirely on our side — it keeps working no matter what the page does.
  The top strip holds the site header, the bottom strip its dock.
-->
<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'

const props = defineProps<{ path: string }>()
const { t } = useI18n({ useScope: 'global' })
const app = useAppStore()
const router = useRouter()

const SITE = 'https://supercrzy.com'
/** Same-origin proxy served by our own backend — see routes/site.ts. */
const PROXY = '/site'

// Strips trimmed off the embedded page: site header on top, site dock on the bottom.
const CLIP_TOP = 56
const CLIP_BOTTOM = 88

const loading = ref(true)
const failed = ref(false)
const frame = ref<HTMLIFrameElement | null>(null)

/**
 * The site themes itself with `data-theme` on its <html>; the app uses `html.dark`.
 * Sync ours into the frame on every load and on every toggle — otherwise a dark app wraps
 * a light embedded page (or the reverse), which reads as two apps glued together.
 */
function syncTheme() {
  const doc = frame.value?.contentDocument
  doc?.documentElement?.setAttribute('data-theme', app.darkMode ? 'dark' : 'light')
}
function syncThemeSoon() {
  window.setTimeout(syncTheme, 120)
}

/**
 * M2: the "hand it to the BOT" bridge. On an article page (/news/<slug>, /lab/<slug>) inject
 * a floating button that pushes a deep-research prompt through the SAME channel NewsView
 * uses (?research= → ChatView pre-fills and sends). Same-origin makes this possible — this
 * is the capability that justifies the embed over a plain browser tab.
 */
function injectResearchFab() {
  const doc = frame.value?.contentDocument
  if (!doc) return
  const isArticle = /^\/(news|lab)\/.+$/.test(doc.location.pathname)
  const existing = doc.getElementById('sc-research-fab')
  if (!isArticle) {
    existing?.remove()
    return
  }
  if (existing) return
  if (!doc.getElementById('sc-fab-style')) {
    const style = doc.createElement('style')
    style.id = 'sc-fab-style'
    style.textContent = `#sc-research-fab{position:fixed;right:16px;bottom:96px;z-index:60;
      display:flex;align-items:center;gap:6px;padding:10px 16px;border:none;border-radius:999px;
      background:linear-gradient(135deg,#4263ff,#36b3ff);color:#fff;font-size:13px;font-weight:600;
      box-shadow:0 6px 20px rgba(66,99,255,.4);cursor:pointer}`
    doc.head?.appendChild(style)
  }
  const btn = doc.createElement('button')
  btn.id = 'sc-research-fab'
  btn.textContent = t('news.deepResearch')
  btn.addEventListener('click', () => {
    const title = doc.querySelector('h1')?.textContent?.trim() || doc.title.replace(/[-–|]\s*SUPERCRZY.*$/i, '').trim()
    const url = doc.location.href
    const query = `深度研究这条新闻并给出判断：${title}\n来源：${url}\n请用深度研究能力交叉全网信息，分析这件事的来龙去脉、影响和相关方，输出带来源的完整报告。`
    router.push({ path: '/', query: { research: query } })
  })
  doc.body.appendChild(btn)
}

/** Never let the spinner outlive the page by much: a slow CMS render must not look like a hang. */
onMounted(() => {
  window.setTimeout(() => { loading.value = false }, 3000)
})

watch(() => app.darkMode, () => syncThemeSoon())

/**
 * Dismiss the site's cookie banner.
 *
 * It is injected by the site's own script (not present in the HTML we proxy), sits fixed over
 * the content and reappears on every load, so a stylesheet can't reliably hide it. Clicking the
 * real "Accept All" button is what a visitor would do anyway, and it stops the banner recurring.
 */
function dismissCookieBanner() {
  const doc = document.querySelector<HTMLIFrameElement>('.site-iframe')?.contentDocument
  if (!doc) return
  const banner = doc.getElementById('cookieBanner')
  if (!banner) return
  const btn = Array.from(banner.querySelectorAll('button')).find((b) =>
    /accept all/i.test(b.textContent || ''),
  )
  if (btn) (btn as HTMLButtonElement).click()
  else banner.remove()
}

function onLoad() {
  loading.value = false
  syncThemeSoon()
  injectResearchFab()
  // The banner is created slightly after load, so try a few times instead of once.
  for (const ms of [200, 600, 1200, 2000]) window.setTimeout(dismissCookieBanner, ms)
}
function onError() {
  loading.value = false
  failed.value = true
}
</script>

<template>
  <div class="site-frame">
    <iframe
      v-if="!failed"
      class="site-iframe"
      :src="`${PROXY}${props.path}`"
      referrerpolicy="no-referrer"
      loading="eager"
      :style="{
        top: `-${CLIP_TOP}px`,
        height: `calc(100% + ${CLIP_TOP + CLIP_BOTTOM}px)`,
        clipPath: `inset(${CLIP_TOP}px 0 ${CLIP_BOTTOM}px 0)`,
      }"
      @load="onLoad"
      @error="onError"
    />
    <div v-if="loading" class="site-state">{{ t('common.loading') }}</div>
    <div v-else-if="failed" class="site-state">
      <p>{{ t('common.siteUnreachable') }}</p>
      <a :href="`${SITE}${props.path}`" target="_blank" rel="noopener">{{ t('common.openOnSite') }}</a>
    </div>
  </div>
</template>

<style scoped>
.site-frame {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg-primary);
}
.site-iframe {
  position: absolute;
  left: 0;
  width: 100%;
  border: 0;
  display: block;
}
.site-state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  font-size: 13px;
  text-align: center;
  color: var(--text-tertiary);
}
.site-state a {
  font-size: 12.5px;
  color: var(--accent);
}
</style>
