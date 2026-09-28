<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import {
  keysState,
  loadKeys,
  loadModels,
  loadStats,
  models,
  now,
  loadTestPrompt,
  refreshModels,
  resetTestPrompt,
  startBatch,
  stats,
  testMessagePayload,
  testPrompt,
} from '../store'
import { toast } from '../toast'
import {
  STRATEGY_LABELS,
  fmtDateTime,
  fmtLatency,
  fmtNum,
  fmtPct,
  fmtTokens,
  fmtUptime,
} from '../utils'
import StatCard from '../components/StatCard.vue'
import TestResultBox from '../components/TestResultBox.vue'

const router = useRouter()

const testMode = ref('model')
const testModel = ref('')
const testKeyId = ref('')
const testKeyInput = ref('')
const testing = ref(false)
const testResult = ref(null)
const refreshing = ref(false)
const statsAt = ref(0)

let statsTimer = null

const d = computed(() => stats.data || {})
const keysInfo = computed(() => d.value.keys || {})
const modelsInfo = computed(() => d.value.models || {})
const requests = computed(() => d.value.requests || {})
const tokens = computed(() => d.value.tokens || {})
const admin = computed(() => d.value.admin || {})

const uptimeText = computed(() => {
  const base = Number(d.value.uptimeSec)
  if (!Number.isFinite(base)) return '-'
  const extra = statsAt.value ? (now.value - statsAt.value) / 1000 : 0
  return fmtUptime(base + Math.max(0, extra))
})

const strategyText = computed(() => STRATEGY_LABELS[d.value.strategy] || d.value.strategy || '-')

const modelOptions = computed(() => models.list || [])
const keyOptions = computed(() => keysState.list || [])

// 下拉里只列**启用**的模型：被禁用的模型测了也是 400，列出来徒增困惑
const selectableModels = computed(() => modelOptions.value.filter((m) => m.enabled !== false))

/**
 * 预选测试模型：
 *  1) 优先用「设置」里配的默认测试模型（models.defaultModel，后端已保证它是启用中的最新值）；
 *  2) 没配就取第一个启用的模型；
 *  3) 用户在下面自己改过就不覆盖（只有当前值不在可选列表里时才重新预选）。
 */
function preselectTestModel() {
  const list = selectableModels.value
  if (!list.length) return
  const preferred = models.defaultModel
  const stillValid = testModel.value && list.some((m) => m.id === testModel.value)
  if (stillValid) return
  testModel.value = (preferred && list.some((m) => m.id === preferred)) ? preferred : list[0].id
}

watch(
  () => [models.list.length, models.defaultModel],
  preselectTestModel,
  { immediate: true },
)

watch(
  () => stats.data,
  (v) => {
    if (v) statsAt.value = Date.now()
  },
)

async function doRefreshStats() {
  await loadStats(true)
}

async function doRefreshModels() {
  refreshing.value = true
  try {
    await refreshModels()
    toast.success(`模型清单已刷新：共 ${models.list.length} 个模型`)
  } catch (e) {
    toast.error('刷新模型失败：' + e.message)
  } finally {
    refreshing.value = false
  }
}

async function doBatchTest() {
  if (!window.confirm('确定对全部模型发起批量测试吗？\n批量测试会向上游逐个发送真实请求。')) return
  try {
    await startBatch({ concurrency: 4 })
    toast.success('批量测试已启动')
    router.push({ name: 'models' })
  } catch (e) {
    toast.error('启动批量测试失败：' + e.message)
  }
}

