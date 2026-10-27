// ── 出站代理池 ────────────────────────────────────────
// 一个「代理条目」= 一条出站路由，可以是 `direct`（直连）、一个 http:// 代理，
// 或一个**轮换型代理池**（Resin 之类：每条新 TCP 连接出口 IP 都不同）。
//
// 三种来源，合并成一个池（与 lib/keys.mjs 的 ui/config/env 三来源是同一套思路）：
//   ui        后台添加 → 存在 data/proxies.json，可增删改、可启停
//   config    来自 config.json 的 proxies 数组 → 只读，可停用不可删除
//   proxyfile 来自 proxyFile 指向的文件（每行一条）→ 只读，可停用不可删除
// 只读来源不允许删除（会明确报错），但可以停用；停用记录落在 data/proxies.json，
// 于是「config.json 里的条目永远还在」和「我可以让它暂时不参与轮询」两件事不冲突。
//
// 为什么用「派生 id」而不是序号：条目的身份必须在重排、启停、跨重启之后保持稳定，
// 否则后台给某个 Key 绑定的代理会在重启后指向另一条。id = 地址的 sha256 前 16 位，
// 只由内容决定 —— 改地址就是换了一条代理，这也正是用户期望的语义。
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'path';
import { CFG, CONFIG_PATH } from './config.mjs';
import { dataPath, readJSON, writeJSONAtomic, ensureDir } from './store.mjs';

export const PROXIES_PATH = dataPath('proxies.json');
const FILE_VERSION = 1;

/** 单条代理条目的健康检查超时与调度间隔（可用环境变量覆盖，测试要用）。 */
export const HEALTH_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_PROXY_HEALTH_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 10000;
})();
const HEALTH_INTERVAL_MS = (() => {
  const ms = Number.parseInt(process.env.CC_PROXY_HEALTH_INTERVAL_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 15 * 60 * 1000;
})();

/** 失败冷却：基础值，连续失败按 2 的幂放大，上限 8 倍。 */
const FAILURE_COOLDOWN_MS = 15 * 1000;
const MAX_COOLDOWN_MULTIPLIER = 8;

/** 后台一次批量新增的上限：防止把 10 万行粘进输入框把面板卡死。 */
export const MAX_BULK_PROXIES = 2000;
export const MAX_PROXY_ENTRIES = 5000;

/** 条目地址的稳定身份。只由内容决定，跨重启、跨重排都不变。 */
export function proxyFingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/**
 * 拆出一个代理条目的「拨号地址」与「是否轮换池」标记。
 *
 * 两种等价写法都认（与参考实现一致，用户从两处文档看到哪一处都能用）：
 *   pool+http://user:pass@host:port    前缀
 *   http://user:pass@host:port#pool    片段
 * 标记必须能跟「URL 自带的 fragment」区分开：`#pool` 是唯一的保留片段，
 * 其它片段一律原样留在地址里（我们不做解释，也不会悄悄丢掉用户写的东西）。
 */
export function parseProxyEntry(raw) {
  let trimmed = String(raw ?? '').trim();
  if (trimmed === '') return { value: '', pool: false };
  if (trimmed.toLowerCase().startsWith('pool+')) {
    trimmed = trimmed.slice('pool+'.length).trim();
    return { value: trimmed, pool: true };
  }
  const hash = trimmed.lastIndexOf('#');
  if (hash >= 0 && trimmed.slice(hash + 1).trim().toLowerCase() === 'pool') {
    return { value: trimmed.slice(0, hash).trim(), pool: true };
  }
  return { value: trimmed, pool: false };
}

/** 代理 URL 可能带 user:pass —— 任何日志/错误消息/后台展示都只允许出现 host:port。 */
export function redactProxyUrl(raw) {
  const { value } = parseProxyEntry(raw);
  if (!value) return '(empty)';
  if (value === 'direct') return 'direct';
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
  } catch {
    return '(invalid)';
  }
}

/**
 * 校验一条代理条目。返回 null 表示合法，否则返回给用户看的原因。
 * `direct` 是保留字：显式表示「这条路由不经过任何代理」。
 */
export function validateProxyEntry(raw) {
  const { value } = parseProxyEntry(raw);
  if (!value) return '代理地址不能为空';
  if (value === 'direct') return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    // 不回显原串：里面可能就是口令
    return '代理地址无效（应形如 http://user:pass@host:port，或 direct）';
  }
  if (u.protocol !== 'http:') {
    return `只支持 http:// 代理（CONNECT 隧道），收到 ${u.protocol}//`;
  }
  if (!u.hostname) return '代理地址缺少主机名';
  return null;
}

