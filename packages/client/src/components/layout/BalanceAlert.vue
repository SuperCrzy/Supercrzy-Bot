<template>
  <!-- 无渲染：只在启动时查一次余额，低了给一条 toast -->
</template>

<script setup lang="ts">
/**
 * 低余额提醒（2026-10-22）
 *
 * 老板的原话是「API 余额低于 5 元，提醒用户充值」，但要的是**别打扰**：
 * 这里只在 App 启动时查一次（后端 5 分钟缓存，前端不会每次进页面都打），
 * 低了弹一条 8 秒自动消失的 warning toast —— 不是模态框，不拦操作。
 * 每次启动最多一次（模块级 shown 标记）：反复提醒等于噪音，真正需要长期可见的信息
 * 在用量页那条余额栏里一直挂着。
 */
import { onMounted } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'

const message = useMessage()
const { t } = useI18n({ useScope: 'global' })

// 模块级：同一次运行里组件重新挂载也不重复弹
let shown = false

onMounted(async () => {
  if (shown) return
  try {
    const res = await fetch('/api/stats/balance')
    if (!res.ok) return
    const data = await res.json()
    if (data?.supported !== true || data?.low !== true) return
    shown = true
    const cny = (data.balances || []).find((b: any) => b.currency === 'CNY') || (data.balances || [])[0]
    const amount = cny ? `¥${Number(cny.total).toFixed(2)}` : t('usage.balanceUnavailable')
    message.warning(
      t('usage.balanceLowToast', { amount, n: data.thresholdCny ?? 5 }),
      { duration: 8000 },
    )
  } catch {
    // 查余额失败静默：这是提示，不是功能
  }
})
</script>
