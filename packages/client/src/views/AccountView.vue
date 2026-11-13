<!--
  Site account (profile / subscription / reading history) — the site's own /account page.

  Deliberately different from the BOT space's "Me" (app settings): one account system, two
  different jobs. The site page manages the subscription and reading history; the app page
  manages models, permissions and usage. Pointing both buttons at the same settings screen is
  what made them feel duplicated.
-->
<script setup lang="ts">
import SiteFrame from '@/components/layout/SiteFrame.vue'
</script>

<template>
  <SiteFrame path="/account" />
</template>
