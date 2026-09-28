// ── 模型启用/禁用状态 ──────────────────────────────────
// 存成**稀疏的禁用集合**：只记录被禁用的模型 id，其余一律视为启用。
// 这样上游目录变化时行为最自然 —— 新出现的模型默认可用，不需要为每个新模型补一条记录，
// 也不会因为上游临时少返回几个模型就把用户的启用列表冲掉。
//
// 「禁用」的语义（两处都生效，否则就只是个摆设）：
//   1) 不出现在 /v1/models 里 —— 下游客户端发现不到它；
//   2) 直接被指名调用时返回 400 并说明已被禁用 —— 避免「列表里没有但调用还能通」的怪状态。
// 注意只拒绝**明确被禁用**的模型；目录里没有的模型仍照旧透传，
// 否则目录一旦过期就会把本来能用的请求也拦下来。
import { dataPath, readJSON, writeJSONAtomic } from './store.mjs';

export const MODEL_STATE_PATH = dataPath('models.json');

export function createModelState({ log = () => {} } = {}) {
  const state = { version: 1, disabled: [] };
  const disabled = new Set();

  const loaded = readJSON(MODEL_STATE_PATH, null, (file, err) => {
    log('error', 'models.json 解析失败，已按「全部启用」启动（原文件未覆盖）', { file, error: err.message });
  });
  if (loaded && typeof loaded === 'object' && Array.isArray(loaded.disabled)) {
    for (const id of loaded.disabled) {
      if (typeof id === 'string' && id.trim()) disabled.add(id.trim());
    }
  }
  if (disabled.size) log('info', '模型启用状态已加载', { disabled: disabled.size });

  function persist() {
    state.disabled = [...disabled].sort();
    try {
      writeJSONAtomic(MODEL_STATE_PATH, state, 0o600);
      return { persisted: true };
    } catch (e) {
      log('error', 'models.json 写盘失败', { error: e.message });
      return { persisted: false, error: e.message };
    }
  }

  function isEnabled(id) {
    return !disabled.has(String(id ?? ''));
  }

  /** 过滤出启用的模型（用于 /v1/models 与批量测试的默认范围） */
  function filterEnabled(models) {
    return (models || []).filter(m => isEnabled(m.id));
  }

  /**
   * 批量启用/禁用。ids 为空则不做任何事。
   * 返回实际发生变化的 id 列表 —— 前端据此提示「实际改了几个」。
   */
  function setEnabled(ids, enabled) {
    const changed = [];
    for (const raw of ids || []) {
      const id = String(raw ?? '').trim();
      if (!id) continue;
      if (enabled) {
        if (disabled.delete(id)) changed.push(id);
      } else if (!disabled.has(id)) {
        disabled.add(id);
        changed.push(id);
      }
    }
    if (changed.length) {
      const r = persist();
      log('info', enabled ? '模型已启用' : '模型已禁用', { count: changed.length, persisted: r.persisted !== false });
    }
    return { changed };
  }

  /** 统计（用于后台概览） */
  function counts(models) {
    const list = models || [];
    let on = 0;
    for (const m of list) if (isEnabled(m.id)) on++;
    return { total: list.length, enabled: on, disabled: list.length - on };
  }

  /** 已失效的禁用记录（上游目录里已经没有的 id），仅用于提示，不自动清理 */
  function staleIds(models) {
    const known = new Set((models || []).map(m => m.id));
    return [...disabled].filter(id => !known.has(id));
  }

  return {
    isEnabled, filterEnabled, setEnabled, counts, staleIds,
    get disabledCount() { return disabled.size; },
    get disabledIds() { return [...disabled]; },
    get path() { return MODEL_STATE_PATH; },
  };
}
