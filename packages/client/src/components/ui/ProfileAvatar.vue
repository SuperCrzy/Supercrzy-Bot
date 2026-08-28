<template>
  <span class="profile-avatar" :style="{ width: size + 'px', height: size + 'px', borderRadius: radius + 'px' }">
    <!-- 上传图片 -->
    <img v-if="isImage(avatar)" :src="avatar" alt="" class="pa-img" />
    <!-- 预设几何头像 -->
    <svg v-else-if="avatar && avatar.startsWith('a')" :viewBox="'0 0 64 64'" class="pa-svg">
      <defs>
        <linearGradient :id="gid" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" :stop-color="preset(avatar).c1" />
          <stop offset="100%" :stop-color="preset(avatar).c2" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" :fill="`url(#${gid})`" />
      <g fill="rgba(255,255,255,0.92)">
        <template v-if="avatar === 'a1'"><circle cx="32" cy="24" r="10" /><path d="M14 52 L32 30 L50 52 Z" /></template>
        <template v-else-if="avatar === 'a2'"><circle cx="32" cy="32" r="16" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="6" /><circle cx="32" cy="32" r="5" /></template>
        <template v-else-if="avatar === 'a3'"><path d="M32 8 L52 22 V42 L32 56 L12 42 V22 Z" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="5" /><circle cx="32" cy="32" r="6" /></template>
        <template v-else-if="avatar === 'a4'"><path d="M8 30 Q 20 10 32 30 T 56 30 V 46 Q 44 58 32 46 T 8 46 Z" /></template>
        <template v-else-if="avatar === 'a5'"><path d="M32 10 L54 32 L32 54 L10 32 Z" /><path d="M32 22 L42 32 L32 42 L22 32 Z" fill="rgba(255,255,255,0.55)" /></template>
        <template v-else-if="avatar === 'a6'"><circle cx="24" cy="32" r="12" /><circle cx="40" cy="32" r="12" fill="rgba(255,255,255,0.55)" /></template>
        <template v-else-if="avatar === 'a7'"><rect x="18" y="18" width="28" height="28" rx="6" /><circle cx="44" cy="44" r="9" fill="rgba(255,255,255,0.55)" /></template>
        <template v-else-if="avatar === 'a8'"><path d="M32 10 L37 27 L54 32 L37 37 L32 54 L27 37 L10 32 L27 27 Z" /></template>
      </g>
    </svg>
    <!-- 首字母 fallback -->
    <span v-else class="pa-letter">{{ letter }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  avatar?: string
  name?: string
  size?: number
  radius?: number
}>(), { avatar: '', name: '', size: 28, radius: 7 })

const gid = computed(() => 'pa-g-' + (props.avatar ? props.avatar.replace(/[^a-z0-9]/gi, '') : 'x'))

function isImage(v: string): boolean {
  return v.startsWith('/uploads/') || v.startsWith('http') || v.startsWith('data:image')
}

const PRESETS: Record<string, { c1: string; c2: string }> = {
  a1: { c1: '#6366F1', c2: '#8B5CF6' },   // 靛→紫
  a2: { c1: '#0EA5E9', c2: '#22D3EE' },   // 蓝→青
  a3: { c1: '#F59E0B', c2: '#F97316' },   // 琥珀→橙
  a4: { c1: '#10B981', c2: '#34D399' },   // 翠→绿
  a5: { c1: '#EF4444', c2: '#F87171' },   // 红→粉红
  a6: { c1: '#8B5CF6', c2: '#D946EF' },   // 紫→品红
  a7: { c1: '#0EA5E9', c2: '#6366F1' },   // 蓝→靛
  a8: { c1: '#F59E0B', c2: '#EF4444' },   // 橙→红
}

function preset(id: string): { c1: string; c2: string } {
  return PRESETS[id] || PRESETS.a1
}

const letter = computed(() => {
  const n = props.name || 'U'
  return n.trim().charAt(0).toUpperCase() || 'U'
})
</script>

<style scoped>
.profile-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  overflow: hidden;
  flex-shrink: 0;
  background: linear-gradient(135deg, #4F46E5, #6366F1);
}
.pa-img, .pa-svg {
  width: 100%;
  height: 100%;
  display: block;
}
.pa-img {
  object-fit: cover;
}
.pa-letter {
  color: #fff;
  font-weight: 700;
  font-size: 0.55em;
  line-height: 1;
}
</style>
