/**
 * M1 (2026-11-13): the navigation half of the composer "+" menu — entries that LEAVE the
 * chat for a capability page (automations / skills library / MCP / memory). Kept out of
 * ChatView so the 5500-line gate keeps headroom; labels and icons are built here.
 *
 * Distinguish from the "技能" entry that stays in ChatView: that one injects @skill into
 * the input, while "技能库" navigates to the management page.
 */
import { h } from 'vue'
import type { VNodeChild } from 'vue'
import type { DropdownOption } from 'naive-ui'

type Translate = (key: string) => string

export const PLUS_NAV_TARGETS: Record<string, string> = {
  'goto-automations': '/automations',
  'goto-skills': '/skills',
  'goto-mcp': '/settings?section=mcp',
  'goto-memory': '/memory',
}

function navIcon(children: never[]): () => VNodeChild {
  return () =>
    h(
      'svg',
      { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' },
      children,
    )
}

export function plusNavOptions(t: Translate): DropdownOption[] {
  return [
    { type: 'divider', key: 'nav-divider' },
    {
      label: t('nav.automations'),
      key: 'goto-automations',
      icon: navIcon([h('circle', { cx: '12', cy: '12', r: '10' }), h('polyline', { points: '12 6 12 12 16 14' })] as never[]),
    },
    {
      label: t('nav.skills') + t('chat.plusSkillLibSuffix'),
      key: 'goto-skills',
      icon: navIcon([h('path', { d: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' })] as never[]),
    },
    {
      label: t('settings.tabMcp'),
      key: 'goto-mcp',
      icon: navIcon([h('path', { d: 'M9 6h6M7 12h10M9 18h6' }), h('circle', { cx: '12', cy: '12', r: '10' })] as never[]),
    },
    {
      label: t('nav.memory'),
      key: 'goto-memory',
      icon: navIcon([h('path', { d: 'M9 18h6M10 21h4' }), h('path', { d: 'M12 3a6 6 0 0 0-4 10c1 .8 1 1.6 1 2.5h6c0-.9 0-1.7 1-2.5a6 6 0 0 0-4-10z' })] as never[]),
    },
  ]
}
