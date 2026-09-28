<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import {
  batch,
  cancelBatch,
  ensureBatchPolling,
  keysState,
  loadKeys,
  loadModels,
  models,
  loadTestPrompt,
  pollBatchOnce,
  refreshModels,
  resetTestPrompt,
  startBatch,
  testMessagePayload,
  testPrompt,
} from '../store'
import { toast } from '../toast'
import {
  CATEGORY_ORDER,
  categoryLabel,
  fmtContext,
  fmtDateTime,
  fmtLatency,
  fmtNum,
} from '../utils'
import CategoryBadge from '../components/CategoryBadge.vue'

const rowTests = reactive({})
const testingModel = ref('')
const refreshing = ref(false)
const canceling = ref(false)
const testKeyId = ref('')
const concurrency = ref(4)
const showAllResults = ref(false)

const list = computed(() => models.list || [])
const keyOptions = computed(() => keysState.list || [])

const batchByModel = computed(() => {
  const map = {}
  ;(batch.results || []).forEach((r) => {
    if (r && r.model) map[r.model] = r
  })
  return map
})

const progressPct = computed(() => (batch.total ? Math.min(100, Math.round((batch.done / batch.total) * 100)) : 0))
const visibleResults = computed(() =>
  showAllResults.value ? batch.results || [] : (batch.results || []).slice(0, 20),
)

function resultFor(m) {
  return rowTests[m.id] || batchByModel.value[m.id] || null
}

function sourceLabel(src) {
  if (!src) return '-'
  const map = { upstream: '上游', config: '配置', builtin: '内置', fallback: '回退' }
  return map[src] || src
}

async function doRefresh() {
  refreshing.value = true
  try {
    await refreshModels()
    toast.success(`模型清单已刷新：共 ${list.value.length} 个模型`)
  } catch (e) {
    toast.error('刷新模型失败：' + e.message)
  } finally {
    refreshing.value = false
  }
}

async function testOne(m) {
  if (testingModel.value) return
  testingModel.value = m.id
  try {
    const body = { model: m.id, ...testMessagePayload() }
    if (testKeyId.value) body.keyId = testKeyId.value
    const { data } = await api('POST', '/models/test', body)
    if (!data) {
      toast.info('测试完成，但服务端未返回结果')
      return
    }
    rowTests[m.id] = data
    if (data.ok) {
      toast.success(`${m.id} 测试通过（${fmtLatency(data.latencyMs)}）`)
    } else if (data.category === 'not_in_plan') {
      toast.warning('Key 有效，但该模型不在套餐内')
    } else {
      toast.error(`${m.id} 测试失败：${data.message || categoryLabel(data.category)}`)
    }
  } catch (e) {
    toast.error('模型测试失败：' + e.message)
  } finally {
    testingModel.value = ''
  }
}

async function doBatchTest() {
  const count = list.value.length
  if (!window.confirm(`确定发起批量测试吗？\n将逐个向上游发送真实请求（当前目录 ${count} 个模型），会消耗真实额度。`)) return
  try {
    const payload = { concurrency: Math.max(1, Number(concurrency.value) || 4), ...testMessagePayload() }
    if (testKeyId.value) payload.keyId = testKeyId.value
    await startBatch(payload)
    toast.success('批量测试已启动')
  } catch (e) {
    toast.error('启动批量测试失败：' + e.message)
  }
}

async function doCancel() {
  if (!window.confirm('确定取消批量测试吗？')) return
  canceling.value = true
  try {
    await cancelBatch()
    toast.info('已取消批量测试')
  } catch (e) {
    toast.error('取消失败：' + e.message)
  } finally {
    canceling.value = false
  }
}

onMounted(() => {
  loadTestPrompt()
  loadModels()
  loadKeys()
  ensureBatchPolling()
  pollBatchOnce()
})
</script>

