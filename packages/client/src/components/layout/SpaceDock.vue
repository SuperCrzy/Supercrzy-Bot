<!--
  Mobile space dock (2026-11-13).

  One pill plus one orb; the orb swaps ends when the space changes, so the dock always
  reads as "a dot and a line". Shape borrowed from ZA Bank App 3.0 (bank / invest are two
  spaces toggled by a single orb); material borrowed from the site's mobile dock
  (`.mobile-dock`): outer pill + inner pill for the active item.

  Why two spaces instead of one flat row of tabs:
    - Media (Home/News/Lab/Rank) and BOT (chat/collab/automations/skills) are two separate
      businesses. Flattened, the dock would need eight slots and users could not tell which
      items belong together.
    - A single orb makes "you can go back" self-evident; no extra back button needed.
    - Four tabs per space fits exactly, and neither space constrains the other.

  🔴 Mobile only: desktop keeps MainLayout's left rail, unchanged.
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import SvgIcon from '@/components/ui/SvgIcon.vue'

const { t } = useI18n({ useScope: 'global' })
const route = useRoute()
const router = useRouter()

interface DockTab {
  to: string
  icon: string
  label: string
  /** Route names this tab owns (including sub-routes), used for the active state. */
  names: string[]
}

/** Media space: the content business. Icons are the site dock's own marks (dock-*). */
const MEDIA_TABS: DockTab[] = [
  { to: '/home', icon: 'dock-home', label: 'nav.home', names: ['Home'] },
  // Short labels on purpose: the dock has ~70px per slot at 375px, and `nav.news`
  // ("AI 资讯" / "AI News") gets ellipsised into meaninglessness there.
  { to: '/news', icon: 'dock-news', label: 'nav.newsShort', names: ['News'] },
  { to: '/lab', icon: 'dock-lab', label: 'nav.lab', names: ['Lab'] },
  { to: '/rank', icon: 'dock-rank', label: 'nav.rank', names: ['Rank'] },
]

/** BOT space: the work business. The site has no equivalents for these, so use the app's. */
const BOT_TABS: DockTab[] = [
  { to: '/', icon: 'message', label: 'nav.chat', names: ['Chat'] },
  { to: '/collab', icon: 'super', label: 'nav.collabShort', names: ['Collab'] },
  { to: '/automations', icon: 'clock', label: 'nav.autoExec', names: ['Automations', 'Routines'] },
  // "Settings" (not "Skills"/"Me"): one door for everything the app configures — model,
  // permissions, usage, logs and the signed-in account with sign-out. Skills stay in the
  // composer's + sheet; the site account page handles subscription and history.
  { to: '/settings', icon: 'settings', label: 'nav.settings', names: ['Settings', 'Models', 'Logs', 'Usage', 'Gateway', 'ImagesSettings', 'Memory'] },
]

const MEDIA_NAMES = new Set(MEDIA_TABS.flatMap((x) => x.names))

/**
 * Which space we are in.
 *
 * Derived from the route name rather than kept as separate state — except while a switch is
 * in flight: routing to a heavy view (ChatView) blocks the main thread for ~100ms, and if the
 * dock waited for that, the animation would start late and read as "nothing happened, then it
 * jumped". `pendingSpace` starts the slide immediately; the route catches up behind it.
 */
const pendingSpace = ref<'media' | 'bot' | null>(null)
const space = computed<'media' | 'bot'>(() =>
  pendingSpace.value ?? (MEDIA_NAMES.has(String(route.name || '')) ? 'media' : 'bot'),
)

function isActive(tab: DockTab): boolean {
  return tab.names.includes(String(route.name || ''))
}

/** The orb: media → BOT, BOT → media. Landing target is each space's first tab. */
async function switchSpace() {
  const next = space.value === 'media' ? 'bot' : 'media'
  pendingSpace.value = next
  try {
    await router.push(next === 'media' ? '/home' : '/')
  } finally {
    // Release the optimistic value once the route has settled, so the URL stays the truth.
    window.setTimeout(() => { pendingSpace.value = null }, 360)
  }
}
</script>

