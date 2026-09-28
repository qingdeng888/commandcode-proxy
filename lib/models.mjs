// ── 模型目录 + 模型测试 ────────────────────────────────
// 目录来自 Command Code 上游 GET /provider/v1/models（实测 82 个模型），
// 每个模型带 context_length 与 supported_endpoints —— 旧的 fetchModels 只取了 id/name，
// 把有用的元数据丢掉了，这里完整保留。
//
// 「模型测试」的设计说明：
// 参考项目 Cline-proxy 用「余额差值探测」判断模型是否收费（跑一次模型，看账户余额掉没掉）。
// 这个机制在 Command Code 上**无法照搬**：实测 /provider/v1/usage、/provider/v1/balance、
// /api/v1/users/me 全部 404，CC 不暴露任何余额/用量接口。
// 因此改为 CC 原生做法：发一次真实最小请求，按上游返回的 error.code 归类。
import { CFG } from './config.mjs';
import { dataPath, readJSON, writeJSONAtomic } from './store.mjs';

export const TESTS_PATH = dataPath('model-tests.json');

/** 上游错误 → 分类。顺序重要：业务码优先于 HTTP 状态码。 */
export function classifyProbe({ ok = false, httpStatus = null, bodyText = '', networkError = null } = {}) {
  if (networkError) return 'network';
  const text = String(bodyText || '');
  const upper = text.toUpperCase();

  // 模型维度：不在套餐内。绝不能因此把 Key 判为失效。
  if (upper.includes('MODEL_NOT_IN_PLAN')) return 'not_in_plan';
  if (upper.includes('USAGE_EXCEEDED') || upper.includes('QUOTA')) return 'quota';
  if (upper.includes('UNAUTHORIZED')) return 'unauthorized';

  if (ok) return 'ok';
  if (httpStatus === 401 || httpStatus === 403) {
    // 403 也可能是「不在套餐内」，但上面已按业务码筛过；到这里按鉴权失败处理更贴近 CC 语义
    return httpStatus === 401 ? 'unauthorized' : 'error';
  }
  if (httpStatus === 429) return 'quota';
  if (httpStatus === 402) return 'quota';
  return 'error';
}

export const CATEGORY_LABELS = {
  ok: '正常',
  unauthorized: 'Key 无效',
  quota: '额度用尽',
  not_in_plan: '不在套餐内',
  network: '网络异常',
  error: '上游错误',
};

