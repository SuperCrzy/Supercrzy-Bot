<template>
  <n-config-provider :locale="naiveLocale" :theme="theme" :theme-overrides="themeOverrides">
    <n-notification-provider>
      <n-message-provider>
        <n-dialog-provider>
          <n-loading-bar-provider>
            <router-view />
            <!-- PWA 安装引导（桌面可安装 + iOS 添加到主屏幕） -->
            <InstallPrompt />
          </n-loading-bar-provider>
        </n-dialog-provider>
      </n-message-provider>
    </n-notification-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { zhCN, enUS, darkTheme } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import InstallPrompt from '@/components/layout/InstallPrompt.vue'

const appStore = useAppStore()
const { locale } = useI18n({ useScope: 'global' })

const naiveLocale = computed(() => locale.value === 'en-US' ? enUS : zhCN)

// 同步切换：CSS 变量（html.dark）与 NaiveUI darkTheme 同帧生效，不做延迟分层
const theme = computed(() => appStore.darkMode ? darkTheme : null)

const themeOverrides = computed(() => ({
  common: {
    primaryColor: '#4F46E5',
    primaryColorHover: '#6366F1',
    primaryColorPressed: '#4338CA',
    // 背景跟随全局 token：浅色纯白 / 深色纯黑
    bodyColor: appStore.darkMode ? '#000000' : '#ffffff',
    cardColor: appStore.darkMode ? '#0d0d0d' : '#ffffff',
    modalColor: appStore.darkMode ? '#0d0d0d' : '#ffffff',
    popoverColor: appStore.darkMode ? '#0d0d0d' : '#ffffff',
  },
  // 输入框 focus 边框颜色不变（与默认边框同色，老板 2026-08-21：聚焦边框变化不需要）
  // 背景 + 边框：白模式浅灰底（比页面白深一档）+ 中灰边框；黑模式底比页面亮一档 + 亮灰边框——
  // 避免"白底浅框 / 黑底黑框"在白色/黑色页面上隐形（设置页/弹窗等所有 naive 输入框通用；聊天输入框 .chat-input 有 :deep 覆盖不受影响）
  Input: {
    color: appStore.darkMode ? '#1c1c22' : '#f4f4f5',
    border: appStore.darkMode ? '#3a3a42' : '#b8b8c0',
    borderFocus: appStore.darkMode ? '#3a3a42' : '#b8b8c0',
    borderHover: appStore.darkMode ? '#3a3a42' : '#b8b8c0',
    boxShadowFocus: 'none',
    boxShadowHover: 'none',
  },
}))
</script>
