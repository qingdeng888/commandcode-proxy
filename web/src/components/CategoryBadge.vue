<script setup>
import { computed } from 'vue'
import { categoryLabel, categoryTone, categoryDetail } from '../utils'

const props = defineProps({
  category: { type: String, default: '' },
  label: { type: String, default: '' },
  message: { type: String, default: '' },
})

const text = computed(() => props.label || categoryLabel(props.category))
const tone = computed(() => categoryTone(props.category))
const title = computed(() => categoryDetail(props.category, props.message || categoryLabel(props.category)))
</script>

<template>
  <span class="badge" :class="tone" :title="title">{{ text }}</span>
</template>
