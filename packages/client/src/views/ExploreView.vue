<!--
  Content search — the site's own /search page, embedded (see SiteFrame).

  The app already has /search, but that one searches chat history; the site's searches
  articles, lab reviews and rankings, server-rendered with All / News / LAB / Rankings
  buckets. Two different jobs, so two different pages — the media space points here.
-->
<script setup lang="ts">
import SiteFrame from '@/components/layout/SiteFrame.vue'
</script>

<template>
  <SiteFrame path="/search" />
</template>