<template>
  <div>
    <h2>
      🧠 模型
      <span class="probe-pill">
        共 {{ fmtNum(list.length) }} 个 · 上次同步 {{ fmtDateTime(models.lastSyncAt) }}
        <template v-if="models.syncing"> · 同步中…</template>
        <template v-else-if="models.nextSyncInSec"> · {{ fmtNum(models.nextSyncInSec) }}s 后自动同步</template>
      </span>
      <button class="btn btn-sm" style="margin-left: auto" type="button" :disabled="refreshing" @click="doRefresh">
        <span v-if="refreshing" class="loading"></span>
        {{ refreshing ? '刷新中…' : '🔄 刷新模型' }}
      </button>
    </h2>

    <div v-if="models.error" class="result-box" style="border-color: rgba(248,113,113,.4)">
      <div class="title text-danger">❌ 模型目录加载失败</div>
      <div class="hint">{{ models.error }}</div>
    </div>

    <div class="section">
      <div class="section-title">
        🧪 批量测试
        <span class="probe-pill">实时进度 · 按分类汇总 · 可取消</span>
      </div>
      <div class="section-body">
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
              单模型测试与批量测试都用这条消息；默认：<code>{{ testPrompt.defaultMessage }}</code>
            </div>
          </div>
        </div>

        <div class="form-row">
          <div class="field">
            <label>测试使用 Key（可选）</label>
            <select v-model="testKeyId">
              <option value="">自动选择可用 Key</option>
              <option v-for="k in keyOptions" :key="k.id" :value="k.id">
                {{ k.label || k.keyMasked }}（{{ k.keyMasked }}）
              </option>
            </select>
          </div>
          <div class="field narrow">
            <label>并发数</label>
            <input v-model="concurrency" type="number" min="1" max="16" />
          </div>
          <div class="field" style="flex: 0 0 auto">
            <button class="btn btn-primary" type="button" :disabled="batch.starting || batch.running" @click="doBatchTest">
              <span v-if="batch.starting" class="loading" style="border-top-color: #04121a"></span>
              {{ batch.starting ? '启动中…' : batch.running ? '测试进行中…' : '🚀 开始批量测试' }}
            </button>
          </div>
        </div>

        <div v-if="batch.loaded" class="result-box">
          <div class="justify-between">
            <div class="title" :class="batch.running ? 'text-accent' : 'text-green'">
              {{ batch.running ? '⏳ 批量测试进行中' : '✅ 批量测试已结束' }}
            </div>
            <button
              v-if="batch.running"
              class="btn btn-sm btn-danger"
              type="button"
              :disabled="canceling"
              @click="doCancel"
            >
              {{ canceling ? '取消中…' : '⛔ 取消测试' }}
            </button>
          </div>

          <div class="flex" style="flex-wrap: wrap; gap: 12px; margin-top: 4px">
            <span class="stat-mini">进度 {{ fmtNum(batch.done) }} / {{ fmtNum(batch.total) }}（{{ progressPct }}%）</span>
            <span v-if="batch.jobId" class="stat-mini">任务 {{ batch.jobId }}</span>
            <span v-if="batch.startedAt" class="stat-mini">开始 {{ fmtDateTime(batch.startedAt) }}</span>
            <span v-if="batch.finishedAt" class="stat-mini">结束 {{ fmtDateTime(batch.finishedAt) }}</span>
          </div>

          <div class="progress"><i :style="{ width: progressPct + '%' }"></i></div>

          <div class="flex" style="flex-wrap: wrap; gap: 8px">
            <span
              v-for="c in CATEGORY_ORDER"
              :key="c"
              class="badge"
              :class="batch.summary[c] ? (c === 'ok' ? 'ok' : c === 'not_in_plan' || c === 'quota' ? 'warn' : 'danger') : 'muted'"
            >
              {{ categoryLabel(c) }} {{ fmtNum(batch.summary[c] || 0) }}
            </span>
          </div>

          <div v-if="batch.error" class="hint text-danger">进度获取失败：{{ batch.error }}</div>

          <div v-if="batch.results.length" class="table-wrap" style="margin-top: 12px; max-height: 320px; overflow: auto">
            <table>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>结果</th>
                  <th>耗时</th>
                  <th>Key</th>
                  <th>说明</th>
                  <th>检测时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in visibleResults" :key="r.model">
                  <td class="mono">{{ r.model }}</td>
                  <td><CategoryBadge :category="r.category" :message="r.message" /></td>
                  <td class="mono">{{ fmtLatency(r.latencyMs) }}</td>
                  <td class="mono">{{ r.keyId || '-' }}</td>
                  <td style="white-space: normal; max-width: 340px">{{ r.message || '-' }}</td>
                  <td class="mono">{{ fmtDateTime(r.checkedAt) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="batch.results.length > visibleResults.length" class="form-actions">
              <button class="btn btn-sm" type="button" @click="showAllResults = true">
                显示全部 {{ fmtNum(batch.results.length) }} 条
              </button>
            </div>
            <div v-else-if="showAllResults && batch.results.length > 20" class="form-actions">
              <button class="btn btn-sm" type="button" @click="showAllResults = false">仅显示前 20 条</button>
            </div>
          </div>
        </div>
        <div v-else class="hint">批量测试会逐个调用上游模型，结果按 category 分类汇总；测试期间可随时取消。</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        🧠 模型目录
        <span class="probe-pill">来自上游 /provider/v1/models（缓存）</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>模型 ID</th>
              <th>名称</th>
              <th>上下文</th>
              <th>支持端点</th>
              <th>来源</th>
              <th>测试结果</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!list.length">
              <td colspan="7" class="empty">{{ models.loading ? '加载中…' : '暂无模型，请点击「刷新模型」' }}</td>
            </tr>
            <tr v-for="m in list" :key="m.id">
              <td class="mono">{{ m.id }}</td>
              <td>{{ m.name || '-' }}</td>
              <td class="mono">{{ fmtContext(m.contextLength) }}</td>
              <td>
                <div class="chips">
                  <span v-for="ep in m.supportedEndpoints || []" :key="ep" class="model-tag">{{ ep }}</span>
                  <span v-if="!(m.supportedEndpoints || []).length" class="text-dim">-</span>
                </div>
              </td>
              <td><span class="model-tag">{{ sourceLabel(m.source) }}</span></td>
              <td>
                <template v-if="resultFor(m)">
                  <CategoryBadge :category="resultFor(m).category" :message="resultFor(m).message" />
                  <div class="text-dim" style="font-size: 11px">
                    {{ fmtLatency(resultFor(m).latencyMs) }}
                    <span v-if="resultFor(m).checkedAt"> · {{ fmtDateTime(resultFor(m).checkedAt) }}</span>
                  </div>
                </template>
                <span v-else class="text-dim">-</span>
              </td>
              <td>
                <button
                  class="btn btn-sm"
                  type="button"
                  title="对该模型发起一次真实测试"
                  :disabled="testingModel === m.id"
                  @click="testOne(m)"
                >
                  <span v-if="testingModel === m.id" class="loading"></span>
                  <span v-else>⚡ 测试</span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