async function runTest() {
  if (testing.value) return
  if (testMode.value === 'model') {
    if (!testModel.value) {
      toast.error('请选择测试模型')
      return
    }
  } else if (!testKeyInput.value.trim() && !testKeyId.value) {
    toast.error('请选择或输入要测试的 Key')
    return
  }

  testing.value = true
  testResult.value = null
  try {
    let data = null
    if (testMode.value === 'model') {
      const body = { model: testModel.value, ...testMessagePayload() }
      if (testKeyId.value) body.keyId = testKeyId.value
      const res = await api('POST', '/models/test', body)
      data = res.data
    } else {
      const raw = testKeyInput.value.trim()
      const body = { ...(raw ? { key: raw } : { id: testKeyId.value }), ...testMessagePayload() }
      const res = await api('POST', '/keys/test', body)
      data = res.data
    }
    testResult.value = data || null
    if (!data) {
      toast.info('测试完成，但服务端未返回结果')
      return
    }
    if (data.ok) {
      toast.success(`链路正常（${fmtLatency(data.latencyMs)}）`)
    } else if (data.category === 'not_in_plan') {
      toast.warning('Key 有效，但该模型不在套餐内')
    } else {
      toast.error(`测试失败：${data.message || data.category || '未知错误'}`)
    }
  } catch (e) {
    toast.error('测试失败：' + e.message)
  } finally {
    testing.value = false
  }
}

onMounted(() => {
  loadStats()
  loadModels()
  loadKeys()
  loadTestPrompt()
  statsTimer = setInterval(() => loadStats(true), 10000)
})

onUnmounted(() => {
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = null
})
</script>

