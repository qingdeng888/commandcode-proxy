<script setup>
import { auth } from './store'
import ToastHost from './components/ToastHost.vue'
</script>

<template>
  <div v-if="!auth.ready" class="boot">
    <span class="loading"></span>
    <span>正在校验登录状态…</span>
  </div>
  <router-view v-else />
  <ToastHost />
</template>