/**
 * 去掉代理文件里一行末尾的注释。
 * 只认「行首或空白之后的」# ; //，这样 `#pool` 片段与 URL 里的 `//` 都能活下来。
 */
export function stripProxyLineComment(line) {
  for (let i = 0; i < line.length; i++) {
    if (i > 0 && line[i - 1] !== ' ' && line[i - 1] !== '\t') continue;
    if (line[i] === '#' || line[i] === ';') return line.slice(0, i);
    if (line[i] === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** 解析代理文件正文：每行一条，忽略空行、注释与 BOM。 */
export function parseProxyFileText(text) {
  const out = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = stripProxyLineComment(rawLine.replace(/^\uFEFF/, '')).trim();
    if (line) out.push(line);
  }
  return out;
}

/** 读代理文件；相对路径按 config.json 所在目录解析（与用户的直觉一致）。 */
function readProxyFile(path) {
  const resolved = isAbsolute(path) ? path : resolvePath(dirname(CONFIG_PATH), path);
  const text = readFileSync(resolved, 'utf-8');
  return { resolved, entries: parseProxyFileText(text) };
}

/** 去重：同一条地址只保留第一次出现的写法；`pool+` 与 `#pool` 视为同一条。 */
function dedupe(entries) {
  const out = [];
  const seen = new Set();
  for (const raw of entries) {
    const { value, pool } = parseProxyEntry(raw);
    if (!value) continue;
    const key = `${pool ? 'pool:' : 'static:'}${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

export function createProxyPool({ log = () => {}, probe = null, keysProvider = null, keyIdFor = null } = {}) {
  ensureDir(dirname(PROXIES_PATH));

  const state = {
    version: FILE_VERSION,
    entries: [],      // 后台管理：{ id, value, enabled, createdAt }
    disabled: [],     // 被停用的条目指纹（只读来源的条目也停用在这里）
    bindings: {},     // Key 指纹 → { mode, proxyId }
  };

  const loaded = readJSON(PROXIES_PATH, null, (file, err) => {
    log('error', 'proxies.json 解析失败，已按空池启动（原文件未被覆盖）', { file, error: err.message });
  });
  if (loaded && typeof loaded === 'object') {
    if (Array.isArray(loaded.entries)) {
      state.entries = loaded.entries
        .filter(e => e && typeof e.value === 'string' && e.value.trim())
        .map(e => ({
          id: typeof e.id === 'string' && e.id ? e.id : proxyFingerprint(e.value),
          value: e.value.trim(),
          enabled: e.enabled !== false,
          createdAt: e.createdAt || new Date().toISOString(),
        }));
    }
    if (Array.isArray(loaded.disabled)) {
      state.disabled = loaded.disabled.filter(d => typeof d === 'string' && d);
    }
    if (loaded.bindings && typeof loaded.bindings === 'object') {
      for (const [fp, b] of Object.entries(loaded.bindings)) {
        if (!b || typeof b !== 'object') continue;
        const mode = b.mode === 'bind' || b.mode === 'rotate' ? b.mode : 'auto';
        state.bindings[fp] = {
          mode,
          proxyId: mode === 'bind' && typeof b.proxyId === 'string' ? b.proxyId : '',
        };
      }
    }
    log('info', '代理池已加载', {
      uiEntries: state.entries.length, disabled: state.disabled.length,
      bindings: Object.keys(state.bindings).length, dataDir: dirname(PROXIES_PATH),
    });
  }

  function persistNow() {
    try {
      writeJSONAtomic(PROXIES_PATH, state, 0o600);
    } catch (e) {
      log('error', 'proxies.json 写盘失败', { error: e.message });
    }
  }

  // ── 条目合并视图 ────────────────────────────────────
  // 每次 reload 重算：config.json 与 proxyfile 都可能被用户手工改动，
  // 而这两处都不是我们写的，只能每次读一遍（低频操作，代价可忽略）。
  let transports = [];
  let proxyFile = '';
  let proxyFileError = '';

  function sourceEntries() {
    const out = [];
    for (const e of state.entries) {
      out.push({ value: e.value, source: 'ui', managed: true, enabled: e.enabled !== false, id: e.id, createdAt: e.createdAt });
    }
    for (const raw of Array.isArray(CFG.proxies) ? CFG.proxies : []) {
      const value = String(raw ?? '').trim();
      if (value) out.push({ value, source: 'config', managed: false, enabled: true, id: proxyFingerprint(value), createdAt: null });
    }
    // 旧字段 upstreamProxy（单代理）继续生效：它作为 config 来源的一条加入池子，
    // 于是升级上来的部署行为不变 —— 只是现在多了一个可以管理它的界面。
    const legacy = String(CFG.upstreamProxy ?? '').trim();
    if (legacy) out.push({ value: legacy, source: 'legacy', managed: false, enabled: true, id: proxyFingerprint(legacy), createdAt: null });
    proxyFile = String(CFG.proxyFile ?? '').trim();
    proxyFileError = '';
    if (proxyFile) {
      try {
        const { entries } = readProxyFile(proxyFile);
        for (const value of entries) {
          out.push({ value, source: 'proxyfile', managed: false, enabled: true, id: proxyFingerprint(value), createdAt: null });
        }
      } catch (e) {
        // 文件读不到不该让整个池消失：config.json 里的条目照常可用，
        // 但必须在后台显式报出来，否则「我明明写了 proxyfile」会变成静默失效。
        proxyFileError = e.message;
        log('warn', '代理文件读取失败', { file: proxyFile, error: e.message });
      }
    }
    return out;
  }

  /** 重建 transports。返回本次生效的条目数。 */
  function reload() {
    const merged = dedupe(sourceEntries().map(e => e.value));
    const byValue = new Map();
    for (const e of sourceEntries()) if (!byValue.has(e.value)) byValue.set(e.value, e);

    const previous = new Map(transports.map(t => [t.id, t]));
    const next = [];
    for (const value of merged) {
      const meta = byValue.get(value) || { source: 'ui', managed: true, enabled: true };
      const { pool } = parseProxyEntry(value);
      const id = proxyFingerprint(value);
      const disabled = state.disabled.includes(id);
      const enabled = meta.enabled !== false && !disabled;
      const prev = previous.get(id);
      next.push({
        id,
        index: next.length,
        value,
        address: parseProxyEntry(value).value,
        pool,
        source: meta.source,
        managed: meta.managed,
        enabled,
        // 健康状态跨 reload 保留：用户改一条无关条目不该把其它代理的
        // 失败计数与冷却一起清零（那会让刚被判定故障的代理立刻回到轮询里）。
        healthy: prev ? prev.healthy : true,
        checking: false,
        failures: prev ? prev.failures : 0,
        cooldownUntil: prev ? prev.cooldownUntil : 0,
        lastError: prev ? prev.lastError : '',
        lastCheckedAt: prev ? prev.lastCheckedAt : null,
        lastLatencyMs: prev ? prev.lastLatencyMs : null,
      });
    }
    transports = next;

    // 空池 → 一条 direct。否则用户清空配置后整个代理直接不可用。
    if (transports.length === 0) {
      transports = [{
        id: proxyFingerprint('direct'), index: 0, value: 'direct', address: 'direct',
        pool: false, source: 'default', managed: false, enabled: true,
        healthy: true, checking: false, failures: 0, cooldownUntil: 0,
        lastError: '', lastCheckedAt: null, lastLatencyMs: null,
      }];
    }
    syncNodes();
    return transports.length;
  }

  // ── 上游 Key ↔ 代理绑定 ─────────────────────────────
  // 与参考实现同一套三种模式：
  //   auto   静态 i%N 绑定 + 故障时转移到最空闲的健康代理（历史行为）
  //   bind   固定到某一条，代理挂了也不自动迁移（用户明确要求「这个号就走这个 IP」）
  //   rotate 每次尝试都重新挑一条健康代理（要的就是每次换 IP）
  const nodes = new Map();   // keyFingerprint → node

  function keyFingerprint(key) {
    return createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
  }

  function bindingOf(key) {
    const b = state.bindings[keyFingerprint(key)];
    if (!b || b.mode === 'auto') return { mode: 'auto', proxyId: '' };
    return { mode: b.mode, proxyId: b.proxyId || '' };
  }

  /**
   * 把代理指纹解析成池内位置。**停用的条目不算命中** —— 绑定指向一条被停用的代理，
   * 等于这个 Key 永远出不去；那必须退回 auto，而不是留着一个看起来配好了的绑定。
   */
  function indexById(id) {
    if (!id) return -1;
    const idx = transports.findIndex(t => t.id === id);
    if (idx < 0) return -1;
    return transports[idx].enabled ? idx : -1;
  }

  /**
   * 按当前 Key 池重建节点。auto 模式的位置是 `i % N`：Key 数少于代理数时，
   * 多出来的代理保持空闲，正好充当故障转移的目标。
   */
  function syncNodes() {
    const keys = typeof keysProvider === 'function' ? (keysProvider() || []) : [];
    const live = new Set();
    keys.forEach((key, i) => {
      const fp = keyFingerprint(key);
      live.add(fp);
      let node = nodes.get(fp);
      if (!node) {
        node = { fp, key, index: i, preferred: -1, current: -1, mode: 'auto', proxyId: '', failures: 0, cooldownUntil: 0 };
        nodes.set(fp, node);
      }
      node.key = key;
      node.index = i;
      const { mode, proxyId } = bindingOf(key);
      node.mode = mode;
      node.proxyId = proxyId;
      if (mode === 'bind') {
        const idx = indexById(proxyId);
        if (idx >= 0) { node.preferred = idx; node.current = idx; return; }
        // 绑定的那条已经不在池里（被删或被停用）→ 退回 auto，让这个 Key 还能用。
        // 静默失效比退回自动绑定糟得多：用户会以为「配了绑定」其实没有。
        node.mode = 'auto';
        node.proxyId = '';
      }
      if (mode === 'rotate') { node.preferred = -1; node.current = -1; return; }
      node.preferred = i % transports.length;
      node.current = node.preferred;
    });
    for (const fp of [...nodes.keys()]) if (!live.has(fp)) nodes.delete(fp);
  }

  let rotateCursor = 0;
  let autoCursor = 0;

  /** 挑一条健康代理；全不健康时也返回一条，让这次尝试可见地失败并触发健康恢复。 */
  function pickRotate(exclude) {
    const n = transports.length;
    if (n === 0) return null;
    for (let i = 0; i < n; i++) {
      const t = transports[(rotateCursor + i) % n];
      if (exclude && exclude.has(t.id)) continue;
      if (t.enabled && t.healthy && t.cooldownUntil <= Date.now()) return t;
    }
    // 没有完全健康的目标：退而选一条启用中的（可能冷却中/不健康），
    // 至少让请求真的发出去 —— 因为启发式而拒绝服务等于自造故障。
    for (let i = 0; i < n; i++) {
      const t = transports[(rotateCursor + i) % n];
      if (exclude && exclude.has(t.id)) continue;
      if (t.enabled) return t;
    }
    return null;
  }

  /** 故障转移目标：优先「没有 Key 绑定」的空闲健康代理，其次负载最轻的健康代理。 */
  function replacementFor(failedIndex, exclude) {
    let best = -1;
    let bestCount = Infinity;
    const counts = new Array(transports.length).fill(0);
    for (const node of nodes.values()) if (node.current >= 0) counts[node.current]++;
    for (let i = 0; i < transports.length; i++) {
      if (i === failedIndex) continue;
      const t = transports[i];
      if (!t.enabled || !t.healthy) continue;
      if (exclude && exclude.has(t.id)) continue;
      if (counts[i] === 0) return i;
      if (counts[i] < bestCount) { bestCount = counts[i]; best = i; }
    }
    return best;
  }

  /**
   * 为一次上游尝试挑代理。exclude 是本请求已经试过的代理 id 集合。
   * 返回 transport 或 null（池为空 —— 实际上不可能，reload 保证至少一条 direct）。
   */
  function choose(key, exclude = null) {
    if (transports.length === 0) return null;
    const fp = keyFingerprint(key);
    let node = nodes.get(fp);
    if (!node) {
      // Key 还没被 syncNodes 收录（例如池是后建的）：就地补一个 auto 节点
      node = { fp, key, index: nodes.size, preferred: -1, current: -1, mode: 'auto', proxyId: '', failures: 0, cooldownUntil: 0 };
      nodes.set(fp, node);
    }
    const { mode } = bindingOf(key);
    if (mode !== node.mode) {
      node.mode = mode;
      node.proxyId = mode === 'bind' ? (state.bindings[fp]?.proxyId || '') : '';
      if (mode === 'bind') {
        const idx = indexById(node.proxyId);
        if (idx >= 0) { node.preferred = idx; node.current = idx; }
        else { node.mode = 'auto'; node.preferred = node.index % transports.length; node.current = node.preferred; }
      } else if (mode === 'rotate') {
        node.preferred = -1; node.current = -1;
      } else {
        node.preferred = node.index % transports.length; node.current = node.preferred;
      }
    }

    if (node.mode === 'rotate') {
      const t = pickRotate(exclude);
      rotateCursor = (rotateCursor + 1) % Math.max(transports.length, 1);
      return t;
    }

    if (node.current < 0 || node.current >= transports.length) {
      node.current = node.preferred >= 0 ? node.preferred : (autoCursor++ % transports.length);
    }
    let t = transports[node.current];
    if (t && t.enabled && t.healthy && !(exclude && exclude.has(t.id))) return t;

    // auto：原绑定不可用 → 转移到最空闲的健康代理（并记住新位置，后续请求继续用它）
    // bind：用户明确要求固定，绝不自动迁移；但那条真的不在池里时上面已经退回 auto 了。
    if (node.mode === 'auto') {
      const target = replacementFor(node.current, exclude);
      if (target >= 0) { node.current = target; return transports[target]; }
    }
    // 没有任何健康目标：仍然返回当前这条（可见地失败），除非它已被本请求试过
    if (t && t.enabled && !(exclude && exclude.has(t.id))) return t;
    for (const cand of transports) {
      if (!cand.enabled) continue;
      if (exclude && exclude.has(cand.id)) continue;
      return cand;
    }
    return null;
  }

  /** 代理恢复：把当初因为故障而迁移走的 auto 绑定迁回原位置。 */
  function restoreProxy(index) {
    let moved = 0;
    for (const node of nodes.values()) {
      if (node.mode !== 'auto') continue;
      if (node.preferred !== index || node.current === index) continue;
      node.current = index;
      node.failures = 0;
      node.cooldownUntil = 0;
      moved++;
    }
    return moved;
  }

  // ── 健康状态 ────────────────────────────────────────
  function markSuccess(t) {
    if (!t) return;
    t.failures = 0;
    t.cooldownUntil = 0;
    t.lastError = '';
    t.healthy = true;
  }

  /**
   * 记一次失败。只有「路由层」失败（连不上、超时、TLS 失败）才算代理故障；
   * 上游返回的 4xx/5xx 说明代理是通的，那是账号/模型维度的问题，不该惩罚代理。
   * 轮换池条目永不记健康状态：它的出口每次都不同，一次失败说明不了那条池子坏了。
   */
  function markFailure(t, err) {
    if (!t || t.pool) return;
    t.failures += 1;
    const delay = FAILURE_COOLDOWN_MS * Math.pow(2, Math.min(t.failures - 1, 3));
    t.cooldownUntil = Date.now() + delay;
    t.healthy = false;
    t.lastError = err ? String(err.message || err) : '';
  }

  async function testOne(t) {
    if (!probe) return { ok: false, error: '未提供探测实现' };
    if (t.checking) return { ok: false, error: '该代理正在检测中' };
    t.checking = true;
    const started = Date.now();
    try {
      const result = await probe(t);
      t.lastCheckedAt = new Date().toISOString();
      t.lastLatencyMs = Date.now() - started;
      if (result && result.reachable) {
        // 任何 HTTP 响应都证明这条路通了（401/403 也算通）。
        t.healthy = true;
        t.failures = 0;
        t.cooldownUntil = 0;
        t.lastError = '';
      } else {
        markFailure(t, result?.error || new Error('unreachable'));
      }
      return { ok: !!(result && result.reachable), status: result?.status ?? null, latencyMs: t.lastLatencyMs, error: result?.error ? String(result.error.message || result.error) : '' };
    } catch (e) {
      t.lastCheckedAt = new Date().toISOString();
      t.lastLatencyMs = Date.now() - started;
      markFailure(t, e);
      return { ok: false, latencyMs: t.lastLatencyMs, error: String(e.message || e) };
    } finally {
      t.checking = false;
    }
  }

  /**
   * 批量测试若干条代理。并发有上限（默认 4，最高 8）—— 一次勾 50 条同时打出去，
   * 会把本机的连接数打满，测出来的「失败」反映的是我们自己而不是代理。
   *
   * 单条失败不影响其余：逐条收集结果，最后给出汇总。`skipped` 收下找不到的 id。
   */
  async function testMany(ids, { limit = 4 } = {}) {
    const wanted = [...new Set((ids || []).filter(Boolean))];
    if (wanted.length === 0) return { ok: false, error: '未指定要测试的代理' };
    const targets = [];
    const skipped = [];
    for (const id of wanted) {
      const t = transports.find(x => x.id === id);
      if (t) targets.push(t); else skipped.push(id);
    }
    if (targets.length === 0) return { ok: false, error: '选中的代理都不存在', skipped };

    const width = Math.max(1, Math.min(Number(limit) || 4, 8));
    const queue = [...targets];
    const results = [];
    const startedAt = Date.now();
    const workers = [];
    for (let i = 0; i < width; i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const t = queue.shift();
          const r = await testOne(t);
          results.push({ id: t.id, address: redactProxyUrl(t.value), pool: t.pool, ...r });
        }
      })());
    }
    await Promise.all(workers);

    // 顺序按用户勾选的顺序给回，而不是完成顺序 —— 否则表格里的结果会跳来跳去
    const order = new Map(targets.map((t, i) => [t.id, i]));
    results.sort((a, b) => order.get(a.id) - order.get(b.id));

    const ok = results.filter(r => r.ok).length;
    log('info', '代理批量测试结束', {
      total: results.length, ok, failed: results.length - ok,
      skipped: skipped.length, elapsedMs: Date.now() - startedAt,
    });
    return {
      ok: true,
      results,
      summary: { total: results.length, ok, failed: results.length - ok, skipped: skipped.length },
      skipped,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /**
   * 并发复查所有「启用中、不健康且不在检测中」的代理。
   * 跳过三类：健康的（没什么可查）、轮换池（出口每次都不同）、**已停用的**
   * （它们不参与任何路由，每 15 分钟替它们打一次上游纯属浪费，还会把
   *   `healthy` 翻回 true 让人误以为它在被使用）。
   */
  async function checkHealth() {
    const targets = transports.filter(t => t.enabled && !t.pool && !t.healthy && !t.checking);
    const results = await Promise.all(targets.map(async t => {
      const before = t.healthy;
      const r = await testOne(t);
      if (r.ok && !before) {
        const moved = restoreProxy(t.index);
        if (moved > 0) log('info', '代理已恢复，迁移出去的 Key 已迁回', { proxy: redactProxyUrl(t.value), moved });
      }
      return { id: t.id, address: redactProxyUrl(t.value), ...r };
    }));
    return results;
  }

  let healthTimer = null;
  function startHealthChecks() {
    if (healthTimer || !probe) return;
    healthTimer = setInterval(() => {
      checkHealth().catch(e => log('warn', '代理健康检查出错', { error: e.message }));
    }, HEALTH_INTERVAL_MS);
    if (typeof healthTimer.unref === 'function') healthTimer.unref();
  }
  function stopHealthChecks() {
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  }

  // ── 后台视图与写操作 ────────────────────────────────
  function list() {
    return transports.map(t => ({
      id: t.id,
      index: t.index,
      // 刻意**不**返回含口令的原串：与 Key 列表同一条约定 —— 列表只给脱敏值，
      // 明文必须显式走 /proxies/reveal（会记一条日志）。少一个字段就少一处泄露面。
      address: redactProxyUrl(t.value),
      pool: t.pool,
      source: t.source,
      managed: t.managed,
      enabled: t.enabled,
      healthy: t.healthy,
      checking: t.checking,
      failures: t.failures,
      cooldownUntil: t.cooldownUntil > Date.now() ? new Date(t.cooldownUntil).toISOString() : null,
      lastError: t.lastError,
      lastCheckedAt: t.lastCheckedAt,
      lastLatencyMs: t.lastLatencyMs,
      // 有几个 Key 正绑在这一条上（含 auto 迁移后的当前位置）
      keys: [...nodes.values()].filter(n => n.current === t.index).length,
    }));
  }

  /** 完整地址（含口令）。与 Key 的 reveal 同一条约定：只由已登录的后台显式索取。 */
  function reveal(id) {
    const t = transports.find(x => x.id === id);
    if (!t) return { ok: false, error: '代理不存在' };
    return { ok: true, value: t.value };
  }

  function keyViews() {
    // 后台加/删 Key 之后节点表要跟上，否则「刚加的 Key 没有绑定记录」会让人以为功能没生效
    syncNodes();
    return [...nodes.values()]
      .sort((a, b) => a.index - b.index)
      .map(n => {
        const t = n.current >= 0 ? transports[n.current] : null;
        return {
          fp: n.fp,
          // keyId 是 Key 池里的 id（后台设置绑定时用它，前后端不必各自再算一次指纹）
          keyId: typeof keyIdFor === 'function' ? (keyIdFor(n.key) || null) : null,
          index: n.index,
          mode: n.mode,
          proxyId: n.proxyId,
          proxyIndex: n.current,
          proxyAddress: t ? redactProxyUrl(t.value) : null,
          proxyHealthy: t ? t.healthy : null,
          failures: n.failures,
        };
      });
  }

  function add(value) {
    const v = String(value ?? '').trim();
    const err = validateProxyEntry(v);
    if (err) return { ok: false, error: err };
    if (state.entries.length >= MAX_PROXY_ENTRIES) return { ok: false, error: `后台管理的代理条目已达上限 ${MAX_PROXY_ENTRIES}` };
    if (transports.some(t => t.value === v)) return { ok: false, error: '该代理已存在' };
    const entry = { id: proxyFingerprint(v), value: v, enabled: true, createdAt: new Date().toISOString() };
    state.entries.push(entry);
    // 同一个地址曾以 config/proxyfile 来源存在时可能带着停用记录，新增即视为重新启用
    state.disabled = state.disabled.filter(d => d !== entry.id);
    persistNow();
    reload();
    log('info', '代理已添加', { proxy: redactProxyUrl(v), pool: parseProxyEntry(v).pool });
    return { ok: true, entry };
  }

  function addBulk(values) {
    // 不去重：批内重复必须如实出现在 skipped 里。用户粘了 200 行、其中 3 行重复，
    // 报告必须说「跳过 3 条」—— 静默去重会让「我明明贴进去了」和「加了多少条」对不上。
    const wanted = (values || []).map(v => String(v ?? '').trim()).filter(Boolean);
    if (wanted.length === 0) return { ok: false, error: '没有可添加的代理' };
    if (wanted.length > MAX_BULK_PROXIES) return { ok: false, error: `一次最多添加 ${MAX_BULK_PROXIES} 条，收到 ${wanted.length} 条` };
    const existing = new Set(transports.map(t => t.value));
    const invalid = [];
    const added = [];
    const skipped = [];
    for (const v of wanted) {
      const err = validateProxyEntry(v);
      if (err) { invalid.push({ value: redactProxyUrl(v), error: err }); continue; }
      if (existing.has(v)) { skipped.push(redactProxyUrl(v)); continue; }
      if (state.entries.length >= MAX_PROXY_ENTRIES) { skipped.push(redactProxyUrl(v)); continue; }
      const entry = { id: proxyFingerprint(v), value: v, enabled: true, createdAt: new Date().toISOString() };
      state.entries.push(entry);
      existing.add(v);
      added.push(entry);
    }
    if (added.length === 0) {
      return { ok: false, error: invalid.length ? '没有合法的新代理' : '这些代理都已存在', invalid, skipped };
    }
    state.disabled = state.disabled.filter(d => !added.some(e => e.id === d));
    persistNow();
    reload();
    log('info', '代理已批量添加', { added: added.length, skipped: skipped.length, invalid: invalid.length });
    return { ok: true, added: added.length, skipped, invalid };
  }

  function update(id, value) {
    const entry = state.entries.find(e => e.id === id);
    if (!entry) return { ok: false, error: '该代理来自 config.json 或代理文件，不可修改；可先「停用」再在配置里调整' };
    const v = String(value ?? '').trim();
    const err = validateProxyEntry(v);
    if (err) return { ok: false, error: err };
    if (transports.some(t => t.value === v && t.id !== id)) return { ok: false, error: '该代理已存在' };
    const oldId = entry.id;
    entry.value = v;
    entry.id = proxyFingerprint(v);
    // 地址变了就是换了一条：旧地址的停用记录与绑定一起跟着走，否则会留下悬空引用
    state.disabled = state.disabled.map(d => (d === oldId ? entry.id : d));
    for (const [fp, b] of Object.entries(state.bindings)) {
      if (b.proxyId === oldId) state.bindings[fp] = { ...b, proxyId: entry.id };
    }
    persistNow();
    reload();
    return { ok: true, entry };
  }

  function remove(ids) {
    const wanted = new Set((ids || []).filter(Boolean));
    if (wanted.size === 0) return { ok: false, error: '未指定要删除的代理' };
    const kept = [];
    const removed = [];
    for (const e of state.entries) {
      if (wanted.has(e.id)) { removed.push(e); continue; }
      kept.push(e);
    }
    const skipped = [...wanted].filter(id => !removed.some(e => e.id === id));
    if (removed.length === 0) {
      return { ok: false, error: '没有可删除的条目（config.json 与代理文件里的条目只能停用，不能删除）', skipped };
    }
    state.entries = kept;
    state.disabled = state.disabled.filter(d => !removed.some(e => e.id === d));
    for (const [fp, b] of Object.entries(state.bindings)) {
      if (removed.some(e => e.id === b.proxyId)) state.bindings[fp] = { mode: 'auto', proxyId: '' };
    }
    persistNow();
    reload();
    log('info', '代理已删除', { removed: removed.map(e => redactProxyUrl(e.value)) });
    return { ok: true, removed: removed.map(e => redactProxyUrl(e.value)), skipped };
  }

  /**
   * 启停。config.json / 代理文件里的条目也能停用（记在 data/proxies.json 的 disabled 里），
   * 这样「配置里的条目必须一直存在」与「我暂时不想用它」两件事就不冲突了。
   * 轮换池条目同理，停用后不再参与任何选择。
   */
  function setEnabled(ids, enabled) {
    const wanted = new Set((ids || []).filter(Boolean));
    if (wanted.size === 0) return { ok: false, error: '未指定要操作的代理' };
    const changed = [];
    const skipped = [];
    for (const id of wanted) {
      const t = transports.find(x => x.id === id);
      if (!t) { skipped.push(id); continue; }
      const uiEntry = state.entries.find(e => e.id === id);
      if (uiEntry) uiEntry.enabled = !!enabled;
      if (enabled) state.disabled = state.disabled.filter(d => d !== id);
      else if (!state.disabled.includes(id)) state.disabled.push(id);
      changed.push(id);
    }
    if (changed.length === 0) return { ok: false, error: '没有找到要操作的代理', skipped };
    persistNow();
    reload();
    log('info', enabled ? '代理已启用' : '代理已停用', { count: changed.length });
    return { ok: true, changed, skipped };
  }

  /** 设置一个 Key 的代理绑定。keyId 是本项目 Key 池里的 id（ui 或外部派生）。 */
  function setBinding(keyFp, mode, proxyId) {
    const m = mode === 'bind' || mode === 'rotate' ? mode : 'auto';
    if (m === 'bind' && !proxyId) return { ok: false, error: 'bind 模式必须指定一个代理' };
    if (m === 'bind' && indexById(proxyId) < 0) {
      return { ok: false, error: '指定的代理不在当前池中（可能已删除或停用）' };
    }
    // 绑定一个**已停用**的代理等于让这个 Key 出不去：明确拒绝，而不是静默接受
    if (m === 'bind') {
      const t = transports.find(x => x.id === proxyId);
      if (!t || !t.enabled) return { ok: false, error: '指定的代理已停用，请先启用它' };
    }
    state.bindings[keyFp] = m === 'auto' ? { mode: 'auto', proxyId: '' } : { mode: m, proxyId: m === 'bind' ? proxyId : '' };
    persistNow();
    syncNodes();
    return { ok: true, mode: m, proxyId: state.bindings[keyFp].proxyId };
  }

  function bindingFor(key) {
    return bindingOf(key);
  }

  reload();
  startHealthChecks();

  return {
    list, keyViews, bindingFor, setBinding, fingerprintForKey: keyFingerprint,
    add, addBulk, update, remove, setEnabled, reveal,
    choose, markSuccess, markFailure, restoreProxy,
    test: (id) => {
      const t = transports.find(x => x.id === id);
      if (!t) return Promise.resolve({ ok: false, error: '代理不存在' });
      return testOne(t);
    },
    checkHealth, testMany, startHealthChecks, stopHealthChecks,
    reload, syncNodes,
    get size() { return transports.length; },
    get file() { return proxyFile; },
    get fileError() { return proxyFileError; },
    get path() { return PROXIES_PATH; },
    transports: () => transports,
    flush: persistNow,
  };
}
