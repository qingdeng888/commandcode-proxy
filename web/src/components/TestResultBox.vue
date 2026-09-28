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
// 正文为空但模型确实思考了：把思考内容也展示出来 ——
// 否则用户只看到「没有返回内容」，完全不知道模型在干什么
const reasoning = computed(() => props.result.reasoning || '')
const onlyReasoning = computed(() => !reply.value && !!reasoning.value)
const tokenText = computed(() => {
  const u = props.result.usage
  if (!u) return ''
  const inTok = u.inputTokens ?? u.input_tokens
  const outTok = u.outputTokens ?? u.output_tokens
  if (inTok === undefined && outTok === undefined) return ''
  return `tokens 入 ${fmtNum(inTok ?? 0)} / 出 ${fmtNum(outTok ?? 0)}`
})

const reasoningChars = computed(() => props.result.reasoningChars || reasoning.value.length)

async function copyReasoning() {
  try {
    await navigator.clipboard.writeText(reasoning.value)
    toast.success('已复制思考内容')
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

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
      <span v-if="result.model" class="stat-mini">请求模型 {{ result.model }}</span>
      <span
        v-if="result.upstreamModel"
        class="stat-mini"
        :class="result.modelMatched === false ? 'text-danger' : 'text-green'"
        :title="result.modelMatched === false ? '上游实际服务的模型与请求的不一致，请检查路由' : '上游回报的实际模型，与请求一致'"
      >
        上游实际服务 {{ result.upstreamModel }}<template v-if="result.upstreamProvider"> @ {{ result.upstreamProvider }}</template>
        {{ result.modelMatched === false ? '⚠️ 不一致' : '✓' }}
      </span>
      <span v-if="result.keyId" class="stat-mini">Key {{ result.keyId }}</span>
      <span v-if="tokenText" class="stat-mini">{{ tokenText }}</span>
      <span v-if="result.finishReason" class="stat-mini">finish {{ result.finishReason }}</span>
      <span v-if="result.checkedAt" class="stat-mini">检测于 {{ fmtDateTime(result.checkedAt) }}</span>
    </div>
    <div class="hint">{{ result.message || '（上游未返回说明）' }}</div>
    <div v-if="result.upstreamModel" class="hint" style="margin-top: 2px">
      以上「上游实际服务」由上游回报的元数据得出，是核实路由是否命中的可靠依据；
      模型**自述**「我是什么模型」不具参考性（实测同一模型会时而说 DeepSeek、时而说 Claude）。
    </div>
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
    <!-- 只有思考、没有正文：把思考内容摊开，让用户看到模型到底在做什么 -->
    <div
      v-else-if="onlyReasoning"
      style="margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px"
    >
      <div class="justify-between" style="align-items: center">
        <span class="stat-mini">
          思考过程（模型没有产出正文）
          <span class="badge warn" style="margin-left: 6px">{{ reasoningChars }} 字</span>
        </span>
        <button class="btn btn-sm" type="button" @click="copyReasoning">📋 复制思考</button>
      </div>
      <pre class="log-data reply-text">{{ reasoning }}</pre>
      <div class="hint" style="margin-top: 4px">
        模型把整个 token 上限用在了思考上，没轮到正文。这不是链路故障 ——
        换个更短的问题通常就能看到回答。
      </div>
    </div>
    <div v-else-if="ok" class="hint" style="margin-top: 6px">
      （上游既没发正文也没发思考内容，只确认了链路可用）
    </div>
  </div>
</template>
