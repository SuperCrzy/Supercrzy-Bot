<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="svg-icon"
    :class="`svg-icon--${name}`"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" />
    <circle v-if="circles" v-for="(c, i) in circles" :key="'c'+i" v-bind="c" />
    <line v-if="lines" v-for="(l, i) in lines" :key="'l'+i" v-bind="l" />
    <polyline v-if="polylines" v-for="(p, i) in polylines" :key="'p'+i" v-bind="p" />
    <rect v-if="rects" v-for="(r, i) in rects" :key="'r'+i" v-bind="r" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  name: string
  size?: number
}>(), {
  size: 16,
})

interface IconDef {
  paths?: string[]
  circles?: Array<Record<string, string | number>>
  lines?: Array<Record<string, string | number>>
  polylines?: Array<{ points: string }>
  rects?: Array<Record<string, string | number>>
}

const icons: Record<string, IconDef> = {
  // Navigation & Layout
  'chevron-left': { paths: ['M15 18l-6-6 6-6'] },
  'chevron-right': { paths: ['M9 18l6-6-6-6'] },
  'chevron-down': { paths: ['M6 9l6 6 6-6'] },
  'arrow-left': { paths: ['M19 12H5M12 19l-7-7 7-7'] },
  'arrow-right': { paths: ['M5 12h14M12 5l7 7-7 7'] },
  'send': { paths: ['m22 2-7 20-4-9-9-4z', 'M22 2 11 13'] },
  'plus': { lines: [{ x1: '12', y1: '5', x2: '12', y2: '19' }, { x1: '5', y1: '12', x2: '19', y2: '12' }] },
  'x': { lines: [{ x1: '18', y1: '6', x2: '6', y2: '18' }, { x1: '6', y1: '6', x2: '18', y2: '18' }] },

  // Chat & Message
  'message': { paths: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'] },
  'messages': { paths: ['M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'] },
  'user': { paths: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'], circles: [{ cx: '12', cy: '7', r: '4' }] },

  // Tools & Actions
  'search': { circles: [{ cx: '11', cy: '11', r: '8' }], lines: [{ x1: '21', y1: '21', x2: '16.65', y2: '16.65' }] },
  'file': { paths: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'], polylines: [{ points: '14 2 14 8 20 8' }] },
  'file-text': { paths: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M16 13H8', 'M16 17H8', 'M10 9H8'], polylines: [{ points: '14 2 14 8 20 8' }] },
  'edit': { paths: ['M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7', 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z'] },
  'save': { paths: ['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z'], polylines: [{ points: '17 21 17 13 7 13 7 21' }, { points: '7 3 7 8 15 8' }] },
  'terminal': { polylines: [{ points: '4 17 10 11 4 5' }], lines: [{ x1: '12', y1: '19', x2: '20', y2: '19' }] },
  'globe': { circles: [{ cx: '12', cy: '12', r: '10' }], lines: [{ x1: '2', y1: '12', x2: '22', y2: '12' }], paths: ['M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10'] },

  // System & Status
  'brain': { paths: ['M12 2a4 4 0 0 1 4 4v2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h2V6a4 4 0 0 1 4-4z'] },
  'cpu': { rects: [{ x: '4', y: '4', width: '16', height: '16', rx: '2' }], lines: [{ x1: '9', y1: '9', x2: '9.01', y2: '9' }, { x1: '15', y1: '9', x2: '15.01', y2: '9' }, { x1: '9', y1: '15', x2: '9.01', y2: '15' }, { x1: '15', y1: '15', x2: '15.01', y2: '15' }, { x1: '9', y1: '1', x2: '9', y2: '4' }, { x1: '15', y1: '1', x2: '15', y2: '4' }, { x1: '9', y1: '20', x2: '9', y2: '23' }, { x1: '15', y1: '20', x2: '15', y2: '23' }, { x1: '20', y1: '9', x2: '23', y2: '9' }, { x1: '20', y1: '14', x2: '23', y2: '14' }, { x1: '1', y1: '9', x2: '4', y2: '9' }, { x1: '1', y1: '14', x2: '4', y2: '14' }] },
  'check': { polylines: [{ points: '20 6 9 17 4 12' }] },
  'loader': { paths: ['M12 2v4', 'M12 18v4', 'M4.93 4.93l2.83 2.83', 'M16.24 16.24l2.83 2.83', 'M2 12h4', 'M18 12h4', 'M4.93 19.07l2.83-2.83', 'M16.24 7.76l2.83-2.83'] },
  'clock': { circles: [{ cx: '12', cy: '12', r: '10' }], polylines: [{ points: '12 6 12 12 16 14' }] },
  'zap': { polylines: [{ points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }] },

  // Skills / Categories
  'ghost': { paths: ['M12 3a7 7 0 0 0-7 7v7h14v-7a7 7 0 0 0-7-7z', 'M8 14h.01M16 14h.01', 'M8 17v2M16 17v2'] },
  'code': { polylines: [{ points: '16 18 22 12 16 6' }, { points: '8 6 2 12 8 18' }] },
  'database': { paths: ['M12 2C6.48 2 2 4.02 2 6.5v11C2 19.98 6.48 22 12 22s10-2.02 10-4.5v-11C22 4.02 17.52 2 12 2z', 'M2 6.5C2 8.98 6.48 11 12 11s10-2.02 10-4.5', 'M2 12c0 2.48 4.48 4.5 10 4.5s10-2.02 10-4.5'] },
  'star': { polylines: [{ points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2' }] },
  'layers': { polylines: [{ points: '12 2 2 7 12 12 22 7 12 2' }, { points: '2 17 12 22 22 17' }, { points: '2 12 12 17 22 12' }] },
  'git-branch': { lines: [{ x1: '6', y1: '3', x2: '6', y2: '15' }, { x1: '18', y1: '9', x2: '18', y2: '21' }], circles: [{ cx: '18', cy: '6', r: '3' }, { cx: '6', cy: '18', r: '3' }, { cx: '18', cy: '18', r: '3' }], paths: ['M6 3v6l6 3 6-3V6'] },
  'pen': { paths: ['M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z'] },

  // File types
  'image': { rects: [{ x: '3', y: '3', width: '18', height: '18', rx: '2', ry: '2' }], circles: [{ cx: '8.5', cy: '8.5', r: '1.5' }], polylines: [{ points: '21 15 16 10 5 21' }] },
  'paperclip': { paths: ['m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'] },

  // Theme
  'sun': { circles: [{ cx: '12', cy: '12', r: '5' }], lines: [{ x1: '12', y1: '1', x2: '12', y2: '3' }, { x1: '12', y1: '21', x2: '12', y2: '23' }, { x1: '4.22', y1: '4.22', x2: '5.64', y2: '5.64' }, { x1: '18.36', y1: '18.36', x2: '19.78', y2: '19.78' }, { x1: '1', y1: '12', x2: '3', y2: '12' }, { x1: '21', y1: '12', x2: '23', y2: '12' }, { x1: '4.22', y1: '19.78', x2: '5.64', y2: '18.36' }, { x1: '18.36', y1: '5.64', x2: '19.78', y2: '4.22' }] },
  'moon': { paths: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'] },

  // Info
  'info': { circles: [{ cx: '12', cy: '12', r: '10' }], lines: [{ x1: '12', y1: '16', x2: '12', y2: '12' }, { x1: '12', y1: '8', x2: '12.01', y2: '8' }] },
  'history': { circles: [{ cx: '12', cy: '12', r: '10' }], polylines: [{ points: '12 6 12 12 16 14' }] },
  'activity': { polylines: [{ points: '22 12 18 12 15 21 9 3 6 12 2 12' }] },
  'settings': { circles: [{ cx: '12', cy: '12', r: '3' }], paths: ['M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'] },

  // Misc
  'copy': { rects: [{ x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' }], paths: ['M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'] },
  'download': { paths: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'] },
  'eye': { paths: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'], circles: [{ cx: '12', cy: '12', r: '3' }] },
  'eye-off': { paths: ['M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24'], lines: [{ x1: '1', y1: '1', x2: '23', y2: '23' }] },
  'folder': { paths: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'] },
  'lock': { rects: [{ x: '3', y: '11', width: '18', height: '11', rx: '2', ry: '2' }], paths: ['M7 11V7a5 5 0 0 1 10 0v4'] },
  'monitor': { rects: [{ x: '2', y: '3', width: '20', height: '14', rx: '2', ry: '2' }], lines: [{ x1: '8', y1: '21', x2: '16', y2: '21' }, { x1: '12', y1: '17', x2: '12', y2: '21' }] },
  'plug': { paths: ['M12 22v-5', 'M9 7V2', 'M15 7V2', 'M6 13V8h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z'] },

  // Skill market icons（内置技能库 + 开源市场）
  'review': { circles: [{ cx: '12', cy: '12', r: '10' }], paths: ['m9 12 2 2 4-4'] },
  'bug': { paths: ['M8 2l1.88 1.88M14.12 2L16 4M9 7.13v-1a3 3 0 0 1 6 0v1M12 20a6 6 0 0 0 6-6v-2a6 6 0 0 0-12 0v2a6 6 0 0 0 6 6zM6 8h12M6 12h12'] },
  'link': { paths: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'] },
  'telescope': { paths: ['m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.305-1.23a1 1 0 0 1 .707-1.169l7.555-1.615M13.528 14.825l-4.478 6.075M4.91 14.122l-1.26 4.715a1 1 0 0 0 1.26 1.208l2.35-.5M9.5 2l1.613 2.202M14.5 2l-1.613 2.202', 'M18.2 6.604l.59-.126a1.002 1.002 0 0 1 1.122.73l.335 1.31a1 1 0 0 1-.72 1.194l-3.66.78M13.6 10.87l2.22-4.09 4.46 1.48-2.66 5.02M14.43 11.26 11 19'] },
  'chart': { paths: ['M3 3v18h18'], lines: [{ x1: '7', y1: '16', x2: '7', y2: '10' }, { x1: '12', y1: '16', x2: '12', y2: '6' }, { x1: '17', y1: '16', x2: '17', y2: '12' }] },
  'megaphone': { paths: ['m3 11 18-5v12L3 14v-3z', 'M11.6 16.8a3 3 0 1 1-5.8-1.6'] },
  'languages': { paths: ['m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6'] },
  'git': { paths: ['M6 3v12M18 9v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'] },
  'server': { rects: [{ x: '2', y: '2', width: '20', height: '8', rx: '2' }, { x: '2', y: '14', width: '20', height: '8', rx: '2' }], lines: [{ x1: '6', y1: '6', x2: '6.01', y2: '6' }, { x1: '6', y1: '18', x2: '6.01', y2: '18' }] },
  'regex': { paths: ['M17 3v10M12.67 5.5l8.66 5M12.67 10.5l8.66-5', 'M5 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'] },
  'binoculars': { paths: ['M3 21V10a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v11M15 21V10a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v11M8 21h8M8 9V7a4 4 0 0 1 8 0v2'] },
  'trend': { polylines: [{ points: '3 17 9 11 13 15 21 7' }], paths: ['M21 7h-6M21 7v6'] },
  'clipboard': { paths: ['M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'], rects: [{ x: '8', y: '2', width: '8', height: '4', rx: '1' }] },
  'mail': { rects: [{ x: '2', y: '4', width: '20', height: '16', rx: '2' }], paths: ['m22 7-10 6L2 7'] },
  'table': { rects: [{ x: '3', y: '3', width: '18', height: '18', rx: '2' }], lines: [{ x1: '3', y1: '9', x2: '21', y2: '9' }, { x1: '3', y1: '15', x2: '21', y2: '15' }, { x1: '12', y1: '3', x2: '12', y2: '21' }] },
  'filter': { polylines: [{ points: '22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3' }] },
  'gauge': { paths: ['m12 14 4-4', 'M3.34 19a10 10 0 1 1 17.32 0'] },
  'wifi': { paths: ['M5 13a10 10 0 0 1 14 0', 'M8.5 16.5a5 5 0 0 1 7 0', 'M2 8.82a15 15 0 0 1 20 0', 'M12 20h.01'] },
  'repeat': { paths: ['m17 2 4 4-4 4', 'M3 11v-1a4 4 0 0 1 4-4h14', 'm7 22-4-4 4-4', 'M21 13v1a4 4 0 0 1-4 4H3'] },
}

const iconDef = computed(() => icons[props.name] || { paths: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z'] })

const paths = computed(() => iconDef.value.paths || [])
const circles = computed(() => iconDef.value.circles || [])
const lines = computed(() => iconDef.value.lines || [])
const polylines = computed(() => iconDef.value.polylines || [])
const rects = computed(() => iconDef.value.rects || [])
</script>

<style scoped>
.svg-icon {
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
}
</style>
