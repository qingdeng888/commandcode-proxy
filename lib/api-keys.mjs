// ── 2API Key（下游调用密钥）──────────────────────────────
// 与「上游 Key」是**两套完全不同的东西**，务必别混：
//
//   上游 Key（data/keys.json）   = Command Code 的 user_ 开头的 Key。
//                                  代理拿它去调用上游，是「我们的凭证」。
//   2API Key（data/api-keys.json）= 本项目自己签发、给**下游客户端**用的 Key。
//                                  别人拿它来调用本代理，是「进来的凭证」。
//
// 一次请求的完整链路：
//   下游客户端 --(2API Key)--> 本代理 --(随机挑一个上游 Key)--> Command Code
//
// 为什么要分成两套：
//   - 上游 Key 绝不能发给下游（发出去就等于把账号送人）；
//   - 下游 Key 要能按客户端逐个签发/吊销（一个客户端泄露只吊销它自己），
//     而单个 proxyKey 做不到按客户端区分，也无法单独吊销。
//
// 与参考项目对齐：那边的 p.Keys 就是这个概念（cline_ 前缀、可生成多个、可删）。
// 本项目用 ccp_ 前缀，和上游的 user_ 在肉眼上就能区分开。
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { dataPath, readJSON, writeJSONAtomic } from './store.mjs';

export const API_KEYS_PATH = dataPath('api-keys.json');
export const API_KEY_PREFIX = 'ccp_';

/** 脱敏展示：ccp_abcd…wxyz */
export function maskApiKey(key) {
  const s = String(key || '');
  if (s.length <= 10) return s.slice(0, 3) + '…';
  return s.slice(0, 9) + '…' + s.slice(-4);
}

export function looksLikeUpstreamKey(v) {
  return typeof v === 'string' && v.trim().startsWith('user_');
}

export function looksLikeApiKey(v) {
  return typeof v === 'string' && v.trim().startsWith(API_KEY_PREFIX);
}

export function createApiKeyPool({ log = () => {} } = {}) {
  const state = { version: 1, keys: [] };

  const loaded = readJSON(API_KEYS_PATH, null, (file, err) => {
    log('error', 'api-keys.json 解析失败，已按空池启动（原文件未被覆盖）', { file, error: err.message });
  });
  if (loaded && typeof loaded === 'object' && Array.isArray(loaded.keys)) {
    for (const k of loaded.keys) {
      if (!k || typeof k.key !== 'string' || !k.key.trim()) continue;
      state.keys.push({
        id: typeof k.id === 'string' && k.id ? k.id : newId(),
        key: k.key.trim(),
        label: typeof k.label === 'string' ? k.label : '',
        enabled: k.enabled !== false,
        createdAt: k.createdAt || new Date().toISOString(),
        lastUsedAt: k.lastUsedAt || null,
        requests: Number.isFinite(k.requests) ? k.requests : 0,
      });
    }
    if (state.keys.length) log('info', '2API Key 已加载', { count: state.keys.length });
  }

  function persist() {
    try {
      writeJSONAtomic(API_KEYS_PATH, state, 0o600);
      return { persisted: true };
    } catch (e) {
      log('error', 'api-keys.json 写盘失败', { error: e.message });
      return { persisted: false, error: e.message };
    }
  }

  function newId() {
    return `ak_${Date.now()}_${randomBytes(3).toString('hex')}`;
  }

  /** 生成的 Key 形如 ccp_<毫秒的十六进制>_<12 位随机>，与上游 user_ 前缀在肉眼上可区分 */
  function generateKeyString() {
    return `${API_KEY_PREFIX}${Date.now().toString(16)}_${randomBytes(6).toString('hex')}`;
  }

  /** 后台列表：完整 Key 脱敏，只有 reveal 接口能给明文 */
  function list() {
    return state.keys.map(k => ({
      id: k.id,
      label: k.label,
      keyMasked: maskApiKey(k.key),
      enabled: k.enabled !== false,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      requests: k.requests || 0,
    }));
  }

  function findById(id) {
    return state.keys.find(k => k.id === id) || null;
  }

  /** 新增。key 省略则自动生成；显式传入的必须带 ccp_ 前缀且不重复。 */
  function add({ key, label = '' } = {}) {
    let value = typeof key === 'string' ? key.trim() : '';
    let generated = false;
    if (!value) {
      value = generateKeyString();
      generated = true;
    } else if (!looksLikeApiKey(value)) {
      return { ok: false, error: `2API Key 必须以 ${API_KEY_PREFIX} 开头（上游 user_ Key 请到「上游 Key」页添加）` };
    }
    if (value.length < 12) return { ok: false, error: '2API Key 太短' };
    if (state.keys.some(k => k.key === value)) return { ok: false, error: '该 2API Key 已存在' };

    const entry = {
      id: newId(),
      key: value,
      label: String(label || '').trim(),
      enabled: true,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      requests: 0,
    };
    state.keys.push(entry);
    const p = persist();
    log('info', '2API Key 已创建', { id: entry.id, keyMasked: maskApiKey(value), generated });
    return { ok: true, entry, generated, persisted: p.persisted !== false };
  }

  function update({ id, label, enabled }) {
    const entry = findById(id);
    if (!entry) return { ok: false, error: '2API Key 不存在' };
    if (label !== undefined) entry.label = String(label || '').trim();
    if (enabled !== undefined) entry.enabled = !!enabled;
    persist();
    return { ok: true, entry };
  }

  function remove(id) {
    const idx = state.keys.findIndex(k => k.id === id);
    if (idx === -1) return { ok: false, error: '2API Key 不存在' };
    const [gone] = state.keys.splice(idx, 1);
    persist();
    log('info', '2API Key 已删除', { id: gone.id, keyMasked: maskApiKey(gone.key) });
    return { ok: true };
  }

  function reveal(id) {
    const entry = findById(id);
    if (!entry) return { ok: false, error: '2API Key 不存在' };
    return { ok: true, key: entry.key };
  }

  /**
   * 校验下游提交的凭证是否为本项目签发的 2API Key。
   * 用定长比较，避免逐字节比对泄露时序信息。
   */
  function verify(credential) {
    if (typeof credential !== 'string' || !credential) return null;
    const cand = Buffer.from(credential, 'utf8');
    for (const entry of state.keys) {
      if (entry.enabled === false) continue;   // 禁用后立即失效
      const stored = Buffer.from(entry.key, 'utf8');
      if (stored.length !== cand.length) continue;
      if (timingSafeEqual(stored, cand)) return entry;
    }
    return null;
  }

  /** 记录一次使用（在鉴权通过时调用）。只改动计数，落盘交给防抖 —— 它在热路径上。 */
  let dirty = false;
  let flushTimer = null;
  function recordUse(entry) {
    if (!entry) return;
    entry.lastUsedAt = new Date().toISOString();
    entry.requests = (entry.requests || 0) + 1;
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!dirty) return;
      dirty = false;
      persist();
    }, 5000);
    flushTimer.unref?.();
  }

  /** 供 /health 与后台概览使用：启用的 2API Key 数量 */
  function countEnabled() {
    return state.keys.filter(k => k.enabled !== false).length;
  }

  return {
    list, findById, add, update, remove, reveal, verify, recordUse, countEnabled,
    flushSync: persist,
    get size() { return state.keys.length; },
    get path() { return API_KEYS_PATH; },
  };
}
