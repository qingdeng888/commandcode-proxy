<script setup>
import { computed } from 'vue'
import { fmtDateTime, fmtLatency, fmtNum } from '../utils'
import { toast } from '../toast'
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

// 模型的实际回答：单次测试会带 output（完整），批量只有 outputPreview（短）
const reply = computed(() => props.result.output || props.result.outputPreview || '')
const tokenText = computed(() => {
  const u = props.result.usage
  if (!u) return ''
  const inTok = u.inputTokens ?? u.input_tokens
  const outTok = u.outputTokens ?? u.output_tokens
  if (inTok === undefined && outTok === undefined) return ''
  return `tokens 入 ${fmtNum(inTok ?? 0)} / 出 ${fmtNum(outTok ?? 0)}`
})

async function copyReply() {
  try {
    await navigator.clipboard.writeText(reply.value)
    toast.success('已复制模型回答')
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}
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
      <span v-if="tokenText" class="stat-mini">{{ tokenText }}</span>
      <span v-if="result.finishReason" class="stat-mini">finish {{ result.finishReason }}</span>
      <span v-if="result.checkedAt" class="stat-mini">检测于 {{ fmtDateTime(result.checkedAt) }}</span>
    </div>
    <div class="hint">{{ result.message || '（上游未返回说明）' }}</div>
    <div v-if="result.prompt" class="hint" style="margin-top: 4px">
      发送内容：<code>{{ result.prompt }}</code>
    </div>

    <!-- 模型的实际回答：完整展示，过长时可滚动 -->
    <div v-if="reply" style="margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px">
      <div class="justify-between" style="align-items: center">
        <span class="stat-mini">
          模型回答
          <span v-if="result.truncated" class="badge warn" style="margin-left: 6px">已截断</span>
        </span>
        <button class="btn btn-sm" type="button" @click="copyReply">📋 复制回答</button>
      </div>
      <pre class="log-data reply-text">{{ reply }}</pre>
      <div v-if="result.truncated" class="hint" style="margin-top: 4px">
        回答未收完：<template v-if="result.finishReason === 'max_tokens'">达到 token 上限</template>
        <template v-else>内容较长，仅保留前面一段</template>。
      </div>
    </div>
    <div v-else-if="ok" class="hint" style="margin-top: 6px">
      （上游没有返回文本内容，只确认了链路可用）
    </div>
  </div>
</template>
