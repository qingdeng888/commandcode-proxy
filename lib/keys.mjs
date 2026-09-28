// ── 上游 Key 池 ───────────────────────────────────────
// 一个 Key = 一个 Command Code 账号（`user_` 开头的静态 Key，没有 refresh token）。
//
// 三种来源，合并成一个轮询池：
//   ui     后台添加 → 存在 data/keys.json，可增删改、可启停
//   config 来自 config.json 的 apiKey（历史字段）→ 只读
//   env    来自 CC_API_KEY 环境变量（优先级最高）→ 只读
// 只读来源不允许在后台删除/禁用（会明确报错），但可以「导入」为 ui 来源。
//
// 热加载：池的状态全在内存，后台任何写操作立即改内存 + 防抖落盘，
// 下一个请求就能用到 —— 不需要重启，也不需要 fs.watch。
import { randomBytes, createHash } from 'crypto';
import { dataPath, readJSON, writeJSONAtomic, createDebouncedWriter, DATA_DIR, ensureDir } from './store.mjs';
import { CFG, ENV_LOCKED, normalizeApiKeyList } from './config.mjs';

export const KEYS_PATH = dataPath('keys.json');
const FILE_VERSION = 1;

export const STRATEGY_LABELS = {
  round_robin: '轮询',
  random: '随机',
  fill: '填满（固定用第一个可用）',
};

// 冷却时长：按失败性质区分。
// 注意 not_in_plan 是「模型不在套餐内」，属于模型维度结论 —— 绝不能把 Key 罚下场，
// 否则测一个套餐外模型就会让整个 Key 停摆 10 分钟。
export const COOLDOWN_MS = {
  quota: 10 * 60 * 1000,        // 额度用尽：换个 Key 还有救，稍后自动恢复
  unauthorized: 30 * 60 * 1000, // Key 失效：多半要人工换，但保持自愈能力
  network: 5 * 60 * 1000,       // 网络抖动：短冷却
  error: 0,                     // 其它上游错误：不冷却，只计数
  not_in_plan: 0,
};

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function newUsage() {
  return {
    date: today(),
    requestsToday: 0, requestsTotal: 0,
    failedToday: 0, failedTotal: 0,
    tokensInToday: 0, tokensInTotal: 0,
    tokensOutToday: 0, tokensOutTotal: 0,
  };
}

/** 跨天时把 today 类计数清零（在每次读取/写入前调用，避免依赖定时任务） */
function rollUsage(u) {
  const t = today();
  if (u.date !== t) {
    u.date = t;
    u.requestsToday = 0;
    u.failedToday = 0;
    u.tokensInToday = 0;
    u.tokensOutToday = 0;
  }
  return u;
}

function newStats() {
  return {
    usage: newUsage(),
    health: { status: 'unknown', checkedAt: null, latencyMs: null, message: '' },
    cooldownUntil: null,
    lastError: null,
    lastUsedAt: null,
  };
}

/** 外部来源的 Key 需要一个跨重启稳定的 id（用量统计要挂在它上面） */
function externalId(key) {
  return 'ext_' + createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function newId() {
  return `k_${Date.now()}_${randomBytes(3).toString('hex')}`;
}

/** 脱敏展示：`user_abcd…wxyz`。完整值只能走 reveal 接口单条取。 */
export function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 8) return s.slice(0, 2) + '…';
  if (s.length <= 16) return s.slice(0, 4) + '…' + s.slice(-2);
  return s.slice(0, 9) + '…' + s.slice(-4);
}

export function isValidKeyFormat(key) {
  return typeof key === 'string' && key.trim().length > 0 && key.trim().startsWith('user_');
}

