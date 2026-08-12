<template>
  <n-config-provider :locale="naiveLocale" :theme="theme" :theme-overrides="themeOverrides">
    <n-notification-provider>
      <n-message-provider>
        <n-dialog-provider>
          <n-loading-bar-provider>
            <router-view />
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

const appStore = useAppStore()
const { locale } = useI18n({ useScope: 'global' })

const naiveLocale = computed(() => locale.value === 'en-US' ? enUS : zhCN)

const theme = computed(() => appStore.darkMode ? darkTheme : null)

const themeOverrides = {
  common: {
    primaryColor: '#4F46E5',
    primaryColorHover: '#6366F1',
    primaryColorPressed: '#4338CA',
  },
}
</script>
