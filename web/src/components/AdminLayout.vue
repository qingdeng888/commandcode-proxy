<script setup>
import AppSidebar from './AppSidebar.vue'
</script>

<template>
  <div class="layout">
    <AppSidebar />
    <div class="main">
      <router-view />
    </div>
  </div>
</template>
