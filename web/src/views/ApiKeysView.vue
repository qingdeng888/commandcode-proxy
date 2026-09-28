<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import { toast } from '../toast'
import { fmtDateTime, fmtNum } from '../utils'

/*
 * 2API Key = 本项目自己签发给**下游客户端**的凭证。
 * 与「上游 Key」（Command Code 的 user_ Key）是两套完全不同的东西，页面里也明确分开。
 * 一次请求：下游客户端 --(2API Key)--> 本代理 --(随机挑一个上游 Key)--> Command Code
 */

const state = reactive({
  list: [],
  counts: { total: 0, enabled: 0 },
  protectionEnabled: false,
  proxyKeySet: false,
  loading: false,
  loaded: false,
})

const form = reactive({ key: '', label: '' })
const busy = reactive({ add: false, rowId: '', revealingId: '', savingId: '' })
const editing = reactive({ id: '', label: '', enabled: true })
const revealed = reactive({})
const justCreated = ref(null)

const enabledCount = computed(() => state.counts.enabled || 0)

async function load() {
  state.loading = true
  try {
    const { data } = await api('GET', '/apikeys')
    state.list = (data && data.keys) || []
    state.counts = (data && data.counts) || { total: 0, enabled: 0 }
    state.protectionEnabled = !!(data && data.protectionEnabled)
    state.proxyKeySet = !!(data && data.proxyKeySet)
    state.loaded = true
  } catch (e) {
    toast.error('加载 2API Key 失败：' + e.message)
  } finally {
    state.loading = false
  }
}

async function add() {
  busy.add = true
  try {
    const { data, message } = await api('POST', '/apikeys', {
      key: form.key.trim() || undefined,
      label: form.label.trim() || undefined,
    })
    // 明文只在创建这一次返回，列表始终脱敏
    justCreated.value = { plainKey: data.plainKey, label: data.key.label, generated: data.generated }
    form.key = ''
    form.label = ''
    await load()
    toast.success(message || '已创建')
  } catch (e) {
    toast.error('创建失败：' + e.message)
  } finally {
    busy.add = false
  }
}

async function toggleEnabled(k, enabled) {
  busy.rowId = k.id
  try {
    await api('POST', '/apikeys/update', { id: k.id, enabled })
    await load()
    toast.success(enabled ? '已启用' : '已禁用（该 Key 立即失效）')
  } catch (e) {
    toast.error('操作失败：' + e.message)
  } finally {
    busy.rowId = ''
  }
}

async function reveal(k) {
  busy.revealingId = k.id
  try {
    const { data } = await api('POST', '/apikeys/reveal', { id: k.id })
    revealed[k.id] = data.key
    setTimeout(() => { delete revealed[k.id] }, 10000)
  } catch (e) {
    toast.error('获取明文失败：' + e.message)
  } finally {
    busy.revealingId = ''
  }
}

async function copy(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label)
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

function startEdit(k) {
  editing.id = k.id
  editing.label = k.label || ''
  editing.enabled = k.enabled !== false
}

async function saveEdit() {
  busy.savingId = editing.id
  try {
    await api('POST', '/apikeys/update', { id: editing.id, label: editing.label, enabled: editing.enabled })
    editing.id = ''
    await load()
    toast.success('已保存')
  } catch (e) {
    toast.error('保存失败：' + e.message)
  } finally {
    busy.savingId = ''
  }
}

async function remove(k) {
  if (!window.confirm(`确定删除该 2API Key 吗？\n${k.label || k.keyMasked}\n\n正在使用它的客户端会立即失效。`)) return
  busy.rowId = k.id
  try {
    await api('POST', '/apikeys/delete', { id: k.id })
    await load()
    toast.success('已删除')
  } catch (e) {
    toast.error('删除失败：' + e.message)
  } finally {
    busy.rowId = ''
  }
}

onMounted(load)
</script>