<template>
  <div class="space-dock" :class="`is-${space}`">
    <!-- Both tab groups live in one track at 200% width; switching spaces slides the track
         and the pill together. Swapping the list in place (what it used to do) made the
         pill glide while its contents teleported. -->
    <nav class="dock-pill" :aria-label="t('nav.mobileNav')">
      <div class="dock-track" :class="`track-${space}`">
        <div class="dock-group">
          <router-link
            v-for="tab in MEDIA_TABS"
            :key="tab.to"
            :to="tab.to"
            class="dock-item"
            :class="{ active: isActive(tab) }"
          >
            <SvgIcon :name="tab.icon" :size="19" />
            <span class="dock-label">{{ t(tab.label) }}</span>
          </router-link>
        </div>
        <div class="dock-group">
          <router-link
            v-for="tab in BOT_TABS"
            :key="tab.to"
            :to="tab.to"
            class="dock-item"
            :class="{ active: isActive(tab) }"
          >
            <SvgIcon :name="tab.icon" :size="19" />
            <span class="dock-label">{{ t(tab.label) }}</span>
          </router-link>
        </div>
      </div>
    </nav>

    <!-- The orb moves between the two ends; only its icon and meaning change, never the
         element itself — replacing it would break the transition. -->
    <button
      class="dock-orb"
      type="button"
      :aria-label="space === 'media' ? t('nav.toBot') : t('nav.toMedia')"
      @click="switchSpace"
    >
      <SvgIcon :name="space === 'media' ? 'dock-bot' : 'dock-home'" :size="17" />
      <!-- Same icon-over-label rhythm as the tabs beside it: without a label the orb is the
           only unlabelled thing in the dock, and it reads as decoration rather than a door. -->
      <span class="dock-orb-label">{{ space === 'media' ? 'BOT' : t('nav.home') }}</span>
    </button>
  </div>
</template>

<style scoped>
/* The container only positions; pill and orb are both absolute, and the "swap" is a
   left/right transition. Do not switch to `flex-direction: row-reverse` — that flips
   instantly and the motion disappears. */
.space-dock {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  width: min(calc(100% - 24px), 520px);
  height: 56px;
  z-index: 60;
  pointer-events: none;
}

.dock-pill {
  position: absolute;
  top: 0;
  height: 56px;
  overflow: hidden;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: var(--bg-elevated);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(24px) saturate(1.4);
  pointer-events: auto;
  transition: left 320ms cubic-bezier(0.32, 0.72, 0, 1), right 320ms cubic-bezier(0.32, 0.72, 0, 1);
}
.is-media .dock-pill { left: 0; right: 64px; }
.is-bot .dock-pill { left: 64px; right: 0; }

/* The track holds both groups side by side and slides as one piece. */
.dock-track {
  display: flex;
  width: 200%;
  height: 100%;
  transition: transform 320ms cubic-bezier(0.32, 0.72, 0, 1);
  will-change: transform;
}
.track-media { transform: translateX(0); }
.track-bot { transform: translateX(-50%); }

.dock-group {
  flex: 0 0 50%;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px;
  box-sizing: border-box;
}

.dock-item {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 2px;
  border-radius: 999px;
  color: var(--text-muted);
  text-decoration: none;
  transition: color 180ms ease, background 180ms ease;
}
.dock-item.active {
  color: var(--accent);
  background: var(--accent-subtle);
}
.dock-label {
  font-size: 10px;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.dock-orb {
  position: absolute;
  top: 0;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  border: none;
  background: var(--accent);
  color: #fff;
  box-shadow: 0 8px 24px rgba(79, 70, 229, 0.35);
  cursor: pointer;
  pointer-events: auto;
  z-index: 2;
  transition: left 320ms cubic-bezier(0.32, 0.72, 0, 1), transform 180ms ease;
}
.dock-orb-label {
  font-size: 8.5px;
  line-height: 1;
  letter-spacing: 0.02em;
  opacity: 0.92;
}
.is-media .dock-orb { left: calc(100% - 56px); }
.is-bot .dock-orb { left: 0; }
.dock-orb:active { transform: scale(0.94); }

@media (prefers-reduced-motion: reduce) {
  .dock-pill, .dock-orb { transition: none; }
}
</style>