export function createKeyPool({ log = () => {}, onPersistError = null } = {}) {
  ensureDir(DATA_DIR);

  const state = {
    version: FILE_VERSION,
    keys: [],    // UI 管理：{ id, key, label, enabled, createdAt }
    stats: {},   // id → { usage, health, cooldownUntil, lastError, lastUsedAt }
  };

  // 加载
  const loaded = readJSON(KEYS_PATH, null, (file, err) => {
    log('error', 'keys.json 解析失败，已按空池启动（原文件未被覆盖）', { file, error: err.message });
  });
  if (loaded && typeof loaded === 'object' && Array.isArray(loaded.keys)) {
    state.keys = loaded.keys
      .filter(k => k && typeof k.key === 'string' && k.key.trim())
      .map(k => ({
        id: typeof k.id === 'string' && k.id ? k.id : newId(),
        key: k.key.trim(),
        label: typeof k.label === 'string' ? k.label : '',
        enabled: k.enabled !== false,
        createdAt: k.createdAt || new Date().toISOString(),
      }));
    if (loaded.stats && typeof loaded.stats === 'object') {
      for (const [id, s] of Object.entries(loaded.stats)) {
        const base = newStats();
        state.stats[id] = {
          ...base,
          ...s,
          usage: { ...base.usage, ...(s?.usage || {}) },
          health: { ...base.health, ...(s?.health || {}) },
        };
      }
    }
    log('info', 'Key 池已加载', { uiKeys: state.keys.length, dataDir: DATA_DIR });
  }

  const writer = createDebouncedWriter(KEYS_PATH, () => state, {
    maxDelayMs: 5000,
    onError: (e) => {
      log('error', 'keys.json 写盘失败', { error: e.message });
      if (onPersistError) onPersistError(e);
    },
  });

  function persistNow() {
    try {
      writeJSONAtomic(KEYS_PATH, state, 0o600);
    } catch (e) {
      log('error', 'keys.json 写盘失败', { error: e.message });
    }
  }

  function statsOf(id) {
    if (!state.stats[id]) state.stats[id] = newStats();
    const s = state.stats[id];
    rollUsage(s.usage);
    // 冷却到期自动恢复
    if (s.cooldownUntil && Date.now() >= new Date(s.cooldownUntil).getTime()) {
      s.cooldownUntil = null;
    }
    return s;
  }

  /** 只读来源：一组 { key, source } */
  function externalKeys() {
    const source = ENV_LOCKED.has('apiKey') ? 'env' : 'config';
    return normalizeApiKeyList(CFG.apiKeyList).map(key => ({ key, source }));
  }

  /**
   * 合并视图：UI Key + 外部 Key（同串去重，UI 优先）。
   * `entry` 里带 `readOnly` 与 `source`，供后台决定按钮可用性。
   */
  function all() {
    const uiKeys = new Set(state.keys.map(k => k.key));
    const out = state.keys.map(k => ({
      id: k.id, key: k.key, label: k.label || '', enabled: k.enabled !== false,
      source: 'ui', readOnly: false, createdAt: k.createdAt,
    }));
    for (const { key, source } of externalKeys()) {
      if (uiKeys.has(key)) continue;
      out.push({
        id: externalId(key), key, label: source === 'env' ? '（环境变量 CC_API_KEY）' : '（config.json apiKey）',
        enabled: true, source, readOnly: true, createdAt: null,
      });
    }
    return out;
  }

  /** 后台列表项：脱敏 + 用量 + 健康 + 冷却 */
  function list() {
    return all().map(e => {
      const s = statsOf(e.id);
      return {
        id: e.id,
        label: e.label,
        keyMasked: maskKey(e.key),
        source: e.source,
        enabled: e.enabled,
        readOnly: e.readOnly,
        createdAt: e.createdAt,
        lastUsedAt: s.lastUsedAt,
        cooldownUntil: s.cooldownUntil,
        lastError: s.lastError,
        usage: { ...s.usage },
        health: { ...s.health },
      };
    });
  }

  /**
   * 可参与轮询的 Key。排除：被禁用、冷却中、以及本轮已试过的（exclude）。
   *
   * 两级兜底，都是刻意的：
   *  1) 若「仅被 exclude 排除」导致池空 → 退回全集。多 Key 全失败时还要能给出
   *     最后一次响应，而不是直接报「无可用 Key」。
   *  2) 若所有 Key 都在冷却 → 退而选「冷却最早结束」的那个。冷却是我们自己的
   *     启发式，不是上游的权威判定；因为启发式而拒绝服务等于自造故障。
   */
  function candidates(exclude = null) {
    const now = Date.now();
    const enabled = all().filter(e => e.enabled);
    const usable = enabled.filter(e => {
      const s = statsOf(e.id);
      return !(s.cooldownUntil && now < new Date(s.cooldownUntil).getTime());
    });

    let pool = usable;
    let reason = 'ok';

    if (exclude && exclude.size > 0) {
      const fresh = usable.filter(e => !exclude.has(e.key));
      if (fresh.length > 0) pool = fresh;
      else if (usable.length > 0) reason = 'exclude-exhausted';
    }

    if (pool.length === 0 && enabled.length > 0) {
      // 全部冷却中：按冷却结束时间升序，尽早恢复可用
      pool = [...enabled].sort((a, b) => {
        const ta = statsOf(a.id).cooldownUntil ? new Date(statsOf(a.id).cooldownUntil).getTime() : 0;
        const tb = statsOf(b.id).cooldownUntil ? new Date(statsOf(b.id).cooldownUntil).getTime() : 0;
        return ta - tb;
      });
      reason = 'all-cooling';
    }

    return { pool, reason };
  }

  let cursor = 0;
  let lastPicked = null;
  let consecutiveSame = 0;
  let lastCoolingWarnAt = 0;

  /** 按策略选一个 Key。exclude 为本轮已失败过的 Key 字符串集合。 */
  function pick(exclude = null) {
    const { pool, reason } = candidates(exclude);
    if (pool.length === 0) return null;

    if (reason === 'all-cooling') {
      // 限流日志：避免每个请求刷一条
      if (Date.now() - lastCoolingWarnAt > 60000) {
        lastCoolingWarnAt = Date.now();
        log('warn', '所有 Key 均在冷却中，退化为按冷却结束时间优先选择', { count: pool.length });
      }
    }

    if (pool.length === 1) {
      lastPicked = pool[0];
      consecutiveSame = 1;
      return pool[0];
    }

    let chosen;
    if (CFG.strategy === 'fill') {
      chosen = pool[0];
    } else if (CFG.strategy === 'random') {
      // 随机 + 避让连续重复：纯随机会出现「连续几次全撞同一个 Key」，
      // 在额度受限场景下等于把一个号打穿。连续 8 次后不再避让，兜底打破死锁。
      let p = pool;
      if (consecutiveSame < 8 && lastPicked) {
        const avoided = pool.filter(e => e.key !== lastPicked.key);
        if (avoided.length > 0) p = avoided;
      }
      chosen = p[Math.floor(Math.random() * p.length)];
    } else {
      if (cursor >= pool.length) cursor = 0;
      chosen = pool[cursor];
      cursor = (cursor + 1) % pool.length;
    }

    consecutiveSame = (lastPicked && chosen.key === lastPicked.key) ? consecutiveSame + 1 : 1;
    lastPicked = chosen;
    return chosen;
  }

  function idForKey(key) {
    const ui = state.keys.find(k => k.key === key);
    if (ui) return ui.id;
    return externalId(key);
  }

  // ── 写操作 ─────────────────────────────────────────
  function add({ key, label = '' }) {
    const k = String(key || '').trim();
    if (!isValidKeyFormat(k)) return { ok: false, error: 'Key 格式不正确（应以 user_ 开头）' };
    if (all().some(e => e.key === k)) return { ok: false, error: '该 Key 已存在' };
    const entry = { id: newId(), key: k, label: String(label || '').trim(), enabled: true, createdAt: new Date().toISOString() };
    state.keys.push(entry);
    state.stats[entry.id] = newStats();
    persistNow();   // 新增/删除属于低频且重要的变更，立即落盘
    log('info', 'Key 已添加', { id: entry.id, keyMasked: maskKey(k), label: entry.label });
    return { ok: true, entry };
  }

  function update({ id, label, enabled }) {
    const entry = state.keys.find(k => k.id === id);
    if (!entry) {
      const ext = all().find(e => e.id === id);
      if (ext?.readOnly) return { ok: false, error: `该 Key 来自 ${ext.source === 'env' ? '环境变量' : 'config.json'}，不可修改；可先「导入」再编辑` };
      return { ok: false, error: 'Key 不存在' };
    }
    if (label !== undefined) entry.label = String(label || '').trim();
    if (enabled !== undefined) entry.enabled = !!enabled;
    persistNow();
    return { ok: true, entry };
  }

  function remove(id) {
    const idx = state.keys.findIndex(k => k.id === id);
    if (idx === -1) {
      const ext = all().find(e => e.id === id);
      if (ext?.readOnly) return { ok: false, error: `该 Key 来自 ${ext.source === 'env' ? '环境变量' : 'config.json'}，不可删除；可先「导入」再管理` };
      return { ok: false, error: 'Key 不存在' };
    }
    const [gone] = state.keys.splice(idx, 1);
    delete state.stats[gone.id];
    persistNow();
    log('info', 'Key 已删除', { id: gone.id, keyMasked: maskKey(gone.key) });
    return { ok: true };
  }

  function reveal(id) {
    const e = all().find(x => x.id === id);
    if (!e) return { ok: false, error: 'Key 不存在' };
    return { ok: true, key: e.key };
  }

  /** 把只读来源的 Key 复制成 UI 可管理的条目 */
  function importExternal() {
    let imported = 0;
    for (const { key, source } of externalKeys()) {
      if (state.keys.some(k => k.key === key)) continue;
      const entry = {
        id: newId(), key, enabled: true, createdAt: new Date().toISOString(),
        label: source === 'env' ? '导入自 CC_API_KEY' : '导入自 config.json',
      };
      state.keys.push(entry);
      state.stats[entry.id] = newStats();
      imported++;
    }
    if (imported) persistNow();
    return { ok: true, imported };
  }

  // ── 用量与健康记录 ──────────────────────────────────
  function recordRequest(key, { ok }) {
    const s = statsOf(idForKey(key));
    const u = rollUsage(s.usage);
    u.requestsToday++; u.requestsTotal++;
    if (!ok) { u.failedToday++; u.failedTotal++; }
    s.lastUsedAt = new Date().toISOString();
    writer.markDirty();
  }

  function recordTokens(key, { tokensIn = 0, tokensOut = 0 } = {}) {
    if (!key) return;
    if ((tokensIn || 0) <= 0 && (tokensOut || 0) <= 0) return;
    const s = statsOf(idForKey(key));
    const u = rollUsage(s.usage);
    u.tokensInToday += tokensIn; u.tokensInTotal += tokensIn;
    u.tokensOutToday += tokensOut; u.tokensOutTotal += tokensOut;
    writer.markDirty();
  }

  /** 记录一次失败并（按性质）把 Key 放进冷却 */
  function recordFailure(key, { category = 'error', message = '' } = {}) {
    const id = idForKey(key);
    const s = statsOf(id);
    s.lastError = { category, message: String(message || '').slice(0, 300), at: new Date().toISOString() };
    const ms = COOLDOWN_MS[category] ?? 0;
    if (ms > 0) {
      s.cooldownUntil = new Date(Date.now() + ms).toISOString();
      log('warn', 'Key 进入冷却', { category, keyMasked: maskKey(key), cooldownMin: Math.round(ms / 60000) });
    }
    writer.markDirty();
  }

  function setHealth(key, { category, latencyMs = null, message = '' }) {
    if (!key) return;
    const s = statsOf(idForKey(key));
    s.health = {
      status: category,
      checkedAt: new Date().toISOString(),
      latencyMs,
      message: String(message || '').slice(0, 300),
    };
    writer.markDirty();
  }

  /** 探测成功 → 解除冷却（手工测试通过即代表这个 Key 现在可用） */
  function clearCooldown(key) {
    if (!key) return;
    const s = statsOf(idForKey(key));
    s.cooldownUntil = null;
    s.lastError = null;
    writer.markDirty();
  }

  function resetUsage(id, scope = 'today') {
    const s = statsOf(id);
    if (scope === 'all') {
      s.usage = newUsage();
    } else {
      const u = rollUsage(s.usage);
      u.requestsToday = 0; u.failedToday = 0; u.tokensInToday = 0; u.tokensOutToday = 0;
    }
    persistNow();
    return { ok: true };
  }

  function usageReport() {
    const items = list().map(e => {
      const u = e.usage;
      return {
        keyId: e.id, label: e.label, keyMasked: e.keyMasked,
        source: e.source, enabled: e.enabled,
        requestsToday: u.requestsToday, requestsTotal: u.requestsTotal,
        failedToday: u.failedToday, failedTotal: u.failedTotal,
        successToday: u.requestsToday - u.failedToday,
        successTotal: u.requestsTotal - u.failedTotal,
        tokensInToday: u.tokensInToday, tokensInTotal: u.tokensInTotal,
        tokensOutToday: u.tokensOutToday, tokensOutTotal: u.tokensOutTotal,
        lastUsedAt: e.lastUsedAt,
      };
    });
    const summary = items.reduce((a, i) => ({
      requestsToday: a.requestsToday + i.requestsToday,
      requestsTotal: a.requestsTotal + i.requestsTotal,
      failedToday: a.failedToday + i.failedToday,
      failedTotal: a.failedTotal + i.failedTotal,
      inToday: a.inToday + i.tokensInToday,
      inTotal: a.inTotal + i.tokensInTotal,
      outToday: a.outToday + i.tokensOutToday,
      outTotal: a.outTotal + i.tokensOutTotal,
    }), { requestsToday: 0, requestsTotal: 0, failedToday: 0, failedTotal: 0, inToday: 0, inTotal: 0, outToday: 0, outTotal: 0 });
    return { items, summary };
  }

  function countByState() {
    const now = Date.now();
    const list_ = list();
    return {
      total: list_.length,
      enabled: list_.filter(e => e.enabled).length,
      cooldown: list_.filter(e => e.cooldownUntil && now < new Date(e.cooldownUntil).getTime()).length,
      unhealthy: list_.filter(e => e.health?.status && !['ok', 'unknown'].includes(e.health.status)).length,
    };
  }

  /** 供 authenticate / 统计使用：当前可用的上游 Key 数量 */
  function size() {
    return all().filter(e => e.enabled).length;
  }

  function findById(id) {
    return all().find(e => e.id === id) || null;
  }

  return {
    list, all, pick, idForKey, findById, size, countByState,
    candidates: (exclude = null) => candidates(exclude).pool,
    add, update, remove, reveal, importExternal,
    recordRequest, recordTokens, recordFailure, setHealth, clearCooldown, resetUsage,
    usageReport,
    flush: () => { writer.flush(); },
    flushSync: persistNow,
    get path() { return KEYS_PATH; },
  };
}
