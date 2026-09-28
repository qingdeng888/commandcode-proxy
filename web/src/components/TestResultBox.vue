<script setup>
import { computed } from 'vue'
import { fmtDateTime, fmtLatency } from '../utils'
import CategoryBadge from './CategoryBadge.vue'

const props = defineProps({
  result: { type: Object, required: true },
  title: { type: String, default: '测试结果' },
})

const isNotInPlan = computed(() => props.result.category === 'not_in_plan')
const ok = computed(() => props.result.ok === true)
const headline = computed(() => {
  if (ok.value) return '✅ 链路正常'
  if (isNotInPlan.value) return '⚠️ Key 有效，但该模型不在套餐内'
  return '❌ 链路异常'
})
</script>

<template>
  <div class="result-box">
    <div v-if="title" class="probe-pill" style="margin-bottom: 4px">{{ title }}</div>
    <div class="title" :class="ok ? 'text-green' : isNotInPlan ? 'text-amber' : 'text-danger'">
      {{ headline }}
    </div>
    <div class="flex" style="flex-wrap: wrap; gap: 10px">
      <CategoryBadge :category="result.category" />
      <span class="stat-mini">耗时 {{ fmtLatency(result.latencyMs) }}</span>
      <span v-if="result.httpStatus !== undefined && result.httpStatus !== null" class="stat-mini">
        HTTP {{ result.httpStatus }}
      </span>
      <span v-if="result.model" class="stat-mini">模型 {{ result.model }}</span>
      <span v-if="result.keyId" class="stat-mini">Key {{ result.keyId }}</span>
      <span v-if="result.checkedAt" class="stat-mini">检测于 {{ fmtDateTime(result.checkedAt) }}</span>
    </div>
    <div class="hint">{{ result.message || '（上游未返回说明）' }}</div>
    <pre
      v-if="result.outputPreview"
      class="log-data"
      style="margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px"
    >{{ result.outputPreview }}</pre>
  </div>
</template>
