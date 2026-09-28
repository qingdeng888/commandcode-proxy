// ── 日志总线 ──────────────────────────────────────────
// 解决两件事：
//   1) 后台「请求日志」页要能看到运行日志 —— 内存环形缓冲，最多留 500 条；
//   2) 实时推送用 SSE 而不是轮询（参考项目是 8s 轮询，延迟高且白跑请求）。
//
// 缓冲区与订阅者都在内存，不落盘：请求日志属于「看一眼就走」的数据，
// 落盘会带来磁盘写放大与隐私面（日志里有 URL、模型、错误体）。
// 需要长期留存的用 logFile（已有能力）。
import { EventEmitter } from 'events';

const MAX_ENTRIES = 500;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 级别过滤：CFG.logLevel 之前只是文档里的摆设，这里真正生效 */
export function levelEnabled(configured, level) {
  const threshold = LEVELS[String(configured || 'info').toLowerCase()] ?? LEVELS.info;
  return (LEVELS[level] ?? LEVELS.info) >= threshold;
}

export function createLogBus({ max = MAX_ENTRIES } = {}) {
  const entries = [];
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);   // 后台可能开多个标签页

  return {
    push(entry) {
      entries.push(entry);
      if (entries.length > max) entries.splice(0, entries.length - max);
      emitter.emit('log', entry);
    },
    /** 最新在前 */
    recent(limit = 200, level = null) {
      const threshold = level ? (LEVELS[level] ?? 0) : 0;
      const out = [];
      for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
        const e = entries[i];
        if (threshold && (LEVELS[e.level] ?? 0) < threshold) continue;
        out.push(e);
      }
      return out;
    },
    subscribe(fn) {
      emitter.on('log', fn);
      return () => emitter.off('log', fn);
    },
    get size() { return entries.length; },
  };
}