<template>
  <div>
    <h2>
      🔐 2API Key
      <span class="probe-pill">签发给下游客户端的调用凭证</span>
      <button class="btn btn-sm" style="margin-left: auto" type="button" :disabled="state.loading" @click="load">
        <span v-if="state.loading" class="loading"></span>
        {{ state.loading ? '加载中…' : '🔄 刷新' }}
      </button>
    </h2>

    <!-- 概念说明：这是最容易混的地方，直接摆在最上面 -->
    <div class="section">
      <div class="section-title">📖 两套 Key 的区别</div>
      <div class="section-body">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>上游 Key</th>
                <th>2API Key（本页）</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>是什么</strong></td>
                <td>Command Code 的账号 Key（<code>user_</code> 开头）</td>
                <td>本项目自己签发的 Key（<code>ccp_</code> 开头）</td>
              </tr>
              <tr>
                <td><strong>谁用它</strong></td>
                <td><strong>服务端自己</strong>：代理拿它去调用 Command Code</td>
                <td><strong>下游客户端</strong>：别人拿它来调用本代理</td>
              </tr>
              <tr>
                <td><strong>能给别人吗</strong></td>
                <td class="text-danger">绝对不要 —— 等于把账号送人</td>
                <td class="text-green">可以，本来就是发出去的</td>
              </tr>
              <tr>
                <td><strong>在哪管理</strong></td>
                <td><router-link to="/keys">🔑 上游 Key</router-link></td>
                <td>本页</td>
              </tr>
              <tr>
                <td><strong>为什么要分开</strong></td>
                <td colspan="2">
                  上游 Key 一旦泄露只能整个换号；2API Key 可以按客户端逐个签发，
                  某个客户端泄露只吊销它自己。两者混用会让「谁能调用」和「用谁的账号」纠缠不清。
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="hint" style="margin-top: 10px">
          一次请求的链路：<code>下游客户端 --(2API Key)--> 本代理 --(随机挑一个上游 Key)--> Command Code</code>
        </div>
      </div>
    </div>

    <!-- 当前保护模式 -->
    <div class="section">
      <div class="section-title">
        🛡️ 当前访问保护
        <span class="probe-pill">
          {{ state.protectionEnabled ? '已启用' : '未启用' }}
          · 已签发 {{ fmtNum(state.counts.total) }} 个（启用 {{ fmtNum(enabledCount) }}）
          <template v-if="state.proxyKeySet"> · 另有 proxyKey 单口令</template>
        </span>
      </div>
      <div class="section-body">
        <div v-if="state.protectionEnabled" class="hint">
          客户端必须带有效的 2API Key（或 proxyKey）才能调用 <code>/v1/*</code>；
          上游 Key 由本代理从池中按策略挑选，客户端拿不到。
        </div>
        <div v-else class="hint text-danger">
          <strong>访问保护未启用</strong>：任何能访问到本端口的人都可以借这套代理调用（用他自己的上游 Key）。
          要限制访问，就在下面签发一个 2API Key —— 签发后保护立即生效，无需重启。
        </div>
      </div>
    </div>

    <!-- 签发 -->
    <div class="section">
      <div class="section-title">➕ 签发新的 2API Key</div>
      <div class="section-body">
        <div class="form-row">
          <div class="field">
            <label>标签（可选）</label>
            <input v-model="form.label" type="text" placeholder="例如：给朋友 / 某台服务器" />
          </div>
          <div class="field">
            <label>自定义 Key（留空则自动生成）</label>
            <input v-model="form.key" type="text" placeholder="ccp_…（留空最省事）" class="mono" />
          </div>
          <div class="field" style="flex: 0 0 auto">
            <button class="btn btn-primary" type="button" :disabled="busy.add" @click="add">
              <span v-if="busy.add" class="loading" style="border-top-color: #04121a"></span>
              {{ busy.add ? '签发中…' : '🎲 生成并添加' }}
            </button>
          </div>
        </div>
        <div class="hint">
          留空即随机生成（<code>ccp_</code> 开头）。<strong>明文只在创建后显示这一次</strong>，请立即复制；
          之后列表一律脱敏，需要时可用行内的 👁 再取一次。
        </div>

        <!-- 刚创建的明文：一次性突出显示 -->
        <div v-if="justCreated" class="result-box" style="margin-top: 12px; border-color: rgba(52,211,153,.45)">
          <div class="title text-green">✅ 已创建 —— 请立即复制保存</div>
          <div class="hint">
            {{ justCreated.label || '（无标签）' }}
            <template v-if="justCreated.generated"> · 系统生成</template>
          </div>
          <div class="flex" style="gap: 8px; margin-top: 8px; align-items: center">
            <code class="mono" style="word-break: break-all">{{ justCreated.plainKey }}</code>
            <button class="btn btn-sm" type="button" @click="copy(justCreated.plainKey, '已复制 2API Key')">
              📋 复制
            </button>
            <button class="btn btn-sm" type="button" @click="justCreated = null">收起</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 列表 -->
    <div class="section">
      <div class="section-title">
        📋 已签发的 Key
        <span class="probe-pill">共 {{ fmtNum(state.list.length) }} 个</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Key（脱敏）</th>
              <th>标签</th>
              <th>启用</th>
              <th>请求数</th>
              <th>最后使用</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!state.list.length">
              <td colspan="7" class="empty">
                {{ state.loading ? '加载中…' : '还没有签发任何 2API Key（此时访问保护未启用）' }}
              </td>
            </tr>
            <tr v-for="k in state.list" :key="k.id" :class="{ 'row-disabled': !k.enabled }">
              <td class="mono">
                <template v-if="revealed[k.id]">
                  {{ revealed[k.id] }}
                  <button class="btn btn-sm" style="margin-left: 6px" type="button" @click="copy(revealed[k.id])">📋</button>
                </template>
                <template v-else>{{ k.keyMasked }}</template>
              </td>
              <td>
                <template v-if="editing.id === k.id">
                  <input v-model="editing.label" type="text" style="width: 140px" @keyup.enter="saveEdit" />
                </template>
                <template v-else>{{ k.label || '-' }}</template>
              </td>
              <td>
                <button
                  class="btn btn-sm"
                  type="button"
                  :disabled="busy.rowId === k.id"
                  :title="k.enabled ? '点击禁用（立即失效）' : '点击启用'"
                  @click="toggleEnabled(k, !k.enabled)"
                >
                  <span :class="k.enabled ? 'badge ok' : 'badge muted'">{{ k.enabled ? '已启用' : '已禁用' }}</span>
                </button>
              </td>
              <td class="mono">{{ fmtNum(k.requests || 0) }}</td>
              <td class="mono">{{ k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : '-' }}</td>
              <td class="mono">{{ fmtDateTime(k.createdAt) }}</td>
              <td>
                <div class="flex" style="gap: 4px; flex-wrap: wrap">
                  <button
                    class="btn btn-sm"
                    type="button"
                    title="显示明文（10 秒后自动隐藏）"
                    :disabled="busy.revealingId === k.id"
                    @click="reveal(k)"
                  >👁</button>
                  <template v-if="editing.id === k.id">
                    <button class="btn btn-sm btn-primary" type="button" :disabled="busy.savingId === k.id" @click="saveEdit">保存</button>
                    <button class="btn btn-sm" type="button" @click="editing.id = ''">取消</button>
                  </template>
                  <template v-else>
                    <button class="btn btn-sm" type="button" title="改标签 / 启用状态" @click="startEdit(k)">✏️</button>
                    <button class="btn btn-sm btn-danger" type="button" title="删除" :disabled="busy.rowId === k.id" @click="remove(k)">✕</button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
