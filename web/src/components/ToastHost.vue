<script setup>
import { toastState, dismissToast } from '../toast'
import ToastItem from './ToastItem.vue'
</script>

<template>
  <div class="toast-wrap">
    <ToastItem
      v-for="t in toastState.items"
      :key="t.id"
      :item="t"
      @dismiss="dismissToast"
    />
  </div>
</template>