export function createModelCatalog({ fetchImpl, staticModels = [], log = () => {} }) {
  let cache = null;          // [{ id, name, contextLength, supportedEndpoints, source }]
  let lastSyncAt = 0;        // 只记录**成功**同步的时刻；0 = 从未成功
  let lastAttemptAt = 0;     // 上次尝试的时刻（成功或失败），用于失败退避
  let syncing = false;
  let lastError = null;
  let inflight = null;

  // 失败后的重试间隔。取一个较短的值：启动时没 Key 是很常见的状态，
  // 用户在后台补上 Key 之后应当很快就能看到真实目录，而不是等满一个缓存周期。
  const RETRY_DELAY_MS = 30 * 1000;

  function ttl() {
    const ms = Number(CFG.modelRefreshIntervalMs);
    return Number.isFinite(ms) && ms > 0 ? ms : 5 * 60 * 1000;
  }

  function staticList() {
    return (staticModels || []).map(m => ({
      id: m.id, name: m.name || m.id, contextLength: null,
      supportedEndpoints: null, source: 'static',
    }));
  }

  function normalize(raw) {
    const out = [];
    for (const m of raw) {
      if (!m || typeof m.id !== 'string' || !m.id) continue;
      out.push({
        id: m.id,
        name: typeof m.name === 'string' && m.name ? m.name : m.id,
        contextLength: Number.isFinite(m.context_length) ? m.context_length : null,
        supportedEndpoints: Array.isArray(m.supported_endpoints) ? m.supported_endpoints : null,
        source: 'upstream',
      });
    }
    return out;
  }

  /** 缓存是不是「一次成功同步之后仍在有效期内」 */
  function isFresh() {
    return !!cache && lastSyncAt > 0 && (Date.now() - lastSyncAt) < ttl();
  }

  async function sync({ apiKey, force = false } = {}) {
    if (isFresh() && !force) return cache;
    if (inflight) return inflight;   // 单飞：并发刷新只发一次上游请求

    // ── 前置校验必须放在创建 inflight 之前 ──────────────────
    // 这里踩过一个很隐蔽的坑：若把校验写进下面的 async IIFE，而校验又是**同步抛出**的，
    // 那么 IIFE 会在 `inflight = (...)()` 赋值之前就跑完 finally 把 inflight 置空，
    // 紧接着赋值又把一个「已完成」的 promise 写回 inflight。此后每次 sync 都命中
    // `if (inflight) return inflight`，永远返回那份静态列表 —— 表现为
    // 「后台加了 Key，模型页却永远停在静态列表，且上游从未收到过任何请求」。
    const fail = (message) => {
      lastError = message;
      lastAttemptAt = Date.now();
      log('warn', '模型目录同步失败，沿用现有缓存或静态列表', { error: message });
      // 回退到静态列表时**不能**把 lastSyncAt 设为当前时间，否则这次失败会被当成
      // 「刚同步成功」，把后续真正的同步挡在 TTL 之外。
      if (!cache) cache = staticList();
      return cache;
    };

    if (!CFG.useProviderModels) {
      return fail('useProviderModels 已关闭（CC_USE_PROVIDER_MODELS=false）');
    }
    // 失败退避：避免「没有 Key」时每个后台请求都去打一次上游。
    // 但若上次失败的原因就是没 Key、而现在有 Key 了，必须立刻放行 ——
    // 否则用户刚在后台加完 Key，还要干等退避窗口才看得到真实模型列表。
    const blockedByRetryDelay = !force && lastAttemptAt
      && (Date.now() - lastAttemptAt) < RETRY_DELAY_MS
      && !(apiKey && lastError && lastError.includes('没有可用的上游 Key'));
    if (blockedByRetryDelay) return cache ?? staticList();
    if (!apiKey) {
      return fail('没有可用的上游 Key，无法拉取模型目录');
    }

    const run = (async () => {
      syncing = true;
      lastAttemptAt = Date.now();
      try {
        const response = await fetchImpl(`${CFG.apiBase}/provider/v1/models`, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'x-cli-environment': 'production',
            'x-command-code-version': undefined,   // 由 fetchImpl 内部补齐
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status} ${String(text).slice(0, 200)}`);
        }
        const data = await response.json();
        if (!Array.isArray(data?.data)) throw new Error('响应缺少 data 数组');
        const models = normalize(data.data);
        if (models.length === 0) throw new Error('上游返回空模型列表');
        cache = models;
        lastSyncAt = Date.now();
        lastError = null;
        log('info', '模型目录已同步', { count: models.length });
        return cache;
      } catch (e) {
        lastError = e.message;
        log('warn', '模型目录同步失败，沿用现有缓存或静态列表', { error: e.message });
        if (!cache) cache = staticList();
        return cache;
      } finally {
        syncing = false;
      }
    })();

    inflight = run;
    // 双保险：即使 run 已经 settle（同步路径），也在微任务里清掉 inflight
    const clear = () => { if (inflight === run) inflight = null; };
    run.then(clear, clear);
    return run;
  }

  function list() {
    return cache ?? [];
  }

  function get(id) {
    return list().find(m => m.id === id) || null;
  }

  function ensureFresh(apiKey) {
    if (!isFresh()) sync({ apiKey }).catch(() => {});
  }

  function defaultModel() {
    const models = list();
    if (models.length === 0) return '';
    if (CFG.defaultModel && models.some(m => m.id === CFG.defaultModel)) return CFG.defaultModel;
    return models[0].id;
  }

  function describe() {
    return {
      models: list(),
      lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
      nextSyncInSec: lastSyncAt ? Math.max(0, Math.round((lastSyncAt + ttl() - Date.now()) / 1000)) : 0,
      syncing,
      lastError,
      ttlMs: ttl(),
      // 是否拿到了真实的上游目录（否则就是静态回退列表）
      fromUpstream: lastSyncAt > 0,
    };
  }

  return {
    sync, ensureFresh, list, get, defaultModel, describe, CATEGORY_LABELS, isFresh,
    get lastError() { return lastError; },
    get fromUpstream() { return lastSyncAt > 0; },
  };
}

/**
 * 批量模型测试任务。
 * 串行会太慢（82 个模型 × 1~3s），全并发又会把上游打成风控靶子，
 * 因此用受限并发 + 任务级取消。进度通过 status() 轮询。
 */
export function createModelTestRunner({ probe, log = () => {}, concurrency = 3, persist = true }) {
  let job = null;

  const persistResults = (results) => {
    if (!persist) return;
    try {
      writeJSONAtomic(TESTS_PATH, {
        updatedAt: new Date().toISOString(),
        results: results.slice(-500),
      }, 0o600);
    } catch (e) {
      log('warn', '模型测试结果写盘失败', { error: e.message });
    }
  };

  function summarize(results) {
    const s = { ok: 0, unauthorized: 0, quota: 0, not_in_plan: 0, network: 0, error: 0 };
    for (const r of results) s[r.category] = (s[r.category] || 0) + 1;
    return s;
  }

  async function run({ models, keyId = null, message = undefined, onProgress = null, limit = 3 } = {}) {
    if (!job || !job.running) {
      job = {
        jobId: `j_${Date.now().toString(36)}`,
        running: true, cancelled: false,
        startedAt: new Date().toISOString(), finishedAt: null,
        total: models.length, done: 0,
        results: [], summary: summarize([]),
      };
    }
    const current = job;
    const queue = [...models];
    const workers = [];
    const width = Math.max(1, Math.min(limit, 8));

    for (let i = 0; i < width; i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          if (current.cancelled) return;
          const model = queue.shift();
          let result;
          try {
            result = await probe({ model, keyId, message });
          } catch (e) {
            result = {
              model, ok: false, category: 'error', latencyMs: null, httpStatus: null,
              message: String(e.message || e).slice(0, 300), keyId, checkedAt: new Date().toISOString(),
            };
          }
          current.results.push(result);
          current.done++;
          current.summary = summarize(current.results);
          if (onProgress) onProgress(current);
        }
      })());
    }

    await Promise.all(workers);
    current.running = false;
    current.finishedAt = new Date().toISOString();
    persistResults(current.results);
    log('info', '模型批量测试结束', { jobId: current.jobId, total: current.total, summary: current.summary });
    return current;
  }

  function status() {
    if (!job) return { running: false, jobId: null, startedAt: null, finishedAt: null, total: 0, done: 0, results: [], summary: summarize([]) };
    return {
      running: job.running,
      jobId: job.jobId,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      total: job.total,
      done: job.done,
      results: job.results,
      summary: job.summary,
    };
  }

  function cancel() {
    if (!job || !job.running) return { ok: false, error: '当前没有进行中的测试任务' };
    job.cancelled = true;
    log('info', '模型批量测试已被取消', { jobId: job.jobId, done: job.done, total: job.total });
    return { ok: true };
  }

  /** 上次落盘的结果，用于重启后回显 */
  function loadLast() {
    return readJSON(TESTS_PATH, null, null);
  }

  return { run, status, cancel, loadLast, get busy() { return !!job?.running; } };
}