<template>
  <div>
    <h2>
      📊 仪表盘
      <span class="probe-pill">每 10 秒自动刷新</span>
      <button class="btn btn-sm" style="margin-left: auto" type="button" @click="doRefreshStats">🔄 刷新</button>
    </h2>

    <div v-if="stats.error" class="result-box" style="border-color: rgba(248,113,113,.4)">
      <div class="title text-danger">❌ 统计加载失败</div>
      <div class="hint">{{ stats.error }}</div>
    </div>

    <div class="cards">
      <StatCard :value="fmtNum(keysInfo.total)" label="Key 总数" tone="blue" :sub="`启用 ${fmtNum(keysInfo.enabled)} / 冷却 ${fmtNum(keysInfo.cooldown)}`" />
      <StatCard :value="fmtNum(keysInfo.enabled)" label="启用中" tone="green" :sub="`共 ${fmtNum(keysInfo.total)} 个 Key`" />
      <StatCard :value="fmtNum(keysInfo.cooldown)" label="冷却中" tone="yellow" :sub="`异常 ${fmtNum(keysInfo.unhealthy)}`" />
      <StatCard :value="fmtNum(keysInfo.unhealthy)" label="异常 Key" tone="red" sub="需人工检查" />
      <StatCard :value="fmtNum(requests.today)" label="今日请求" tone="blue" :sub="`累计 ${fmtNum(requests.total)}`" />
      <StatCard :value="fmtNum(requests.failedToday)" label="今日失败" tone="red" :sub="`进行中 ${fmtNum(requests.inflight)}`" />
      <StatCard
        :value="`${fmtTokens(tokens.inToday)} / ${fmtTokens(tokens.outToday)}`"
        label="今日 Tokens"
        tone="yellow"
        :sub="`输入 / 输出 · 缓存命中 ${fmtPct(tokens.cacheHitRateToday)}（${fmtTokens(tokens.cacheReadToday)}）· 累计 ${fmtTokens(tokens.inTotal)} / ${fmtTokens(tokens.outTotal)}`"
      />
      <StatCard
        :value="fmtNum(modelsInfo.total)"
        label="模型总数"
        tone="green"
        :sub="`同步于 ${fmtDateTime(modelsInfo.lastSyncAt)}`"
      />
    </div>

    <div class="section">
      <div class="section-title">📋 快捷操作</div>
      <div class="section-body">
        <div class="form-actions">
          <button class="btn btn-primary" type="button" @click="router.push({ name: 'keys' })">➕ 去添加 Key</button>
          <button class="btn" type="button" :disabled="refreshing" @click="doRefreshModels">
            <span v-if="refreshing" class="loading"></span>
            {{ refreshing ? '刷新中…' : '🔄 刷新模型' }}
          </button>
          <button class="btn btn-success" type="button" @click="doBatchTest">
            🧪 批量测试
          </button>
        </div>
        <div class="hint">
          批量测试会在「模型」页显示实时进度与分类汇总结果。
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        🧪 上游连通性测试
        <span class="probe-pill">向本代理发起一次真实请求，验证整个链路是否正常</span>
      </div>
      <div class="tabs">
        <button class="tab" :class="{ active: testMode === 'model' }" type="button" @click="testMode = 'model'">
          按模型测试
        </button>
        <button class="tab" :class="{ active: testMode === 'key' }" type="button" @click="testMode = 'key'">
          按 Key 测试
        </button>
      </div>
      <div class="section-body">
        <div v-if="testMode === 'model'" class="form-row">
          <div class="field">
            <label>测试模型</label>
            <select v-model="testModel">
              <option v-if="!selectableModels.length" value="">（没有启用的模型，请先同步并启用）</option>
              <option v-for="m in selectableModels" :key="m.id" :value="m.id">
                {{ m.id }}{{ m.id === models.defaultModel ? '（默认）' : '' }}
              </option>
            </select>
          </div>
          <div class="field">
            <label>使用 Key（可选）</label>
            <select v-model="testKeyId">
              <option value="">自动选择可用 Key</option>
              <option v-for="k in keyOptions" :key="k.id" :value="k.id">
                {{ k.label || k.keyMasked }}（{{ k.keyMasked }}）
              </option>
            </select>
          </div>
        </div>

        <div v-else class="form-row">
          <div class="field">
            <label>选择已保存的 Key</label>
            <select v-model="testKeyId" :disabled="!!testKeyInput.trim()">
              <option value="">（未选择）</option>
              <option v-for="k in keyOptions" :key="k.id" :value="k.id">
                {{ k.label || k.keyMasked }}（{{ k.keyMasked }}）
              </option>
            </select>
          </div>
          <div class="field">
            <label>或直接输入 Key（可选）</label>
            <input v-model="testKeyInput" type="text" placeholder="user_…（填写后优先使用）" class="mono" />
          </div>
        </div>

        <div class="form-row">
          <div class="field" style="flex: 1 1 100%">
            <label>
              测试消息
              <button class="btn btn-sm" type="button" style="margin-left: 8px" @click="resetTestPrompt">
                ↺ 恢复默认
              </button>
            </label>
            <input
              v-model="testPrompt.message"
              type="text"
              :maxlength="testPrompt.maxLen"
              placeholder="留空则使用默认提示词"
            />
            <div class="hint" style="margin-top: 6px">
              默认与参考项目一致：<code>{{ testPrompt.defaultMessage }}</code>；可改成任意内容用于验证链路。
            </div>
          </div>
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" type="button" :disabled="testing" @click="runTest">
            <span v-if="testing" class="loading" style="border-top-color: #04121a"></span>
            {{ testing ? '测试中…' : '🚀 发送测试请求' }}
          </button>
        </div>

        <TestResultBox v-if="testResult" :result="testResult" />
        <div v-else class="hint">选择模型或 Key 后点击按钮，将向上游发起一次真实的最小请求。</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">ℹ️ 运行信息</div>
      <div class="section-body">
        <dl class="kv">
          <dt>引擎版本</dt>
          <dd class="mono">{{ d.version || '-' }}</dd>
          <dt>运行时长</dt>
          <dd class="mono">{{ uptimeText }}</dd>
          <dt>轮询策略</dt>
          <dd>{{ strategyText }}</dd>
          <dt>上游地址</dt>
          <dd class="mono">{{ admin.address || '-' }}</dd>
          <dt>数据目录</dt>
          <dd class="mono">{{ admin.dataDir || '-' }}</dd>
          <dt>模型上次同步</dt>
          <dd class="mono">{{ fmtDateTime(modelsInfo.lastSyncAt) }}</dd>
          <dt>模型同步状态</dt>
          <dd>
            <span class="badge" :class="modelsInfo.syncing ? 'warn' : 'ok'">
              {{ modelsInfo.syncing ? '同步中' : '空闲' }}
            </span>
          </dd>
          <dt>进行中请求</dt>
          <dd class="mono">{{ fmtNum(requests.inflight) }}</dd>
        </dl>
      </div>
    </div>
  </div>
</template>
