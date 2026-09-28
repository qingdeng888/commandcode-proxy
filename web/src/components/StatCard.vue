<script setup>
defineProps({
  value: { type: [String, Number], default: '-' },
  label: { type: String, default: '' },
  tone: { type: String, default: 'blue' },
  sub: { type: String, default: '' },
  hint: { type: String, default: '' },
})
</script>

<template>
  <div class="card">
    <div class="num" :class="tone" :title="hint">{{ value }}</div>
    <div class="label">{{ label }}</div>
    <div v-if="sub" class="sub" :title="sub">{{ sub }}</div>
  </div>
</template>
