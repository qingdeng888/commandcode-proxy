// ── 原子持久化 ────────────────────────────────────────
// 所有写盘走「临时文件 + rename」：rename 在同一文件系统内是原子的，
// 进程在写到一半被杀（OOM、docker stop 超时）只会留下一个 tmp 文件，
// 不会把 .json 截断成半个对象 —— 那会让下次启动读回坏配置。
//
// 读取一律容错：文件缺失/损坏都返回 fallback 并留有告警钩子，
// 绝不让一个坏文件把服务带崩（宁可回退默认值，也不拒绝启动）。
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, statSync, unlinkSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 数据目录：Key 池 / 后台密码 / 模型测试结论 / 请求日志都落在这里。
// 用 CC_DATA_DIR 可外挂到卷；Docker 部署把它做成 volume 即可持久化。
export const DATA_DIR = process.env.CC_DATA_DIR
  ? resolve(process.env.CC_DATA_DIR)
  : resolve(ROOT, 'data');

export function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }); } catch {}
}

export function fileExists(file) {
  try { return existsSync(file); } catch { return false; }
}

/** 文件 mtime（毫秒）；不存在或读不到返回 0。用于「外部改配置文件」的热加载探测。 */
export function fileMtimeMs(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

/**
 * 读 JSON。任何异常（不存在、权限、截断、非法 JSON）都返回 fallback。
 * onError 用于把「解析失败」这件事报出去 —— 静默吞掉坏文件是最难排查的一类线上问题。
 */
export function readJSON(file, fallback = null, onError = null) {
  try {
    const text = readFileSync(file, 'utf-8');
    return JSON.parse(text);
  } catch (e) {
    if (e?.code !== 'ENOENT' && onError) onError(file, e);
    return fallback;
  }
}

export function writeFileAtomic(file, text, mode = 0o600) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf-8', mode });
    renameSync(tmp, file);
    return true;
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function writeJSONAtomic(file, obj, mode = 0o600) {
  return writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', mode);
}

/**
 * 防抖落盘器：用量计数每个请求都会变，逐次写盘既费 IO 又无意义。
 * 攒 maxDelayMs 落一次；进程退出时调用 flush() 补最后一次。
 */
export function createDebouncedWriter(file, getValue, { maxDelayMs = 5000, onError = null } = {}) {
  let timer = null;
  let dirty = false;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    dirty = false;
    try {
      writeJSONAtomic(file, getValue());
    } catch (e) {
      if (onError) onError(e);
    }
  };

  return {
    /** 标记为脏；到达 maxDelayMs 后自动落盘 */
    markDirty() {
      dirty = true;
      if (timer) return;
      timer = setTimeout(() => { timer = null; flush(); }, maxDelayMs);
      timer.unref?.();
    },
    flush,
    get pending() { return dirty; },
  };
}

export function dataPath(name) {
  return join(DATA_DIR, name);
}
