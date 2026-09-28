<script setup>
import { onMounted, ref } from 'vue'

const props = defineProps({
  item: { type: Object, required: true },
})
const emit = defineEmits(['dismiss'])

const shown = ref(false)
onMounted(() => {
  requestAnimationFrame(() => {
    shown.value = true
  })
})
</script>

<template>
  <div
    class="toast"
    :class="[props.item.type, { show: shown }]"
    :title="props.item.message"
    @click="emit('dismiss', props.item.id)"
  >
    {{ props.item.message }}
  </div>
</template>
