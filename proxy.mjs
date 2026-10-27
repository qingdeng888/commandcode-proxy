/**
 * Command Code → OpenAI 兼容代理
 * 基于真实 CLI 流量抓包数据构建
 */
import http from 'http';
import https from 'https';
import tls from 'tls';
import { Readable } from 'stream';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { appendFileSync } from 'fs';

// ── 本地模块 ──────────────────────────────────────
// 配置 / 持久化 / Key 池 / 后台统统拆到 lib/ 下，本文件只保留数据面（转发）与进程装配。
//
// 热加载的两条约定：
//   1) CFG 是**同一个对象**，lib/config.mjs 靠 Object.assign 原地改 —— 下面几百处
//      `CFG.xxx` 读取无需改动，也不会出现「新旧两份配置」并存的窗口；
//   2) Key 池在每次选 Key 时现取，后台改完立即生效，不需要重启也不需要 fs.watch。
import { CFG, DOTENV, startConfigWatcher } from './lib/config.mjs';
import { DATA_DIR } from './lib/store.mjs';
import { createLogBus, levelEnabled } from './lib/logbus.mjs';
import { createKeyPool } from './lib/keys.mjs';
import { createApiKeyPool, looksLikeUpstreamKey } from './lib/api-keys.mjs';
import { createAdminAuth } from './lib/admin-auth.mjs';
import { createModelCatalog, createModelTestRunner, classifyProbe } from './lib/models.mjs';
import { createModelState } from './lib/model-state.mjs';
import { createAdminApi } from './lib/admin-api.mjs';

// 本分支的配置统一由 lib/config.mjs 承担（分层：env > data/settings.json >
// config.json > 默认值），proxy.mjs 里不再有 loadConfig()。
// PR #53 的 useProviderModelsWithPlanFilter、PR #46 的 webSearch 都已加进 lib/config.mjs。
const SERVER_STARTED_AT = Date.now();

// 日志总线：给后台「请求日志」页 + SSE 实时推送用
const logBus = createLogBus();

// Key 池：视 UI Key + config/env Key 为一个轮询池
const keyPool = createKeyPool({ log: (...args) => log(...args) });

// 2API Key：本项目自己签发给**下游客户端**的凭证（与上游 Key 完全两套东西，见 lib/api-keys.mjs）
const apiKeyPool = createApiKeyPool({ log: (...args) => log(...args) });

// 后台鉴权（与数据面的凭证体系又是另一套：它管的是「谁能打开面板」）
const adminAuth = createAdminAuth({ log: (...args) => log(...args) });

// ── 设备指纹（形态与哈希逐字对齐官方 CLI；1.53.1 对齐，1.88.0 复核未变） ──
// CPU 型号与核数对应表（仅 Windows x64）。
// ⚠️ 上网的 components.cpuCount 必须是 **threads** 而不是 cores ——
// CLI 的 gatherRawSignals 取的是 `os.cpus().length`，即**逻辑处理器数**。
// 这一对是明文上传的（components 里只有 machineId/mac/osUser/hostname/gitEmail 走哈希），
// 所以 cpuModel 与 cpuCount 可以被服务端交叉核对：填物理核数等于宣称「这台机器关了超线程」，
// 而原表 15 项全是物理核数 —— 100% 的指纹都落在这个罕见表述上，是群体分布层面的特征。
// （实现参考 @jinyu2022 的 PR #35，数字逐项复核过。）
const FINGERPRINT_CPUS = [
  { model: '12th Gen Intel(R) Core(TM) i7-12650H', cores: 10, threads: 16 },   // 6P+4E
  { model: '12th Gen Intel(R) Core(TM) i5-12400F', cores: 6,  threads: 12 },
  { model: '12th Gen Intel(R) Core(TM) i9-12900K', cores: 16, threads: 24 },   // 8P+8E
  { model: '13th Gen Intel(R) Core(TM) i7-13700K', cores: 16, threads: 24 },   // 8P+8E
  { model: '13th Gen Intel(R) Core(TM) i5-13600K', cores: 14, threads: 20 },   // 6P+8E
  { model: '13th Gen Intel(R) Core(TM) i9-13900K', cores: 24, threads: 32 },   // 8P+16E
  { model: 'Intel(R) Core(TM) Ultra 7 155H',       cores: 16, threads: 22 },   // 6P+8E+2LPE（Meteor Lake 有超线程）
  { model: 'Intel(R) Core(TM) Ultra 9 285H',       cores: 16, threads: 16 },   // 6P+8E+2LPE（Arrow Lake 取消超线程）
  { model: 'Intel(R) Core(TM) i9-14900K',          cores: 24, threads: 32 },   // 8P+16E
  { model: 'Intel(R) Core(TM) i7-14700K',          cores: 20, threads: 28 },   // 8P+12E
  { model: 'AMD Ryzen 7 7800X3D',                  cores: 8,  threads: 16 },
  { model: 'AMD Ryzen 9 7950X',                    cores: 16, threads: 32 },
  { model: 'AMD Ryzen 5 7600',                     cores: 6,  threads: 12 },
  { model: 'AMD Ryzen 9 7900X',                    cores: 12, threads: 24 },
  { model: 'AMD Ryzen 7 5800X3D',                  cores: 8,  threads: 16 },
];
const FINGERPRINT_MEMS = [8, 16, 24, 32, 48, 64];
const FINGERPRINT_TZS = [
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Toronto',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Seoul', 'Asia/Hong_Kong',
  'Australia/Sydney', 'Pacific/Auckland',
];
const FINGERPRINT_MAC_COUNT_RANGE = [2, 3, 4, 5]; // 随机 2~5 个 MAC

// ── 为什么指纹必须由 apiKey 确定性派生（而不是随机） ──────────────
// 指纹代表「这个账号对应的那台设备」。原实现每进程随机生成一台新机器，
// 会在两个场景下毫无理由地漂移：① 进程重启 ② 多实例各算各的。
// 第三个场景曾是「会话过期清理连带 keyStateStore.delete」：该清理路径已随
// x-session-id 改为按请求内容派生而消失（服务端不再有会话状态）；keyStateStore
// 如今只剩 24h 空闲淘汰，而淘汰已无害 —— 重新派生出的还是同一个值。
// 设备身份无故更换本身就是信号。
//
// 也不能退化成「按 key 取哈希桶选设备」：桶方案的熵上限就是桶数，key 数一旦
// 超过桶数必然出现多个 key 共用指纹，而上游 device_fingerprints 表对
// (userId, thumbmark) 建了唯一索引 —— 共用指纹等于「多账号同机」的直接证据。
// 派生方案每个 key 都是独立设备，碰撞概率 2^-256。
//
// 原始信号值（MachineGuid / MAC / 主机名 / git 邮箱）只存在于本进程内存，
// 出网的永远只有它们的哈希。
// CLI 的根盐（buildMachineFingerprint 常量 sb）
const FP_SALT = 'command-code:device-fingerprint:v1';
// 设备档案：指纹 / config.environment / config.workingDir / x-project-slug / lifecycle.os 共用同一份，
// 避免出现「指纹说 win32、环境说 linux」这类自相矛盾，也避免把宿主机真实信息（平台、Node 版本、cwd）交给上游。
const DEVICE_PROFILE = {
  platform: 'win32',
  arch: 'x64',
  osRelease: '10.0.22631',
  isContainer: false,
  // 伪造的项目目录：与 x-project-slug 同源（真机里 slug = slugify(workingDir)）
  projectDir: CFG.deviceProjectDir || 'C:\\Users\\dev\\projects\\app',
};
const FP_OS_USERS = ['dev', 'user', 'admin', 'coder', 'engineer', 'work'];
const FP_MAIL_DOMAINS = ['gmail.com', 'outlook.com', 'qq.com', '163.com'];

// 伪造信号的派生源。加 CC_FINGERPRINT_SALT 可成批换身份 —— 真实账号的 key 动不了，这是逃生口。
// 注意：哈希阶段用的是 CLI 的固定盐（FP_SALT），salt 只影响「伪造出哪台机器」。
function fpDigest(apiKey, field) {
  return crypto.createHash('sha256')
    .update(`${CFG.fingerprintSalt || ''}\0${apiKey}\0${field}`)
    .digest();
}
// 从候选池确定性地挑一项：打分取最大。以后往池里加候选只影响「新候选恰好胜出」的那部分 key，
// 不会像取模那样因为池长度变化让所有 key 一起换设备。
function fpPickIndex(apiKey, field, items, labelOf) {
  let bestIdx = 0;
  let bestScore = null;
  for (let i = 0; i < items.length; i++) {
    const score = fpDigest(apiKey, `${field}\0${labelOf(i)}`);
    if (!bestScore || Buffer.compare(score, bestScore) > 0) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}
// CLI 的 hashSignal：sha256(FP_SALT + "\0" + value.toLowerCase())，空值返回 undefined（JSON 里被丢掉）
function fingerprintHash(value) {
  const v = String(value ?? '').trim();
  if (!v) return undefined;
  return crypto.createHash('sha256').update(`${FP_SALT}\0${v.toLowerCase()}`).digest('hex');
}

// 与 CLI 的唯一区别是「信号值」：CLI 读真实机器（注册表 / ioreg / machine-id、网卡 MAC、
// os.userInfo、git config），这里按 apiKey 确定性地伪造一组逼真值。
// 为什么必须由 apiKey 派生而不是随机：指纹代表「这个账号对应的那台设备」，重启、内存回收、
// 多实例、月额度用尽停用数周后恢复，上游都应看到同一台设备；换指纹本身就是可疑信号。
function generateFingerprint(apiKey) {
  const cpuEntry = FINGERPRINT_CPUS[fpPickIndex(apiKey, 'cpu', FINGERPRINT_CPUS, i => `${FINGERPRINT_CPUS[i].model}|${FINGERPRINT_CPUS[i].cores}`)];
  const memGiB = FINGERPRINT_MEMS[fpPickIndex(apiKey, 'mem', FINGERPRINT_MEMS, i => String(FINGERPRINT_MEMS[i]))];
  const tz = FINGERPRINT_TZS[fpPickIndex(apiKey, 'timezone', FINGERPRINT_TZS, i => FINGERPRINT_TZS[i])];
  const macCount = FINGERPRINT_MAC_COUNT_RANGE[fpPickIndex(apiKey, 'macCount', FINGERPRINT_MAC_COUNT_RANGE, i => String(FINGERPRINT_MAC_COUNT_RANGE[i]))];
  const osUser = FP_OS_USERS[fpPickIndex(apiKey, 'osUser', FP_OS_USERS, i => FP_OS_USERS[i])];
  const mailDomain = FP_MAIL_DOMAINS[fpPickIndex(apiKey, 'mailDomain', FP_MAIL_DOMAINS, i => FP_MAIL_DOMAINS[i])];
  const hex = (field, bytes) => fpDigest(apiKey, field).subarray(0, bytes).toString('hex');
  // Windows MachineGuid 形状：8-4-4-4-12
  const mid = hex('machineId', 16);
  const machineId = `${mid.slice(0, 8)}-${mid.slice(8, 12)}-${mid.slice(12, 16)}-${mid.slice(16, 20)}-${mid.slice(20, 32)}`;
  const macs = [];
  for (let i = 0; i < macCount; i++) {
    const b = fpDigest(apiKey, `mac${i}`).subarray(0, 6);
    macs.push([...b].map(x => x.toString(16).padStart(2, '0')).join(':'));
  }
  macs.sort(); // CLI 对 MAC 去重后排序
  const hostname = `DESKTOP-${hex('hostname', 4).toUpperCase()}`;
  const gitEmail = `${osUser}.${hex('gitEmail', 3)}@${mailDomain}`;

  const machineIdHash = fingerprintHash(machineId);
  const macHashes = macs.map(fingerprintHash).filter(Boolean);
  const osUserHash = fingerprintHash(osUser);
  const hostnameHash = fingerprintHash(hostname);
  const gitEmailHash = fingerprintHash(gitEmail);

  // CLI 的 thumbmark：主盐 + "\0machine\0" + join([machineId, macs.join(",")])
  // （machineId 非空时不再拼 hostname/cpuModel）
  const thumbSeed = [machineId.trim(), macs.join(','), machineId.trim() ? '' : hostname, machineId.trim() ? '' : cpuEntry.model].filter(Boolean);
  const thumbmark = crypto.createHash('sha256').update(`${FP_SALT}\0machine\0${thumbSeed.join('|') || 'unknown'}`).digest('hex');

  return {
    thumbmark,
    components: {
      machineIdHash,
      macHashes,
      osUserHash,
      hostnameHash,
      gitEmailHash,
      platform: DEVICE_PROFILE.platform,
      arch: DEVICE_PROFILE.arch,
      osRelease: DEVICE_PROFILE.osRelease,
      cpuModel: cpuEntry.model,
      cpuCount: cpuEntry.threads,   // 逻辑处理器数，对齐 CLI 的 os.cpus().length
      memGiB,
      isContainer: DEVICE_PROFILE.isContainer,
      timezone: tz,
      runtime: 'cli',
      collectorVersion: 1,
    },
  };
}

// 本代理**实际实现**的 wire 协议版本（对齐 command-code@1.88.0 源码）。
// 真机发的永远是「形状 + 版本号」自洽的组合；如果版本号跟着 npm 走而形状没变，
// 就变成「自称最新版、却说旧方言」—— 这比版本号过期更容易被行为分析挑出来。
// 因此这里报的是协议版本，npm 上更新了只告警、不自动改。
//
// 1.53.1 → 1.87.1 逐条比对 dist/cli.mjs 后，**影响本代理**的差异只有下面几条
// （生成端点、9 键信封与键序、toWireMessages/toWireTools/toWireSystem 的形状全部未变）：
//   · 头部常量表新增 x-cli-surface：只在 acp / rpc 这类非交互入口才发，普通会话不发；
//     另有 x-oss-primary-provider、x-cmd-provider-deepseek-internal，分别是 BYOK 与
//     内部账号的开关，普通会话同样不发 —— 本代理一律不发，与「普通会话」保持一致；
//   · 流事件新增 cache-write-tokens（把 cacheWriteTokens 单独作为一条事件回传，
//     供 usage 缺该字段时补齐）与 tool-result / server_tool_result（providerExecuted
//     的服务端工具结果），旧代理会把它们打成 Unknown CC event type；
//   · finishReason 归一化新增 refusal：refusal / content_filter / content-filter 三种
//     写法都算「被拦截」，CLI 的 consumedStopReason 会先判它再判 tool-calls/length；
//   · 没有 finish 事件时仍抛 "no finish event" 的可重试 502（与 1.53.1 一致）。
//
// 1.87.1 → 1.88.0 复核（同法比对，结论：纯请求头同步，运行时契约零变化）：
//   · 端点集合 25 个，双向零增零减；
//   · 透传的六个自定义头（x-command-code-version / x-cli-environment / x-project-slug /
//     x-taste-learning / x-session-id / x-cmd-zdr）出现次数逐个相同；
//   · toWireMessages / toWireTools / toWireSystem / toWireToolOutput /
//     toWirePermissionMode / toWireThreadId / consumedStopReason 逐字相同；
//   · consumeStream 只发生标识符改名，抹掉标识符后**逐字相同**（事件词汇表零变化）；
//   · 指纹盐仍是 'command-code:device-fingerprint:v1'（只是变量名从 oP 改成 tP），
//     buildMachineFingerprint / hashSignal 的算法与字段集合不变。
// 唯一变化是内置模型注册表里若干行增加了 hidden 标记 —— 那是模型目录内容，
// 而且本项目本来就从 /provider/v1/models 动态拉取，不依赖内置表。
const CC_PROTOCOL_VERSION = '1.88.0';
let CC_VERSION = CC_PROTOCOL_VERSION;
const CC_VERSION_REFRESH_MS = 24 * 60 * 60 * 1000; // 24h — 检查一次是否发生漂移

// ── 协议漂移检测（只告警，不改版本号） ─────────────
// 上游 CLI 更新可能带来协议变化。这里只负责提醒「该重新读包对齐了」，
// 绝不会把 x-command-code-version 改成一个我们并未实现的版本。
async function checkProtocolDrift() {
  try {
    const url = 'https://registry.npmjs.org/command-code/latest';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`npm responded with ${res.status}`);
    const pkg = await res.json();
    const latest = typeof pkg?.version === 'string' ? pkg.version : null;
    if (latest && latest !== CC_PROTOCOL_VERSION) {
      log('warn', 'CC CLI version drift: protocol may have changed, re-align from the npm package', {
        implemented: CC_PROTOCOL_VERSION, latest,
      });
    } else if (latest) {
      log('info', 'CC CLI version in sync', { version: latest });
    }
  } catch (e) {
    log('warn', 'CC version check failed', { error: e.message });
  }
}
checkProtocolDrift(); // 启动时立即检查
setInterval(checkProtocolDrift, CC_VERSION_REFRESH_MS);

// 请求体大小上限：默认 100MB，可用环境变量 CC_MAX_BODY_MB 覆盖（正整数，单位 MB）。
// 默认值保持 100MB（573e260 为修 issue #7 设定）——不要下调，理由是有实际证据的：
//   #7 的真实触发场景是多模态长会话，21 张 Base64 图片累积到约 10.11 MiB 的合法请求，
//   下调到 4~8MB 会把这类请求整体挡在门外。#7 的「Connection error」症状由
//   「超限返回 413 + 排空连接」这条路径解决，与阈值取值无关；但阈值决定了功能边界，
//   所以默认值必须容纳真实的多模态上下文。
// ⚠️ 内存特性（issue #20 实测）：请求体在转发到上游前会同时存在多份副本 ——
//    chunks[] / Buffer.concat / utf8 字符串 / JSON.parse 对象树 / buildCcRequest 重建对象树 / JSON.stringify 序列化体。
//    实测峰值 ≈ body 大小 × 5.1~7.4（7MB→+52MB，20MB→+116MB；而 413 拒绝路径只要 ×1.05）。
//    故 100MB 上限意味着「单个请求」最坏可吃 ~550MB，且该上限是每请求的、不是全局的。
//    正因为阈值必须留足，#20 的第二半必须补齐：并发侧要有约束。
//    进程内可用 CC_MAX_INFLIGHT，边缘侧用反向代理 limit_conn
//    （见 README「内存与部署」）。
const MAX_BODY_SIZE = (() => {
  const mb = Number.parseInt(process.env.CC_MAX_BODY_MB ?? '', 10);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 100 * 1024 * 1024;
})();
// 上游读空闲超时（issue #19）：只计「reader.read() 的等待」，每收到一个 chunk 重置，
// 不是整个请求的总时长。默认值保持不变（30s / 90s），可用环境变量覆盖 ——
// 官方 CLI 对上游没有任何 idle timeout（反编译 command-code@1.50.0 已验证，
// createApiClient 调用点均未传 timeout），合法的长思考停顿可达数百秒，
// 遇到推理模型被 30s 误杀 / 触发 429 重试放大时，调大这两个值即可。
const STREAM_IDLE_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_STREAM_IDLE_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 30000;   // 默认 30s — 流式无新数据中断
})();
const NONSTREAM_IDLE_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_NONSTREAM_IDLE_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 90000;   // 默认 90s — 非流式超时更宽容
})();

// ── 上游闪断透明重试（未吐字前 bounded retry）─────────
// CC 上游在高峰期会中途掐断流，undici 抛 `TypeError: terminated`
// （cause 多为 SocketError: other side closed）。若此刻尚未向下游写出任何字节，
// 这个请求对下游而言从未开始过 —— 代理内部重试即可消化抖动，下游（CPA / 客户端）
// 不必看到 502 再自行退避。
// 只在「未吐字」时重试：一旦写过头或输出过事件，语义就已提交，重试会造成重复文本。
// 默认 2 = 最多重试 2 次（共 3 次尝试）；CC_UPSTREAM_RETRY_MAX=0 可整体关闭。
const UPSTREAM_RETRY_MAX = (() => {
  const n = Number.parseInt(process.env.CC_UPSTREAM_RETRY_MAX ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
})();
const UPSTREAM_RETRY_BASE_MS = (() => {
  const ms = Number.parseInt(process.env.CC_UPSTREAM_RETRY_BASE_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 400;   // 退避 = base × 尝试序号
})();

// 区分「传输层闪断」（可安全重试）与「语义错误」（不可重试）。
// STREAM_IDLE_TIMEOUT 是刻意发给下游的「请减少上下文」信号，绝不重试。
function isRetryableUpstreamError(e) {
  if (!e) return false;
  const blob = [e.message, e.code, e.cause?.message, e.cause?.code].filter(Boolean).join(' | ');
  if (/STREAM_IDLE_TIMEOUT/.test(blob)) return false;
  return /terminated|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|socket hang up|other side closed|fetch failed/i.test(blob);
}

// 仅用于日志：rewinds = 实际重试次数，recovered = 重试后成功交付的次数
const upstreamRetryStats = { rewinds: 0, recovered: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 客户端「僵死」保护：既不读也不断开时，该请求会连带上游连接一直挂着（背压修复后的残留）。
// 实测残留在途成本约 5MB/连接 —— 有界、不泄漏、断开即回收，但连接数本身无上限。
// 默认 0 = 禁用，保持既有行为不变：僵死客户端与「卡在工具执行的合法客户端」在协议层无法
// 区分，而官方 CLI 对上游没有任何 idle timeout（issue #19），贸然加超时会误杀健康请求。
// 在途请求上限（可选，默认关闭）。项目定位是纯反代层，并发控制属于下游（nginx
// limit_conn，per-IP / per-key）；本项仅为「不挂反代裸跑」的场景提供一个可选的
// 进程内全局兜底，不替代下游方案，也不感知客户端身份。
// 内存 = 在途数 × (0.13MB + 5.5 × body_MB)：body 上限只管住单请求量级，乘数由本项封顶。
// 超限返回 503 + Retry-After（SDK 会自行退避重试），而不是放任进程被 OOM 杀掉。
// 默认 0 = 关闭，不限制并发（既有的反代层定位不变，行为零变化）；需要时按需开启：
//   CC_MAX_INFLIGHT=32 npm start
// 注意：body 上限只管住单请求量级，乘数由本项封顶。默认 body 上限 100MB 时，
// N × 最坏 550MB —— 要硬性内存上界需同时下调 CC_MAX_BODY_MB。
const MAX_INFLIGHT = (() => {
  const n = Number.parseInt(process.env.CC_MAX_INFLIGHT ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;            // 默认 0 = 不限
})();

let inflightCount = 0;   // 当前在途请求数（不含 /health）

const CLIENT_DRAIN_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_CLIENT_DRAIN_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
})();

// 连续超时计数：同一会话连续 3 次超时才提醒压缩上下文，任意成功请求后重置。
//
// 为什么按会话（而不是全进程一个计数）：一个计数器会让**毫不相干的会话**互相误伤 ——
// A 会话卡住两次，B 会话第一次超时就被劝去压缩上下文，而它的请求根本没变大。
// 参考实现（dsh-commandcode-provider 的 gradeHeaderTimeout）也是按 session 建 streak
// 并做 FIFO 淘汰；本项目把 key 换成会话 id，其余口径一致。
//
// 无会话标识的请求落到同一个槽位（GLOBAL_TIMEOUT_KEY），保持「全局单值」的旧语义 ——
// 否则它们永远不会累积到阈值，提示就再也不会出现。
const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3;
const GLOBAL_TIMEOUT_KEY = '\u0000global';
/** 会话数上限：一个被放弃的会话不该永久占用一条记录（参考实现同样有上限）。 */
const TIMEOUT_STREAK_MAX_ENTRIES = 200;
const timeoutStreaks = new Map();   // sessionKey → 连续超时次数

/** 记录一次超时，返回截至当前的连续次数（同一 key 才会累加）。 */
function noteTimeout(sessionKey) {
  const key = sessionKey || GLOBAL_TIMEOUT_KEY;
  const next = (timeoutStreaks.get(key) || 0) + 1;
  // 重新插入使 Map 的顺序成为 LRU：淘汰时丢掉最久没动静的那些会话
  timeoutStreaks.delete(key);
  timeoutStreaks.set(key, next);
  if (timeoutStreaks.size > TIMEOUT_STREAK_MAX_ENTRIES) {
    const oldest = timeoutStreaks.keys().next().value;
    if (oldest !== undefined) timeoutStreaks.delete(oldest);
  }
  return next;
}

/** 一次成功请求后清掉该会话的 streak。 */
function clearTimeouts(sessionKey) {
  const key = sessionKey || GLOBAL_TIMEOUT_KEY;
  if (timeoutStreaks.size > 0) timeoutStreaks.delete(key);
}

/** 超时提示：同一会话连续超时才劝压缩上下文。 */
function timeoutMessage(sessionKey) {
  return noteTimeout(sessionKey) >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
    ? 'Response timeout - try reducing context length (summarize earlier messages)'
    : 'Response timeout - request timed out';
}

// ── 日志 ─────────────────────────────────────────────
// CFG.logLevel 以前只是文档里的摆设（代码从不读它）。现在真正生效，
// 并同时送进日志总线 —— 后台「请求日志」页与 SSE 推送都从那里取。
function log(level, msg, data) {
  if (!levelEnabled(CFG.logLevel, level)) return;
  const entry = { time: new Date().toISOString(), level, msg };
  if (data !== undefined) entry.data = data;
  const line = `[${entry.time}] [${level}] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  if (CFG.logFile) {
    try { appendFileSync(CFG.logFile, line + '\n', 'utf-8'); } catch {}
  }
  logBus.push(entry);
}

// 把上游错误体摘要成单行，便于日志排查。
// 之前 CC API error 只记 status，不记 body —— 遇到 400 只能靠猜（问题来源见 hk_sji 排查）。
// 截断到 500 字符，避免异常大的 body 刷爆日志；同时压掉换行，保证一条日志一行。
function summarizeUpstreamError(text, limit = 500) {
  if (!text) return '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit) + '…(' + (flat.length - limit) + ' more)' : flat;
}

/**
 * 按请求内容派生 UUID：apiKey + model + system + 首个非 user 消息之前的连续 user 文本。
 * @param {string} apiKey 上游账号 key
 * @param {CcRequestBody} ccBody buildCcRequest 的返回值
 * @returns {string} UUID 字符串
 */
function deriveSessionId(apiKey, ccBody) {
  const params = (ccBody && ccBody.params) || {};
  // 逐块喂入，'\0'分隔
  const h = crypto.createHash('sha1');
  h.update(apiKey || '').update('\0');
  h.update(params.model || '').update('\0');
  if (Array.isArray(params.system)) {
    for (const b of params.system || []) {
      if (b && typeof b.text === 'string') h.update(b.text).update('\0');
    }
  }
  for (const msg of params.messages || []) {
    if (msg.role !== 'user') break; // assistant / tool 起始后的输入不参与派生
    if (!Array.isArray(msg.content)) continue;
    for (const p of msg.content) {
      if (p.type === 'text' && typeof p.text === 'string') h.update(p.text).update('\0');
    }
  }
  const bytes = h.digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getSessionId(incomingHeaders, apiKey, promptCacheKey, ccBody) {
  // 优先从客户端传来的 session 类 header 获取：它同时决定上游的缓存命名空间，
  // 一旦被代理替换成自生成的值，同一会话此前累积的前缀缓存就再难命中。
  const candidates = [
    incomingHeaders['x-session-id'],
    incomingHeaders['x-claude-code-session-id'],
    incomingHeaders['session_id'],
    promptCacheKey,
  ];
  for (const id of candidates) {
    if (id && typeof id === 'string' && id.length >= 8) return { id, source: 'client' };
  }
  // 客户端未提供会话标识时按请求内容派生（PR #29：同一多轮对话派生同一 UUID，保证缓存命中）
  return { id: deriveSessionId(apiKey, ccBody), source: 'derived' };
}

// CC 线上信封的 threadId 只接受合法 UUID —— 对应 CLI 的 toWireThreadId：
// uuid.safeParse 失败即返回 undefined，该键随之被 JSON.stringify 丢弃。
// 非 UUID 的 session 值一律不发，避免上游看到真 CLI 永远不会产生的 threadId。
function isWireUuid(v) {
  return typeof v === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// ── 每 Key 独立状态（fingerprint + 初始化节流） ──
// 指纹现在是确定性派生的，所以这个 Map 只是缓存：淘汰它不会改变该 key 的设备身份，
// 只是下次多算一次 HMAC。淘汰按「空闲」而非「session 过期」判定，
// 这样活跃 key 的 nextInitAt 不会被重置（否则会重复发送指纹/lifecycle 预请求）。
const KEY_STATE_IDLE_MS = 24 * 60 * 60 * 1000; // 24h 未活动即淘汰
const keyStateStore = new Map(); // apiKey → { fingerprint, nextInitAt, lastSeen }

function getOrCreateKeyState(apiKey) {
  let state = keyStateStore.get(apiKey);
  if (!state) {
    state = {
      fingerprint: generateFingerprint(apiKey),
      nextInitAt: 0,
      lastSeen: 0,
    };
    keyStateStore.set(apiKey, state);
    log('info', 'Fingerprint derived for key', {
      keyPrefix: apiKey.slice(0, 8),
      thumbmark: state.fingerprint.thumbmark.slice(0, 12),
    });
  }
  state.lastSeen = Date.now();
  return state;
}

// 空闲淘汰：纯内存卫生，不影响设备身份（见上）
setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [key, state] of keyStateStore) {
    if (now - state.lastSeen > KEY_STATE_IDLE_MS) { keyStateStore.delete(key); evicted++; }
  }
  if (evicted > 0) log('info', 'Key state evicted (idle)', { evicted, remaining: keyStateStore.size });
}, 60 * 60 * 1000); // 每小时

// ── 初始化预请求（fingerprint + lifecycle，首次 + 每 8h+2h 抖动） ────
const INIT_REFRESH_MS = 8 * 60 * 60 * 1000;    // 8h
const INIT_JITTER_MS  = 2 * 60 * 60 * 1000;    // 2h 抖动

async function ensureInitialized(apiKey, signal) {
  const state = getOrCreateKeyState(apiKey);
  const now = Date.now();
  if (now < state.nextInitAt) return;

  try {
    // 并行发两个预请求
    const headers = {
      'Content-Type': 'application/json',
      // 官方 CLI 的指纹预请求与生成请求共用同一个 header 常量表（lb = vy = "cli"），
      // 因此预请求同样是 User-Agent: cli。此前只有 forwardToCC 设了它，
      // 预请求走 Node 默认的 "node" —— 同一账号的指纹注册与生成请求来自两种 UA，
      // 是可直接观测的破绽。
      'User-Agent': 'cli',
      'x-cli-environment': 'production',
      'Authorization': `Bearer ${apiKey}`,
      'x-command-code-version': CC_VERSION,
      ...(CFG.zdr ? { 'x-cmd-zdr': '1' } : {}),
    };
    const fingerprint = state.fingerprint || {};

    await Promise.all([
      upstreamFetch(`${CFG.apiBase}/alpha/fingerprint/record`, {
        method: 'POST', headers, signal,
        body: JSON.stringify(fingerprint),
      }).then(r => {
        if (!r.ok) log('warn', 'Fingerprint record failed', { status: r.status });
        else log('info', 'Fingerprint recorded');
      }).catch(e => {
        if (e.name !== 'AbortError') log('warn', 'Fingerprint record error', { error: e.message });
      }),

      upstreamFetch(`${CFG.apiBase}/alpha/lifecycle-events`, {
        method: 'POST', headers, signal,
        body: JSON.stringify({
          eventType: 'cli_session_exists',
          metadata: {
            sessionId: `sess_${crypto.randomBytes(8).toString('hex')}`,
            cliVersion: CC_VERSION,
            mode: CFG.cliSessionMode || 'interactive',
            os: `${fingerprint.components.platform}-${fingerprint.components.arch}`,
          },
        }),
      }).then(r => {
        if (!r.ok) log('warn', 'Lifecycle event failed', { status: r.status });
        else log('info', 'Lifecycle event sent');
      }).catch(e => {
        if (e.name !== 'AbortError') log('warn', 'Lifecycle event error', { error: e.message });
      }),
    ]);

    // 成功：8h + 2h 随机抖动
    const jitter = Math.floor(Math.random() * INIT_JITTER_MS);
    state.nextInitAt = Date.now() + INIT_REFRESH_MS + jitter;
    log('info', 'Fingerprint/lifecycle next refresh', { nextIn: `${(INIT_REFRESH_MS + jitter) / 3600000}h` });
  } catch (e) {
    if (e.name !== 'AbortError') log('warn', 'Fingerprint/lifecycle refresh error, will retry next request', { error: e.message });
  }
}

// ── 模型列表 ───────────────────────────────────────
const MODELS = [
  // Anthropic
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  // OpenAI
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  // DeepSeek
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  // Kimi
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6' },
  { id: 'moonshotai/Kimi-K2.5', name: 'Kimi K2.5' },
  // GLM
  { id: 'zai-org/GLM-5.1', name: 'GLM 5.1' },
  { id: 'zai-org/GLM-5', name: 'GLM 5' },
  // MiniMax
  { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3' },
  { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7' },
  { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5' },
  // Qwen
  { id: 'Qwen/Qwen3.6-Max-Preview', name: 'Qwen 3.6 Max Preview' },
  { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus' },
  { id: 'Qwen/Qwen3.7-Max', name: 'Qwen 3.7 Max' },
  // Step
  { id: 'stepfun/Step-3.7-Flash', name: 'Step 3.7 Flash' },
  { id: 'stepfun/Step-3.5-Flash', name: 'Step 3.5 Flash' },
  // Xiaomi
  { id: 'xiaomi/mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
  { id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5' },
  // Gemini
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
];

// 模型目录：从 CC 上游 /provider/v1/models 拉取（实测 82 个模型，带 context_length 与
// supported_endpoints）。拉取失败时回退到上面的静态列表，并标记 source:'static'，
// 后台会把它显示出来 —— 静默用一份过期列表比报错更难排查。
const catalog = createModelCatalog({
  staticModels: MODELS,
  log: (...args) => log(...args),
  fetchImpl: (url, options) => upstreamFetch(url, {
    ...options,
    headers: { ...(options?.headers || {}), 'x-command-code-version': CC_VERSION },
  }),
});

// 模型的启用/禁用状态（后台可批量改，落盘 data/models.json）。
// 不只影响后台列表：禁用后 /v1/models 不再返回它，直接指名调用也会被拒 —— 否则就只是摆设。
const modelState = createModelState({ log: (...args) => log(...args) });

/**
 * 客户端没指定 model 时的兜底选择。
 *   1) 后台配的「默认测试模型」（若它启用且在目录中）—— 用户显式指定的意图优先；
 *   2) 目录里第一个启用、且支持该端点的模型；
 *   3) 目录里第一个启用的模型；
 *   4) 最后才退回写死的 id（目录不可用时的保险）。
 *
 * 之前三处都是直接写死 'deepseek/deepseek-v4-flash' / 'claude-sonnet-4-6'：
 * 一旦后台把那个模型禁用了，不带 model 的请求就会莫名其妙地 400。
 */
function fallbackModel(hardcoded, endpoint = null) {
  const enabled = modelState.filterEnabled(catalog.list());
  if (CFG.defaultModel && modelState.isEnabled(CFG.defaultModel) && catalog.get(CFG.defaultModel)) {
    return CFG.defaultModel;
  }
  if (endpoint) {
    const fit = enabled.find(m => !m.supportedEndpoints || m.supportedEndpoints.includes(endpoint));
    if (fit) return fit.id;
  }
  if (enabled.length) return enabled[0].id;
  return hardcoded;
}

/**
 * 是否允许使用该模型。只拦「明确被禁用」的模型；
 * 目录里没有的模型仍照旧透传（目录可能过期，不能因此把能用的请求拦掉）。
 * 返回 null 表示放行，否则返回给下游的错误说明。
 */
function disabledModelError(requestedModel) {
  if (!requestedModel) return null;
  if (modelState.isEnabled(requestedModel)) return null;
  return `模型 ${requestedModel} 已在后台被禁用（可在 /admin/ 的「模型」页重新启用）`;
}

// ── 探测（Key 测试 / 模型测试）────────────────────────
// 「模型测试」= 用指定 Key 对指定模型发一次真实最小请求，按上游返回的错误码归类。
//
// 为什么不用参考项目 Cline-proxy 的「余额差值探测」：那套方案依赖查询账户余额
// （跑一次模型前后各查一次，掉余额=收费模型）。Command Code **没有任何余额/用量接口**
// —— 实测 /provider/v1/usage、/provider/v1/balance、/api/v1/users/me 全部 404。
// 因此改为就地判定：能不能跑通、因为什么跑不通，由上游错误码直接回答。

// 探测提示词：默认值与参考项目 Cline-proxy 保持一致，后台可自定义（见 /admin/ 的上游连通性测试）。
// 默认值只在后端定义一处，前端通过 GET /admin/api/config 的 defaultTestMessage 取值预填 ——
// 两边各写一遍迟早会不一致。
const DEFAULT_TEST_MESSAGE = '你是谁，出来干活了';
const MAX_TEST_MESSAGE_LEN = 4000;

// 探测要收多少回复，分两种场景（这是刻意的差异）：
//   single —— 后台手点的单次测试：目的就是「看看这个模型到底回了什么」，
//             所以给足 token 与字符，别把正常回答截得像故障；
//   batch  —— 一次性跑几十上百个模型，只为分类（通/不通/没额度），
//             每个都收长篇会既慢又贵，所以只收一小段。
const PROBE_LIMITS = {
  // 单次：要能看到正文，而推理型模型会把思考也计入上限（实测同一条问题思考量在
  // 50~1024+ token 之间波动，给 1024 时出现过「1024 全被思考吃光、正文为空」），
  // 所以给足预算。
  single: { maxTokens: 4096, maxChars: 4000 },
  // 批量：只为分类，给一点点就够（并刻意压低推理开销）
  batch: { maxTokens: 256, maxChars: 400 },
};

/** 归一化测试消息：空/非字符串 → 默认值；过长 → 报错（由调用方转成 400） */
function normalizeTestMessage(message) {
  if (message === undefined || message === null) return { ok: true, text: DEFAULT_TEST_MESSAGE };
  if (typeof message !== 'string') return { ok: false, error: '测试消息必须是字符串' };
  const text = message.trim();
  if (!text) return { ok: true, text: DEFAULT_TEST_MESSAGE };
  if (text.length > MAX_TEST_MESSAGE_LEN) {
    return { ok: false, error: `测试消息过长（上限 ${MAX_TEST_MESSAGE_LEN} 字符）` };
  }
  return { ok: true, text };
}

/**
 * 读探测响应流，取回模型回答。限时 + 限字节，避免探测把连接挂死。
 * 同时取出 finishReason 与用量 —— 回答被截断时，「为什么短」本身就是要看的信息
 * （finishReason=max_tokens 说明是 token 上限，不是模型不肯说话）。
 */
async function consumeProbeStream(response, { timeoutMs = 45000, maxChars = 3000 } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  let text = '';
  let reasoning = '';      // 思考内容单独收：正文为空时它就是唯一的诊断线索
  let streamError = null;
  let sawFinish = false;
  let finishReason = null;
  let usage = null;
  // 上游自报的「实际服务的模型与厂商」—— 这是核实路由有没有命中唯一可靠的依据。
  // （模型自述「我是什么模型」完全不可信：实测同一模型 5 次里有 3 次说 DeepSeek、
  //   2 次说 Claude，因为它没有对自身身份的内省能力。）
  let upstreamModel = null;
  let upstreamProvider = null;
  let bytes = 0;

  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.length || 0;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'text-delta' && typeof ev.text === 'string') text += ev.text;
        else if ((ev.type === 'reasoning-delta' || ev.type === 'reasoning') && typeof ev.text === 'string') reasoning += ev.text;
        else if (ev.type === 'error') {
          streamError = ev.error?.message || ev.error?.code || JSON.stringify(ev.error || ev);
        } else if (ev.type === 'finish') {
          sawFinish = true;
          if (ev.finishReason) finishReason = ev.finishReason;
          if (ev.totalUsage) usage = ev.totalUsage;
        } else if (ev.type === 'finish-step') {
          if (ev.response?.modelId) upstreamModel = ev.response.modelId;
          if (ev.providerMetadata) upstreamProvider = Object.keys(ev.providerMetadata).join(', ');
          if (ev.usage && !usage) usage = ev.usage;
          if (ev.finishReason && !finishReason) finishReason = ev.finishReason;
        } else if (ev.type === 'provider-metadata' && ev.providerMetadata) {
          upstreamProvider = Object.keys(ev.providerMetadata).join(', ');
        }
      }

      // 已经有结论就不必把整个流读完
      if (streamError || sawFinish || text.length > maxChars || bytes > 512 * 1024) break;
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }

  return { text, reasoning, streamError, sawFinish, finishReason, usage, upstreamModel, upstreamProvider, bytes };
}

/**
 * 对指定 Key + 模型做一次真实探测。
 * message 省略时用 DEFAULT_TEST_MESSAGE（与参考项目一致的「你是谁，出来干活了」）。
 * 返回 { model, ok, category, latencyMs, httpStatus, message, outputPreview, prompt }
 */
async function probeModel({ key, model, message, mode = 'single' }) {
  const result = await probeModelInner({ key, model, message, mode });
  // 探测的用量同样记账（含失败：失败也要算进请求数与失败数）
  try {
    keyPool.recordRequest(key, { ok: result.category === 'ok' });
    const u = result.usage;
    if (u) {
      const { cacheRead, cacheWrite } = splitInputTokens(u);
      keyPool.recordTokens(key, {
        tokensIn: Number(u.inputTokens) || 0,
        tokensOut: Number(u.outputTokens) || 0,
        cacheRead,
        cacheWrite,
      });
    }
  } catch { /* 记账失败不影响探测结果 */ }
  return result;
}

async function probeModelInner({ key, model, message, mode = 'single' }) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const limits = PROBE_LIMITS[mode] || PROBE_LIMITS.single;

  const norm = normalizeTestMessage(message);
  if (!norm.ok) {
    return { model, ok: false, category: 'error', latencyMs: 0, httpStatus: null, message: norm.error };
  }
  const prompt = norm.text;

  let ccBody;
  try {
    ccBody = buildCcRequest({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: limits.maxTokens,
      stream: true,
    });
  } catch (e) {
    return { model, ok: false, category: 'error', latencyMs: elapsed(), httpStatus: null, message: `构造请求失败: ${e.message}`, prompt };
  }

  try {
    await ensureInitialized(key);
    const response = await forwardToCC(ccBody, key, {}, null, null);
    // 探测也是一次真实的上游调用，同样要计入该 Key 的用量 ——
    // 否则「我只在后台点测试」的用量会全部显示为 0（用户正是这么反馈的）

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const category = classifyProbe({ ok: false, httpStatus: response.status, bodyText: body });
      return {
        model,
        ok: false,
        category,
        latencyMs: elapsed(),
        httpStatus: response.status,
        message: summarizeUpstreamError(body, 200) || `HTTP ${response.status}`,
        prompt,
      };
    }

    const { text, reasoning, streamError, sawFinish, finishReason, usage, upstreamModel, upstreamProvider } =
      await consumeProbeStream(response, { maxChars: limits.maxChars });

    if (streamError) {
      const category = classifyProbe({ ok: false, bodyText: String(streamError) });
      return {
        model, ok: false, category: category === 'error' ? 'error' : category,
        latencyMs: elapsed(), httpStatus: 200,
        message: summarizeUpstreamError(String(streamError), 200),
        upstreamModel: upstreamModel || null,
        upstreamProvider: upstreamProvider || null,
        prompt,
      };
    }

    // 有正文、有思考、或有 finish 事件，都说明链路是通的
    const hasText = text.length > 0;
    const hasReasoning = reasoning.length > 0;
    const ok = hasText || hasReasoning || sawFinish;
    const truncated = finishReason === 'max_tokens' || text.length > limits.maxChars;

    // 把「为什么没有正文」说清楚 —— 这三种情形的处理方式完全不同：
    //   只有思考没有正文 → token 上限被推理占满（不是故障，也不是额度问题）
    //   正文被截断        → 达到上限，调大上限或换更短的问题
    //   真·零输出         → 上游 200 却什么都没发，需要怀疑上游
    let note = ok ? '链路正常' : '上游返回 200 但没有任何输出';
    if (ok && !hasText && hasReasoning) {
      note = `链路正常，但模型把 ${limits.maxTokens} token 上限全用在思考上、没产出正文（可换个更短的问题，或调大测试上限）`;
    } else if (ok && !hasText && !hasReasoning) {
      note = '上游返回 200 但没有发送任何内容（既无正文也无思考）';
    } else if (ok && truncated) {
      note = finishReason === 'max_tokens'
        ? `链路正常（回答达到 token 上限被截断，上限 ${limits.maxTokens}）`
        : '链路正常（回答较长，仅显示前一段）';
    }
    // 上游自报的 modelId 与请求的模型不一致时要说出来 —— 这是唯一能发现
    // 「参数被中途改写/路由到别处」的信号（模型自述不算数）
    const modelMatched = !upstreamModel || upstreamModel === model;
    if (ok && !modelMatched) {
      note += `；⚠️ 上游实际服务的是 ${upstreamModel}（与请求的 ${model} 不一致）`;
    }
    return {
      model,
      upstreamModel: upstreamModel || null,
      upstreamProvider: upstreamProvider || null,
      modelMatched,
      ok,
      category: ok ? 'ok' : 'error',
      latencyMs: elapsed(),
      httpStatus: 200,
      message: note,
      reasoning: mode === 'batch' ? '' : reasoning,
      reasoningChars: reasoning.length,
      textChars: text.length,
      // output 只在单次测试时返回：模型页/批量测试看的是分类，不需要回答正文，
      // 带上它只会把结果列表和 model-tests.json 撑大。
      output: mode === 'batch' ? '' : text,
      outputPreview: summarizeUpstreamError(text, 200),
      finishReason: finishReason || null,
      usage: usage || null,
      truncated,
      prompt,
    };
  } catch (e) {
    const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      model,
      ok: false,
      category: classifyProbe({ networkError: e }),
      latencyMs: elapsed(),
      httpStatus: null,
      message: `${isTimeout ? '超时' : '连接失败'}: ${e.message}`,
      prompt,
    };
  }
}

// 批量模型测试任务（受限并发 + 可取消），进度由后台轮询
const modelTestRunner = createModelTestRunner({
  log: (...args) => log(...args),
  probe: async ({ model, keyId, message }) => {
    let key = null;
    if (keyId) {
      const entry = keyPool.findById(keyId);
      if (!entry) {
        return { model, ok: false, category: 'error', latencyMs: null, httpStatus: null, message: '指定的 Key 不存在', keyId, checkedAt: new Date().toISOString() };
      }
      key = entry.key;
    } else {
      key = keyPool.pick()?.key || null;
    }
    if (!key) {
      return { model, ok: false, category: 'error', latencyMs: null, httpStatus: null, message: '没有可用的 Key', keyId, checkedAt: new Date().toISOString() };
    }
    // 批量用 batch 限额：只为分类，收长篇既慢又贵
    const r = await probeModel({ key, model, message, mode: 'batch' });
    return { ...r, keyId: keyId || keyPool.idForKey(key), checkedAt: new Date().toISOString() };
  },
});

// ── 工具函数 ───────────────────────────────────────

// CLI 的 slug 规则：对**完整工作目录**做 slugify（@sindresorhus/slugify），空则 "root"，无随机后缀；
// 同一个 slug 也是 CLI 本地会话目录名。所以 slug 与 config.workingDir 同源：slug = slugify(workingDir)。
function slugifyProjectPath(p) {
  const s = String(p || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'root';
}

function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function getDateStr() {
  return new Date().toISOString().slice(0, 10);
}


// ── CC 请求体构建 ─────────────────────────────────

/**
 * params.system 的块形态（toWireSystem），非末块补 \n，可带缓存断点。
 * @typedef {Object} CcSystemBlock
 * @property {'text'} type
 * @property {string} text
 * @property {{ type: 'ephemeral' }} [cache_control]
 */

/**
 * messages 里的内容块联合类型：text / image / reasoning / tool-call / tool-result。
 * @typedef {Object} CcTextPart
 * @property {'text'} type
 * @property {string} text
 * @property {{ type: 'ephemeral' }} [cache_control]
 * @typedef {Object} CcImagePart
 * @property {'image'} type
 * @property {string} image        // data:<mime>;base64,...
 * @property {string} [mimeType]
 * @typedef {Object} CcReasoningPart
 * @property {'reasoning'} type
 * @property {string} text
 * @typedef {Object} CcToolCallPart
 * @property {'tool-call'} type
 * @property {string} toolCallId
 * @property {string} toolName
 * @property {string|object} input
 * @typedef {Object} CcToolResultPart
 * @property {'tool-result'} type
 * @property {string} toolCallId
 * @property {string} toolName
 * @property {{ type: 'text', value: string }} output
 * @typedef {CcTextPart|CcImagePart|CcReasoningPart|CcToolCallPart|CcToolResultPart} CcContentPart
 */

/**
 * wire 格式的单条消息（buildCcRequest 的 ccMessages 元素）。
 * @typedef {Object} CcMessage
 * @property {'user'|'assistant'|'tool'} role
 * @property {CcContentPart[]} content
 */

/**
 * 信封 params 块。
 * @typedef {Object} CcRequestParams
 * @property {string} model
 * @property {CcMessage[]} messages
 * @property {CcSystemBlock[]} [system]
 * @property {number} max_tokens
 * @property {true} stream            // CC API 总是 stream
 * @property {number} [temperature]
 * @property {string} [reasoning_effort]
 * @property {{ name: string, description: string, input_schema: object }[]} tools
 * @property {{ type: 'auto'|'none'|'any'|'tool', name?: string }} [tool_choice]
 * @property {boolean} [parallel_tool_calls]
 */

/**
 * /alpha/generate 的 9 键信封（threadId 由 forwardToCC 重排时插入）。
 * @typedef {Object} CcRequestBody
 * @property {{ workingDir: string, date: string, environment: string, structure: string[],
 *   isGitRepo: boolean, currentBranch: string, mainBranch: string, gitStatus: string,
 *   recentCommits: string[] }} config
 * @property {null} memory
 * @property {null} taste
 * @property {null} skills
 * @property {'standard'} permissionMode
 * @property {string} mode
 * @property {CcRequestParams} params
 */

/** 历史 assistant 消息确实没有 reasoning 时的非空占位符（见 buildCcRequest 内注释）。 */
const MISSING_REASONING_PLACEHOLDER = '[reasoning unavailable: previous turn was interrupted]';

/**
 * @returns {CcRequestBody}
 */
function buildCcRequest(openaiReq) {
  const { model, messages, max_tokens, temperature, tools, stream, reasoning_effort, tool_choice, parallel_tool_calls, prompt_cache_key } = openaiReq;

  // 提取系统提示：OpenAI 的 system / developer 都映射为系统提示。
  // 形态对齐 CLI 的 toWireSystem —— **块数组**，非最后一块补 \n，cache_control 逐块保留。
  // （CLI 的 composeSystemPrompt：基础提示词是字符串时发字符串、是 sections 时发块数组；
  //   真机验证两种形态服务端都接受，见 PROTOCOL-FACTS-1.53.1.md。这里统一用块数组，
  //   才能把客户端标在 system 上的缓存断点原样送上去。）
  const systemMsgs = messages.filter(m => m.role === 'system' || m.role === 'developer');
  const systemBlocks = [];
  for (const m of systemMsgs) {
    if (typeof m.content === 'string') {
      if (m.content) systemBlocks.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        const text = c?.text ?? c?.content ?? '';
        if (text === '' && !c?.cache_control) continue;
        const block = { type: 'text', text: String(text) };
        if (c?.cache_control) block.cache_control = c.cache_control;
        systemBlocks.push(block);
      }
    } else if (m.content != null) {
      systemBlocks.push({ type: 'text', text: String(m.content) });
    }
  }
  for (let i = 0; i < systemBlocks.length - 1; i++) systemBlocks[i].text += '\n';
  const chatMessages = messages.filter(m => m.role !== 'system' && m.role !== 'developer');

  // 缺少 reasoning 的 assistant 历史消息计数：用非空占位符回填以满足上游
  // 「每条历史 assistant 消息都带 reasoning_content」的校验（严格上游会把空串
  // 也当成缺失，见 9router#4805 的 Zen 案例）。占位符是诚实的标记文本、
  // 绝不伪装成真实思考内容；仅在取消/部分响应等确实无 reasoning 的场景触发。
  let missingReasoningCount = 0;

  // Build tool_call_id → tool_name reverse lookup
  // 名字原样透传（理由见 toWireToolName 删除处的注释）。
  const toolNameMap = {};
  for (const msg of chatMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          toolNameMap[tc.id] = tc.function?.name || '';
        }
      }
    }
  }

  // 转换 messages 为 CC 格式
  const ccMessages = chatMessages.map(msg => {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        return { role: 'user', content: [{ type: 'text', text: msg.content }] };
      }
      // 多模态：数组 content 原样透传（text + image_url → CC image 格式）
      if (Array.isArray(msg.content)) {
        const parts = msg.content.map(part => {
          if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            // CC CLI 真实格式: { type: "image", image: "data:<mime>;base64,...", mimeType: "<mime>" }
            const mediaType = /^data:([^;,]+)/.exec(url)?.[1];
            const imagePart = { type: 'image', image: url };
            if (mediaType) imagePart.mimeType = mediaType;
            return imagePart;
          }
          return part;
        }).filter(Boolean);
        return { role: 'user', content: parts };
      }
      return { role: 'user', content: [{ type: 'text', text: String(msg.content) }] };
    }
    if (msg.role === 'assistant') {
      const parts = [];
      // 思考内容必须回传：CC 在 thinking 模式下校验 reasoning 是否随历史带回，
      // 丢弃会让上游直接拒绝。次序也必须与 CC CLI 的抓包格式一致 ——
      // [reasoning, text, tool-call]，reasoning 在最前。
      // reasoning 的真实来源依次是：顶层 reasoning_content 字段、content 数组
      // 里的 reasoning 块（text 或 reasoning 字段）。两者都缺失或为空白时
      // （典型场景：客户端把该轮取消在 reasoning 产出之前——AI SDK 的
      // openai-compatible 仅在 reasoning 非空时才下发 reasoning_content——
      // 以及非 thinking 模型的历史消息、压缩摘要），用非空占位符回填：
      // 空串会被严格上游当作缺失拒绝（Missing required parameter:
      // 'messages[N].reasoning_content'），占位符保证字段「在场且非空」，
      // 而真实值一律原样保留、不改写。
      let reasoningText = null;
      if (typeof msg.reasoning_content === 'string') {
        if (msg.reasoning_content.trim() !== '') reasoningText = msg.reasoning_content;
      } else if (msg.reasoning_content != null) {
        reasoningText = String(msg.reasoning_content);
      }
      if (reasoningText === null && Array.isArray(msg.content)) {
        const rpart = msg.content.find(p => p && p.type === 'reasoning');
        const t = rpart && (typeof rpart.text === 'string' ? rpart.text
          : (typeof rpart.reasoning === 'string' ? rpart.reasoning : ''));
        if (t && t.trim() !== '') reasoningText = t;
      }
      if (reasoningText === null) {
        reasoningText = MISSING_REASONING_PLACEHOLDER;
        missingReasoningCount++;
      }
      parts.push({ type: 'reasoning', text: reasoningText });
      if (msg.content && typeof msg.content === 'string') {
        if (msg.content) parts.push({ type: 'text', text: msg.content });
      } else if (msg.content && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (part.type === 'text') parts.push(part);
          // reasoning 块已统一在上方处理（真实文本已并入 reasoningText，
          // 此处不再重复下发 content 数组里的 reasoning 块）
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function?.name || '',
            input: (typeof tc.function?.arguments === 'string' ? tryParseJSON(tc.function.arguments) : (tc.function?.arguments || {})),
          });
        }
      }
      return { role: 'assistant', content: parts };
    }
    if (msg.role === 'tool') {
      // toolName 与上面 tool-call 里的一致（同一张 map），不重命名
      return {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: msg.tool_call_id,
          toolName: toolNameMap[msg.tool_call_id] || msg.name || '',
          output: { type: 'text', value: toWireToolOutputValue(msg.content) },
        }],
      };
    }
    // 未知 role 兜底：归一化为 user 并保证 content 为数组，避免 CC 校验拒绝
    return { role: 'user', content: [{ type: 'text', text: String(msg.content ?? '') }] };
  });

  // 缓存断点标记的是「缓存前缀的末端」，因此打在「最后一条 user 消息的最后一个 text
  // part」上，取的是当前对话前缀的末端 —— 整段对话落入缓存前缀，历史轮次自然被覆盖。
  // 打在更早的位置（如 system 末块）会把消息历史留在前缀之外，长会话每轮全量重复计费；
  // 只打第一条 user 消息同样会让后续轮次的增量始终处于断点之外。
  // 客户端自己带了 cache_control（system 块数组或任意消息块）就完全尊重客户端，不重复打点。
  //
  // 为什么不额外给 params.system 打一个断点（参考实现在 /provider/v1/messages 上会打三个）：
  // 那是**另一个传输**。1.87.1 的 CLI 确实在 toWireSystem 里给带 cache 的 section 发
  // cache_control，但 /alpha/generate 的缓存是**隐式前缀**机制 —— 实测同一前缀重发时
  // cacheReadTokens 会自然命中（约 54k），不依赖任何显式断点；而显式断点在 Anthropic
  // 系列模型上是**按写缓存计费**的（cacheWriteCost 高于 inputCost），在我们无法实测
  // 收益的这条路由上主动加，是在给自己增加成本。因此这里只补「前缀末端」这一个点，
  // 且仅在客户端表达了缓存意图（prompt_cache_key）而自己没打点时补。
  const hasCacheMarker = systemBlocks.some(b => b.cache_control) || ccMessages.some(msg =>
    Array.isArray(msg.content) && msg.content.some(part => part?.cache_control));
  if (prompt_cache_key && !hasCacheMarker) {
    const lastUserMessage = ccMessages.findLast(msg => msg.role === 'user' && Array.isArray(msg.content));
    const cacheBoundary = lastUserMessage?.content.findLast(part => part?.type === 'text');
    if (cacheBoundary) cacheBoundary.cache_control = { type: 'ephemeral' };
  }

  const body = {
    config: {
      // 伪造的项目目录（不再发宿主真实 cwd）；environment 用伪装的平台词，与指纹保持自洽
      workingDir: DEVICE_PROFILE.projectDir,
      date: getDateStr(),
      environment: DEVICE_PROFILE.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,          // CLI 发 null，不是空串
    permissionMode: 'standard',
    mode: CFG.cliMode || 'agent',
    // threadId 需为合法 UUID，否则整键省略（CLI 的 toWireThreadId）—— 在 forwardToCC 拿到 sessionId 后补
    params: {
      model: model || 'deepseek/deepseek-v4-flash',
      messages: ccMessages,
      // 三段夹逼，取小：
      //   1) 客户端要的（缺省 64000，对齐 CLI 的 VT = 64e3）；
      //   2) 网关硬上限 200000 —— 实测 200000 被接受、200704 被拒，是网关级的，
      //      与模型窗口无关（1M 窗口的模型也一样）；
      //   3) 该模型已知的输出上限（目录公布的 max_output_tokens，或上游在某次
      //      400 里亲口报出、被 outputCeilingFor 学到的值）。未知时是 Infinity，
      //      等于只受前两段约束 —— 不猜、不放宽。
      max_tokens: Math.min(max_tokens || 64000, 200000, outputCeilingFor(model)),
      stream: true,  // CC API 总是 stream
    },
  };

  // 条件字段
  if (systemBlocks.length) {
    body.params.system = systemBlocks;
  } else if (CFG.emptySystemPlaceholder) {
    // CC 上游在 params.system 缺省时会注入自身约 7.5K token 的默认提示词（进入
    // 默认上下文/前缀路径），既产生大量 cached tokens 又污染对话（模型会以为
    // 自己在 CC 的可执行目录里，见 issue #17）。发一个空格占位即可绕过，
    // 真机验证 prompt_tokens 从 7653 降到 85。
    // 默认开启；config.json 设 "emptySystemPlaceholder": false 或环境变量
    // CC_EMPTY_SYSTEM_PLACEHOLDER=false 可关闭（回到原生的缺省行为）。
    body.params.system = [{ type: 'text', text: ' ' }];
  }
  if (temperature !== undefined) {
    body.params.temperature = temperature;
  }
  // reasoning_effort 照常下发：缺失的 reasoning 已被非空占位符回填、历史
  // 重新合法，没有理由为此牺牲当前轮的 thinking。（早先版本曾在缺失时整段
  // 不下发 reasoning_effort —— 对「按模型决定 thinking」的上游无效，且白白
  // 关掉当前轮推理。）
  if (missingReasoningCount > 0) {
    log('info', 'Backfilled missing reasoning_content with placeholder', { count: missingReasoningCount, model: body.params.model });
  }
  if (reasoning_effort !== undefined) {
    body.params.reasoning_effort = reasoning_effort;
  }
  // CLI 总是下发 tools（没有工具时是空数组）—— 空数组与缺键在 wire 上可观测，这里对齐
  // CLI 的 toWireTools：只有 name / description / input_schema，没有 type 字段；
  // 且**不做**任何名字重写（理由见下面「工具名重写整段删除」的注释）
  body.params.tools = (tools || []).map(t => ({
      name: t.function?.name || t.name || '',
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
    }));
  if (tool_choice !== undefined) {
    if (tool_choice === 'none' || (typeof tool_choice === 'object' && tool_choice?.type === 'none')) {
      // none 表示本轮禁用工具：CC 上游 tool_choice 枚举只有 auto / any / tool，
      // 传 none 会被 CC 以 400 拒绝。语义上清空 tools 且不下发 tool_choice。
      body.params.tools = [];
    } else if (typeof tool_choice === 'string') {
      const map = { 'auto': 'auto', 'required': 'any' };
      body.params.tool_choice = { type: map[tool_choice] || 'auto' };
    } else if (tool_choice.type === 'function') {
      // OpenAI object → Anthropic object
      body.params.tool_choice = { type: 'tool', name: tool_choice.function?.name };
    } else {
      body.params.tool_choice = tool_choice;
    }
  }
  if (parallel_tool_calls !== undefined) {
    body.params.parallel_tool_calls = parallel_tool_calls;
  }

  return body;
}

// ── 工具名为什么一个都不重命名（已删掉的别名表的墓志铭） ──────────────
// 上游 d063b47 曾引入一张 4 项别名表并作用于 params.tools[].name。查 CLI 源码后
// （command-code@1.54.0，1.87.1 复核仍成立）确认：**wire 协议里没有工具重命名这回事**。
//
// CLI 里确实存在两个改名的函数，但都不适用于反代：
//
//   toWireToolName(e){return e===rw?nw:e}      // rw="tool_search" → nw="search_tools"
//     —— 只作用在 toWireMessages（tool-call 与 tool-result，两边同名），
//        不作用在 toWireTools（声明原样下发）。它的存在前提是 CLI 自己退役过
//        tool_search 这个名字：createRetiredToolSearchTool 给的 visible:()=>false，
//        该工具从不进 params.tools，只有重放旧会话时历史里才会残留这个旧名。
//
//   resolveToolNameAlias(ow 表)                 // bash_output/task_output/read_multiple_files
//     —— 被工具执行器调用：模型喊了退役名时本地按新名跑，回一句给模型看的
//        "Repair note"，并按 defaults 补参（task_output 会补 wait:"exit"）。
//        这是执行语义、不是 wire 变换。
//
// 反代没有这个前提：params.tools 由下游客户端给出，proxy 没有 catalog、没有退役名，
// 请求里出现的每个名字对 proxy 来说都是当前名。若强行重命名，一旦客户端恰好声明了
// 一个叫 tool_search 的工具，就会变成「声明 tool_search、消息 search_tools」——
// 下游按自己声明的名字派发不到工具（issue #36 / #37 的根因）。
//
// 因此这里全程原样透传。若将来真要支持「重放真实 CLI 旧会话」，正确做法是**入站**
// 归一化 + 显式开关，并连 defaults 一起补，与 resolveToolNameAlias 同语义；
// 绝不要做成「上行改、下行不改」。

// CLI 的 toWireToolOutput：只取文本块，用 '\n' 拼接
function toWireToolOutputValue(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c && c.type === 'text').map(c => c.text ?? '').join('\n');
  }
  return content == null ? '' : String(content);
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// ── 孤立代理项（lone surrogate）清洗 ──────────────────────────────
// JSON.stringify 不会拒绝孤立的 UTF-16 半代理项，而是把它写成 `"\ud83d"` 转义。
// 客户端截断字符串（把 emoji 劈成两半）时就会产生这种值，严格的解码端会直接 400。
// 官方 provider（pi 的 commandcode 传输）对这条端点上的每个字符串都做同样的清洗。
//
// 实现要点（来自 dsh-commandcode-provider 的实测结论）：
//   · 用 JSON.stringify 的 replacer 挂在**唯一**的序列化点上，三种协议、所有字段一次覆盖；
//   · 没有任何代理项的字符串原样返回（零拷贝）；
//   · 前置判断必须是**非全局**正则 —— 全局正则有 lastIndex 状态，反复 test() 会在
//     true/false 之间抖动；
//   · 成对代理项（合法的 astral 字符，即 emoji）必须原样保留：朴素的范围过滤会删掉所有 emoji。
const ANY_SURROGATE_PATTERN = /[\uD800-\uDFFF]/;
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function sanitizeSurrogates(value) {
  if (typeof value !== 'string') return value;
  if (!ANY_SURROGATE_PATTERN.test(value)) return value;
  return value.replace(LONE_SURROGATE_PATTERN, '');
}

/** 供 JSON.stringify 使用的 replacer：只处理字符串，其余原样。 */
function sanitizeReplacer(_key, value) {
  return typeof value === 'string' ? sanitizeSurrogates(value) : value;
}

// ── 序列化结果按 params 身份复用 ─────────────────────────────
// 一次请求会多次走到序列化点：多 Key 轮换、传输层闪断重试、输出上限降档重发。
// 这些尝试之间正文**逐字节相同**（换的只是 Authorization / traceparent / x-session-id，
// 它们都在 header 里，不在 body 里），而带图长会话的 body 可达几十 MB ——
// 实测 28.4MB 的正文重新 stringify 一次要 ~150ms 的**同步**事件循环时间，
// 期间进程里所有在途请求都被卡住。同一份正文序列化 5、6 次纯属浪费。
//
// 缓存键是 `ccBody.params` 对象本身（WeakMap，随 body 一起被 GC，不需要清理）。
// 有效性判据是 `max_tokens`：降档重发会改这个值，改了就必须重新序列化 ——
// 这是两条尝试之间**唯一**会变的 body 字段（其余字段在同一次请求内都不动）。
// 若将来有别的字段在重试之间被改写，必须一并纳入这个判据，否则缓存会给出旧正文。
const serializedBodyCache = new WeakMap();   // params → { maxTokens, text }

function serializeCcBody(body) {
  const params = body && body.params;
  if (!params || typeof params !== 'object') {
    return JSON.stringify(body, sanitizeReplacer);
  }
  const maxTokens = params.max_tokens;
  const hit = serializedBodyCache.get(params);
  if (hit && hit.maxTokens === maxTokens) return hit.text;
  const text = JSON.stringify(body, sanitizeReplacer);
  serializedBodyCache.set(params, { maxTokens, text });
  return text;
}

// ── CC NDJSON → OpenAI SSE 转换 ────────────────────

function createSseTranslator(model, completionId, created) {
  // 是否见过终态 finish 事件。CLI 用同一个标志判定「流是不是被截断了」。
  let sawFinish = false;
  let chunkIndex = 0;
  let sentRole = false;
  let finishReason = null;
  let unsupportedFinishReason = null;
  // 只承载「上游连接失败族」的 finishReason（见 toOpenAIFinishReason 的说明）：
  // 不认识的结束原因折成 stop 正常收尾，不再进这里。
  let usage = null;
  let toolCallIndex = 0;
  // cache_write_tokens 事件单独回传的「写缓存」用量（1.87.1 新增的事件）。
  // 主路径仍是 totalUsage.inputTokenDetails.cacheWriteTokens；这个值只在
  // 上游单发事件、而 usage 明细缺失时用来补齐（CLI 的
  // readCapturedCacheWriteTokens 做的就是这件事）。
  let capturedCacheWriteTokens = 0;

  return {
    lastCcEvent: '',
    upstreamError: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    get cacheWriteTokens() { return capturedCacheWriteTokens; },
    /** 解析一行 NDJSON，返回 OpenAI chunk 数组 */
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;

      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;

      const out = [];

      switch (event.type) {
        case 'text-start':
        case 'reasoning-start':
        case 'start':
        case 'start-step':
          // 忽略，无用户可见内容
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          const delta = chunkIndex === 0 ? { role: 'assistant', content: text } : { content: text };
          chunkIndex++;
          sentRole = true;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          const delta = chunkIndex === 0
            ? { role: 'assistant', reasoning_content: text }
            : { reasoning_content: text };
          chunkIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'tool-call': {
          const id = event.toolCallId || `call_${Date.now()}_${toolCallIndex}`;
          const name = event.toolName || '';
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          const tcEntry = { index: toolCallIndex, id, type: 'function', function: { name, arguments: args } };
          const delta = chunkIndex === 0
            ? { role: 'assistant', content: null, tool_calls: [tcEntry] }
            : { tool_calls: [tcEntry] };
          chunkIndex++;
          toolCallIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'finish-step': {
          sawFinish = true;
          if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
          if (event.usage) {
            usage = event.usage;
            this.inputTokens = event.usage.inputTokens ?? 0;
            this.outputTokens = event.usage.outputTokens ?? 0;
            this.cachedInputTokens = event.usage.cachedInputTokens ?? 0;
          }
          break;
        }

        case 'finish': {
          sawFinish = true;
          const fr = toOpenAIFinishReason(finishReason || mapFinishReason(event.finishReason || 'stop'));
          const u = event.totalUsage || usage || {};
          normalizeUsage(u);
          this.inputTokens = u.inputTokens ?? 0;
          this.outputTokens = u.outputTokens ?? 0;
          this.cachedInputTokens = u.cachedInputTokens ?? 0;
          const openaiUsage = u ? {
            prompt_tokens: u.inputTokens ?? 0,
            completion_tokens: u.outputTokens ?? 0,
            total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            prompt_tokens_details: { cached_tokens: u.cachedInputTokens ?? 0 },
          } : undefined;
          // 单独发来的 cache-write-tokens 只在 usage 明细缺失时补齐 —— 有明细就以明细为准，
          // 两者相加会重复计账（CLI 的 readCapturedCacheWriteTokens 同样只在
          // cacheWriteTokens === 0 时兜底）。
          if (capturedCacheWriteTokens > 0) {
            const details = (u.inputTokenDetails ||= {});
            if (!details.cacheWriteTokens) details.cacheWriteTokens = capturedCacheWriteTokens;
          }
          if (OPENAI_FINISH_REASONS.has(fr)) {
            out.push(makeChunk(completionId, created, model, {}, fr, openaiUsage));
          } else {
            // 走到这里只剩「上游连接失败族」（upstream_error；CC 在 provider 返回空
            // 响应时发的裸 'error' 已在 mapFinishReason 里并入它）。原样写进 SSE 会让
            // 严格客户端把整条流判成反序列化失败（GrokZen：unknown variant `error`），
            // 且丢失「可重试」信号。交回流尾 incompleteDetail()，按可重试错误上报。
            // 不认识的结束原因（实测 'other'）不在这里 —— toOpenAIFinishReason 已把它
            // 折成 stop，因为它表示「这一轮结束了」，不是「没完成」。
            unsupportedFinishReason = fr;
          }
          break;
        }

        case 'error': {
          const msg = event.error?.message || event.message || 'Unknown error';
          this.upstreamError = mapCcEventError(event);
          // 先映射再记日志，并把上游自带的状态/可重试性一并打出 ——
          // 排查容量/限流类问题时，真正需要的就是这两个字段
          log('warn', 'CC stream error', {
            message: msg,
            upstreamStatus: this.upstreamError.reportedStatus,
            upstreamRetryable: event.error?.isRetryable,
            code: this.upstreamError.code,
            mappedTo: this.upstreamError.status,
          });
          // Don't emit a finish_reason chunk — let the natural stream termination
          // handle it. Otherwise a subsequent finish(tool_calls) would be ignored
          // by downstream agent loops that stop at the first finish_reason.
          break;
        }

        // 1.87.1 新增：把写缓存 token 单独作为一条事件回传。只记下来，
        // 等 finish 时若 usage 明细里没有 cacheWriteTokens 再补上（见 capturedCacheWriteTokens）。
        case 'cache-write-tokens': {
          const n = Number(event.cacheWriteTokens);
          if (Number.isFinite(n) && n >= 0) capturedCacheWriteTokens = n;
          break;
        }

        // 上游服务端工具的执行结果（providerExecuted）。代理不执行工具，
        // 也拿不到对应的客户端 tool_call_id 语义 —— 静默忽略，绝不能当成
        // Unknown 事件刷屏（1.87.1 起才出现在事件集里）。
        case 'server_tool_result': case 'tool-result':
        case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
          // Silent - no user-visible content
          break;
        default:
          log('warn', 'Unknown CC event type', { type: event.type });
          break;
      }

      return out.length > 0 ? out : null;
    },

    /** 这次上游流若没有正常走完 finish，返回可读原因；正常则为 null。 */
    incompleteDetail() {
      const standard = incompleteUpstreamDetail(sawFinish, finishReason);
      if (standard) return standard;
      if (!unsupportedFinishReason) return null;
      // 到这里只剩上游连接失败族（'upstream_error'），措辞与 network/connection-error
      // 一致。末句保留作防御：不认识的结束原因已由 toOpenAIFinishReason 折成 stop，
      // 不再走这条路径。
      return unsupportedFinishReason === 'upstream_error'
        ? 'provider reported an upstream connection failure'
        : `provider reported an unsupported finish reason (${unsupportedFinishReason})`;
    },

    /** 获取 SSE 结束标记 */
    getDoneEvent() {
      return 'data: [DONE]\n\n';
    },
  };
}

function makeChunk(id, created, model, delta, finishReason, usage) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// normalize CC usage stats:
// - outputTokens=0 → zero everything (anti false billing)
function normalizeUsage(u) {
  if (!u) return;
  const ot = Number(u.outputTokens);
  if (!ot) {  // 0, null, undefined, NaN → zero input + cached (anti false billing)
    u.inputTokens = 0;
    u.cachedInputTokens = 0;
  }
}

// CC 的 inputTokens 是「总数」（含缓存命中部分），而 Anthropic 的 input_tokens 只计
// 非缓存部分 —— 官方 SDK 注释：Total input tokens in a request is the summation of
// `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`。
// 直接把 CC 的 inputTokens 当 input_tokens 转发，会让下游把两者当成互不重叠的两部分，
// 相加后约为真实输入的两倍（issue #25）。
//
// CC 实际已经算好：inputTokenDetails.noCacheTokens（实测 noCacheTokens + cacheReadTokens
// === inputTokens）。优先采用该字段；缺失时回退到减法，保证老版本上游也能得到正确值。
function anthropicInputTokens(usage, noCacheOverride) {
  const u = usage || {};
  if (typeof noCacheOverride === 'number' && noCacheOverride >= 0) return noCacheOverride;
  const noCache = u.inputTokenDetails && u.inputTokenDetails.noCacheTokens;
  if (typeof noCache === 'number' && noCache >= 0) return noCache;
  const cacheRead = u.cachedInputTokens || (u.inputTokenDetails && u.inputTokenDetails.cacheReadTokens) || 0;
  const cacheWrite = (u.inputTokenDetails && u.inputTokenDetails.cacheWriteTokens) || 0;
  return Math.max(0, (u.inputTokens || 0) - cacheRead - cacheWrite);
}

// 上游 finishReason → 本代理内部规范化取值。
// 对齐 CLI 的 normalizeStopReason2 / consumedStopReason / isNetworkFailureFinish
// （command-code@1.87.1 dist/cli.mjs；1.53.1 → 1.87.1 这一段只多了 refusal 一族）：
//   refusal | content_filter | content-filter            → refusal
//   tool_use | tool-calls | tool_calls                    → tool_calls
//   length | max_tokens | max_output_tokens
//          | model_context_window_exceeded                → length
//   error | /^(network|connection|upstream)[-_\s]?error$/i → upstream_error
//   pause_turn                                            → pause_turn（原样保留）
// 关键点：'length' 家族**不止 'length' 一个值**。max_output_tokens 与
// model_context_window_exceeded 都是「输出被截断」，折成 stop/end_turn 等于
// 把半截回答谎报成完整回答。未知值一律原样返回，宁可让它露出来也不要静默折成 stop。
// 这里只是**内部**词汇表：露出来的值到出口会由 toOpenAIFinishReason 处理（连接失败族
// 保原值走可重试 502，其余折成 stop），不会以非法 finish_reason 透给客户端。
//
// 例外：裸 'error' 必须并进 upstream_error。Command Code 在 provider 返回空响应时
// 发 `finish` + `finishReason:"error"`；它不是可透出的业务值，原样返回会变成非法的
// OpenAI finish_reason（严格客户端整条流反序列化失败），也会丢掉可重试语义。
const REFUSAL_FINISH_REASONS = new Set(['refusal', 'content_filter', 'content-filter']);
function mapFinishReason(reason) {
  const r = String(reason ?? '').trim().toLowerCase();
  if (!r) return 'stop';
  if (REFUSAL_FINISH_REASONS.has(r)) return 'refusal';
  if (r === 'tool-calls' || r === 'tool_calls' || r === 'tool_use') return 'tool_calls';
  if (r === 'length' || r === 'max_tokens'
      || r === 'max_output_tokens' || r === 'model_context_window_exceeded') return 'length';
  if (r === 'error' || /^(?:network|connection|upstream)[-_\s]?error$/.test(r)) return 'upstream_error';
  return r;
}

// 上游「没有正常走完」的两种情形，CLI 都当成可重试的 502：
//   · 流里根本没有 finish 事件 —— "Stream ended unexpectedly before completion
//     (no finish event) — response was truncated"
//   · provider 报 network/connection/upstream-error —— isNetworkFailureFinish
// 返回 null 表示这次流是正常结束的。
//
// sawFinish 的口径是「上游给过任何完成信号」：终态 finish，以及本代理一直在处理的
// finish-step。（'finish-step' 在 CLI 的事件集里不存在 —— 见 proxy.mjs 各处注释 ——
// 但既然代理认它，就不能让它变成「没完成」，否则会把原本正常的响应误判成 502。
// 真正要拦的是「一个完成信号都没有就断了」。）
function incompleteUpstreamDetail(sawFinish, finishReason) {
  if (!sawFinish) return 'no finish event';
  if (finishReason === 'upstream_error') return 'provider reported an upstream connection failure';
  return null;
}

function incompleteUpstreamError(detail) {
  return {
    status: 502,
    // retry_after 同时放在 body 里与顶层：sendJSON 只发 body，
    // 而 sendAnthropicError / sendResponsesError 需要单独的形参。
    body: {
      error: {
        message: `Upstream stream ended without a completion finish (${detail}) — response was truncated`,
        type: 'upstream_error',
      },
      retry_after: 10,
    },
    retry_after: 10,
  };
}

// ── 错误映射 ───────────────────────────────────────

// 网关的 JSON 节点数上限：`400 JSON node count cannot exceed 32768`。
// 这是**结构**限制，不是 token 限制 —— 实测在 1M 窗口模型的 22.6% 处就会撞上
// （1436 条消息 + 61 个图片块）。把它当上下文溢出报，客户端会去压缩上下文：
// 压缩确实能减少消息与图片块数，但通常不足以降到上限以内，于是压缩完再撞一次，
// 在长上下文上按全价白烧一轮。参考实现对这一类单列诊断，本项目同样单列。
//
// 只引用网关自己写明的数字：上限归网关所有，可能变化，猜一个值比不猜更糟。
const JSON_NODE_LIMIT_REJECTION = /JSON node count cannot exceed\s+(\d+)/i;

const CC_STATUS_MAP = {
  400: { status: 400, type: 'invalid_request_error' },
  401: { status: 401, type: 'authentication_error' },
  402: { status: 429, type: 'rate_limit_error' },       // payment required → rate limit
  403: { status: 401, type: 'authentication_error' },
  404: { status: 404, type: 'not_found' },
  422: { status: 400, type: 'invalid_request_error' },
  429: { status: 429, type: 'rate_limit_error' },
  500: { status: 502, type: 'upstream_error' },
  502: { status: 502, type: 'upstream_error' },
  503: { status: 503, type: 'temporarily_unavailable' },
};

function mapCcError(ccStatus, ccBody) {
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };
  let message = `CC API error (${ccStatus})`;
  let code = null;

  if (ccBody) {
    try {
      const parsed = JSON.parse(ccBody);
      message = parsed.error?.message || parsed.message || message;
      // 上游错误体：{"success":false,"error":{"code":"BAD_REQUEST"|"USAGE_EXCEEDED",...}}
      // code 是上游的机器可读错误分类（BAD_REQUEST / USAGE_EXCEEDED 等），透出来便于下游 SDK 与运维判定
      code = parsed.error?.code || parsed.code || null;
    } catch {
      message = ccBody.slice(0, 200) || message;
    }
  }

  // CC 429 响应可能带 retry-after
  if (ccStatus === 429) {
    return {
      status: 429,
      code,
      body: {
        error: { message, type: 'rate_limit_error', ...(code ? { code } : {}) },
        retry_after: 30,
      },
    };
  }

  // JSON 节点数上限：必须在通用错误之前识别，否则客户端只能看到一句无法行动的 400。
  // 措辞要同时说清三件事：限制的是结构、给了数字、压缩通常不够。
  const nodeLimit = JSON_NODE_LIMIT_REJECTION.exec(message)?.[1];
  if (nodeLimit !== undefined) {
    return {
      status: mapped.status,
      code,
      body: {
        error: {
          message: `Request exceeds the gateway's JSON node limit (node count cannot exceed ${nodeLimit}) — `
            + 'the cap is on the request\'s structure, not its token length, so compacting the context usually '
            + 'will not be enough; start a new session, or reduce the number of messages and images in this one. '
            + `Upstream said: ${message}`,
          type: mapped.type,
          ...(code ? { code } : {}),
          node_limit: Number(nodeLimit),
        },
      },
    };
  }

  return { status: mapped.status, code, body: { error: { message, type: mapped.type, ...(code ? { code } : {}) } } };
}

function mapCcEventError(event) {
  const message = event.error?.message || event.message || 'Unknown CC error';
  const code = event.error?.code || event.code || null;
  // 上游 error 事件除了 message 还可能自带 statusCode / isRetryable ——
  // CLI 的 readStreamErrorEvent 读的正是这两个字段，取值链是
  //   parseEmbeddedErrorJSON(message)?.status ?? error.statusCode ?? null
  // 原实现只看 message 里的 "<NNN>" 前缀，statusCode 一律被丢掉，
  // 于是 429 / 503 这类「该退避重试」的信号在代理这一层被抹平成 502「服务端错误」：
  // 客户端不再按限流退避，监控也会把它错误归类成后端故障。
  const statusMatch = message.match(/^<(\d{3})>/);
  const reportedStatus = statusMatch
    ? Number(statusMatch[1])
    : (Number.isInteger(event.error?.statusCode) ? event.error.statusCode : null);
  const ccStatus = reportedStatus ?? 502;
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };

  // 与 mapCcError 保持一致：终态为 429 时带上 retry_after，
  // 否则客户端 SDK 拿不到退避提示（402 也映射成 429，一视同仁）
  if (mapped.status === 429) {
    return {
      status: 429,
      code,
      reportedStatus,
      body: { error: { message, type: 'rate_limit_error', ...(code ? { code } : {}) }, retry_after: 30 },
    };
  }

  return { status: mapped.status, code, reportedStatus,
    body: { error: { message, type: mapped.type, ...(code ? { code } : {}) } } };
}

// ── HTTP 请求处理 ──────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    let settled = false;
    let drained = 0;
    // 413 拒绝后转入排空模式：继续读取并丢弃剩余请求体，保持 keep-alive 连接可复用，
    // 让客户端明确收到 413 而不是 Connection reset（issue #7）。
    // 但若客户端无视 413 持续上传超过 DRAIN_LIMIT，则强制掐断，不无限吞带宽。
    const DRAIN_LIMIT = 32 * 1024 * 1024;
    req.on('data', c => {
      if (settled) {
        drained += c.length;
        if (drained > DRAIN_LIMIT) { try { req.destroy(); } catch {} }
        return;
      }
      totalSize += c.length;
      if (totalSize > MAX_BODY_SIZE) {
        settled = true;
        chunks.length = 0;
        const mb = Math.round(MAX_BODY_SIZE / 1024 / 1024);
        // 只报上限等于让人去猜自己超了多少 —— 客户端要据此决定"拆请求"还是"去申请提额"。
        // nginx 开了 proxy_request_buffering 时会带 Content-Length，据此给出真实体积；
        // 没有该头（chunked）时退回"已收到多少"，并标注它是下界。
        const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
        const known = Number.isFinite(declared) && declared > 0;
        const bytes = known ? declared : totalSize;
        const sizeNote = ` (body is ${(bytes / 1048576).toFixed(1)}MB${known ? '' : '+'})`;
        log('warn', 'Request body rejected (too large)', {
          path: req.url,
          limitMB: mb,
          bodyMB: +(bytes / 1048576).toFixed(1),
          exact: known,
        });
        const err = new Error(`Request body exceeds ${mb}MB limit${sizeNote}`);
        err.statusCode = 413;
        err.bodyBytes = bytes;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', e => { if (!settled) { settled = true; reject(e); } });
  });
}

// 下游背压：res.write() 返回 false 表示 socket 写缓冲已超 highWaterMark（消费者跟不上）。
// 忽略它会让整个上游流在内存中无界堆积 —— 客户端不读时 RSS 随上游流一起增长（issue #20）。
// 必须同时监听 close/error，否则客户端断连会让请求协程永久挂起。
// CLIENT_DRAIN_TIMEOUT_MS > 0 时额外加一道空闲看门狗：超时则 destroy 该响应，
// 由此触发既有的 res 'close' 处理器 → aborted=true → 中止 CC 上游，无需改动各调用点。
function waitDrain(res) {
  if (!res.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      res.off('drain', done); res.off('close', done); res.off('error', done);
      if (timer) { clearTimeout(timer); timer = null; }
      resolve();
    };
    res.once('drain', done); res.once('close', done); res.once('error', done);
    if (CLIENT_DRAIN_TIMEOUT_MS > 0) {
      timer = setTimeout(() => {
        log('warn', 'Client stalled on backpressure, dropping connection', {
          path: res.req?.url || '(unknown)',
          timeoutMs: CLIENT_DRAIN_TIMEOUT_MS,
          bufferedBytes: res.writableLength,
        });
        try { res.destroy(); } catch {}
        done();
      }, CLIENT_DRAIN_TIMEOUT_MS);
    }
  });
}

// 上游读空闲看门狗：复用单个定时器，避免「每个 chunk 新建一个 setTimeout 且从不清理」。
// 实测每个待触发定时器滞留约 225B；稳态滞留 = 吞吐 × 超时窗口 × 每响应 chunk 数 × 225B
// （50 rps × 2000 chunk × 30s ≈ 644MB，非流式 90s 窗口约为其三倍）。
// arm() 用 refresh() 把窗口重置为「本轮 read 开始」，与原实现语义一致：超时只计 reader.read() 的等待。
function createIdleWatchdog(timeoutMs) {
  let rejectFn = null;
  const expired = new Promise((_, reject) => { rejectFn = reject; });
  expired.catch(() => {}); // 读循环退出后定时器才触发时，避免 unhandledRejection
  const timer = setTimeout(() => rejectFn(new Error('STREAM_IDLE_TIMEOUT')), timeoutMs);
  return {
    arm() { timer.refresh(); return expired; },
    dispose() { clearTimeout(timer); },
  };
}

function sendJSON(res, status, data) {
  const headers = { 'Content-Type': 'application/json' };
  if (data && data.retry_after !== undefined) {
    headers['Retry-After'] = String(data.retry_after);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function getApiKey(headers) {
  // Try Authorization: Bearer header (OpenAI SDK style)
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const match = auth.slice(7).match(/user_[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  // Fall back to x-api-key header (Anthropic SDK style)
  const xKey = headers['x-api-key'] || headers['X-Api-Key'] || '';
  if (xKey) {
    const match = xKey.match(/user_[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  return null;
}

// ── 客户端鉴权 ──────────────────────────────────────
// 提取客户端提交的凭证（OpenAI SDK: Authorization: Bearer；Anthropic SDK: x-api-key）
function extractCredential(headers) {
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const v = auth.slice(7).trim();
    if (v) return v;
  }
  const xKey = headers['x-api-key'] || headers['X-Api-Key'] || '';
  return xKey.trim() || null;
}

// 定长比较：避免逐字节比对泄露时序信息
function safeEqual(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const AUTH_ERR_MSG = {
  missing: 'Missing API key. Send in Authorization: Bearer <key> or x-api-key header',
  invalid: 'Invalid API key',
  upstream_unconfigured: 'Server upstream API key not configured',
  // 这条是特意加的：把上游 Key 当成本代理的 Key 用是最常见的误用，
  // 直接说清楚「该用哪个」，比笼统回一句 Invalid API key 有用得多
  client_key_expected:
    'This proxy requires a 2API key issued in the admin panel (/admin/ → 2API Key). '
    + 'Upstream user_ keys are server-side credentials and must not be used by clients.',
};

// ── 上游 Key 选择（多 Key 轮询）──────────────────────
// 真正的选择逻辑在 lib/keys.mjs：策略（round_robin / random / fill）、冷却避让、
// 本轮已失败 Key 的排除、以及「全部冷却中」时的退化策略都在那里。
// 这里只留一层薄封装，让数据面的调用点保持不变。
const MAX_KEY_ATTEMPTS = 3;   // 单请求最多尝试的 Key 个数

// exclude：本轮已失败的 Key（字符串集合），优先避开
function pickUpstreamKey(exclude) {
  const picked = keyPool.pick(exclude);
  return picked ? picked.key : null;
}

// 鉴权入口：成功返回 { upstreamKey }，失败返回 { error }
// - proxyKey 非空 → 严格模式：客户端只认 proxyKey，上游凭证从 Key 池按策略选取（不再透传）
// - proxyKey 为空 → 保护未启用，沿用旧的透传行为
// 鉴权入口：成功返回 { upstreamKey, clientKeyId? }，失败返回 { error }
//
// 这里把两套 Key 的职责分清楚：
//   进来的凭证 → 本代理签发的 2API Key（或兼容旧的单口令 proxyKey）
//   出去的凭证 → 上游 Key 池里按策略挑一个（客户端永远拿不到它）
//
// 严格模式在「签发了任何 2API Key」或「设置了 proxyKey」时启用。
// 注意用 size 而不是「启用数量」：若按启用数量判断，把最后一个 Key 禁用就会
// 静默退回透传模式 —— 等于关掉访问控制，这个方向错得太危险（宁可失败也不放行）。
function authenticate(headers) {
  const strictMode = apiKeyPool.size > 0 || !!CFG.proxyKey;

  if (!strictMode) {
    // 保护未启用：沿用旧的透传行为，客户端带自己的上游 Key
    const key = getApiKey(headers);
    return key ? { upstreamKey: key } : { error: 'missing' };
  }

  const cred = extractCredential(headers);
  if (!cred) return { error: 'missing' };

  // ① 本代理签发的 2API Key
  const entry = apiKeyPool.verify(cred);
  if (entry) {
    const picked = keyPool.pick();
    if (!picked) return { error: 'upstream_unconfigured' };
    apiKeyPool.recordUse(entry);
    return { upstreamKey: picked.key, clientKeyId: entry.id, clientKeyLabel: entry.label || '' };
  }

  // ② 兼容旧的单口令 proxyKey（没有按客户端区分/吊销的能力，但已部署的配置不该失效）
  if (CFG.proxyKey && safeEqual(cred, CFG.proxyKey)) {
    const picked = keyPool.pick();
    if (!picked) return { error: 'upstream_unconfigured' };
    return { upstreamKey: picked.key, clientKeyId: null };
  }

  // ③ 拿了上游 Key 来当客户端凭证：明确告诉他该用哪个
  if (looksLikeUpstreamKey(cred)) return { error: 'client_key_expected' };

  return { error: 'invalid' };
}

// 统一的鉴权失败响应；Anthropic 端点的错误结构不同
function sendAuthError(res, code, anthropicStyle = false) {
  const status = code === 'upstream_unconfigured' ? 500 : 401;
  const message = AUTH_ERR_MSG[code];
  if (anthropicStyle) {
    sendJSON(res, status, { type: 'error', error: { type: 'authentication_error', message } });
  } else {
    sendJSON(res, status, { error: { message, type: 'authentication_error' } });
  }
}

// ── 上游 HTTP(S) 代理（issue #18）────────────────────
// 仅作用于发往 CC 上游的请求（/alpha/generate、/provider/v1/models）。
// 本地监听、/health 与 npm registry 版本检查都不经过代理。
//
// 零依赖实现：自己建立 CONNECT 隧道，再用 node:https 复用同一个 socket，
// 因此不需要 undici / https-proxy-agent，engines >=18 也能用。
// 注意 Node 原生 fetch 不读 HTTPS_PROXY/HTTP_PROXY；官方的环境变量方案需要
// Node >= 22.21 / 24.5 并设 NODE_USE_ENV_PROXY=1（README 有说明）。
// 上游代理地址支持后台热改，所以是 let + 显式刷新，而不是模块级 const 快照。
// 改地址不需要重启：后续请求各自新建隧道，旧 socket 自然回收。
let UPSTREAM_PROXY = CFG.upstreamProxy || '';
const PROXY_CONNECT_TIMEOUT_MS = 15000;

// 代理 URL 可能带 user:pass —— 任何日志/错误消息都只允许出现 host:port。
// （README 承诺「隐私保护日志」，把口令打进启动横幅是直接违反。）
function redactProxyUrl(raw) {
  if (!raw) return '(direct)';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
  } catch {
    return '(invalid upstreamProxy)';
  }
}

function parseProxyUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    // 不回显原串：里面可能就是口令
    throw new Error('upstreamProxy is not a valid URL (expected http://host:port)');
  }
  if (u.protocol !== 'http:') {
    throw new Error(`upstreamProxy only supports http:// (CONNECT) proxies, got ${u.protocol}//`);
  }
  const auth = u.username
    ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
    : null;
  return { host: u.hostname, port: Number.parseInt(u.port || '80', 10), auth };
}

// 启动即校验：写错的代理地址应当立刻拒绝启动，而不是每个请求各 502 一次。
if (UPSTREAM_PROXY) {
  try {
    parseProxyUrl(UPSTREAM_PROXY);
  } catch (e) {
    log('error', 'Invalid upstreamProxy, refusing to start', {
      error: e.message, value: redactProxyUrl(UPSTREAM_PROXY),
    });
    process.exit(1);
  }
  log('info', 'Upstream requests will go through the configured proxy', {
    proxy: redactProxyUrl(UPSTREAM_PROXY),
  });
}

/** Response 的 headers 需要字符串值；node 的 set-cookie 是数组，展开为多行。 */
function headersToInit(raw) {
  const out = [];
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) { for (const item of v) out.push([k, String(item)]); }
    else if (v !== undefined) out.push([k, String(v)]);
  }
  return out;
}

/** 经 HTTP 代理发上游请求，返回与 fetch 兼容的 Response（.ok/.status/.text()/.body）。 */
async function proxyFetch(urlStr, options = {}) {
  const proxy = parseProxyUrl(UPSTREAM_PROXY);
  const u = new URL(urlStr);
  const isTls = u.protocol === 'https:';
  const port = Number.parseInt(u.port || (isTls ? '443' : '80'), 10);
  const target = `${u.hostname}:${port}`;
  const { signal, body } = options;
  const onAbort = (fn) => { if (signal) signal.addEventListener('abort', fn, { once: true }); };

  // 1. CONNECT 隧道 —— 代理只做裸字节转发，TLS 由本端端到端完成
  const rawSocket = await new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: target,
      headers: { Host: target, ...(proxy.auth ? { 'Proxy-Authorization': proxy.auth } : {}) },
      timeout: PROXY_CONNECT_TIMEOUT_MS,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`upstream proxy CONNECT ${target} failed: HTTP ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    connectReq.on('timeout', () => connectReq.destroy(new Error('upstream proxy CONNECT timeout')));
    connectReq.on('error', reject);
    onAbort(() => { try { connectReq.destroy(); } catch {} });
    connectReq.end();
  });

  // 2. 隧道上做 TLS（证书按目标主机名校验，不做任何降级）
  let socket = rawSocket;
  if (isTls) {
    socket = tls.connect({ socket: rawSocket, servername: u.hostname });
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
      onAbort(() => { try { socket.destroy(); } catch {} });
    });
  }

  // 3. 复用隧道 socket 发请求
  return await new Promise((resolve, reject) => {
    const mod = isTls ? https : http;
    const req = mod.request({
      host: u.hostname,
      port,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      createConnection: () => socket,
    }, (res) => {
      // 204/205/304 按规范不允许带 body，Response 构造器会直接抛 —— 这两个状态必须传 null，
      // 同时把连接排空，避免隧道 socket 悬着。
      const nullBodyStatus = res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304;
      if (nullBodyStatus) { try { res.resume(); } catch {} }
      resolve(new Response(nullBodyStatus ? null : Readable.toWeb(res), {
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: headersToInit(res.headers),
      }));
    });
    req.on('error', reject);
    onAbort(() => { try { req.destroy(); } catch {} });
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

// Bun 的 node:http 基于 fetch 实现：CONNECT 方法直接报 "fetch() URL is invalid"，
// 且 createConnection 被忽略，上面的手搓隧道在 Bun 下无法工作。
// Bun 原生 fetch 支持 { proxy }（https 目标走 CONNECT，http 目标走 absolute-form 转发，
// URL 中的 user:pass 会转成 Proxy-Authorization），直接用它。
const IS_BUN = !!process.versions.bun;

/** 上游请求入口：配了代理走隧道，否则用原生 fetch（默认路径行为完全不变）。 */
function upstreamFetch(urlStr, options) {
  if (!UPSTREAM_PROXY) return fetch(urlStr, options);
  return IS_BUN ? fetch(urlStr, { ...options, proxy: UPSTREAM_PROXY }) : proxyFetch(urlStr, options);
}

/**
 * 后台改了 upstreamProxy 之后重建派生状态。
 * 启动时写入的是 const 快照，这里换成显式刷新 —— 地址要么走到新隧道、
 * 要么走直连，不会出现「一半请求还在用旧代理」的中间态。
 */
function refreshUpstreamProxy() {
  const next = CFG.upstreamProxy || '';
  if (next === UPSTREAM_PROXY) return false;
  const prev = UPSTREAM_PROXY;
  UPSTREAM_PROXY = next;
  log('info', '上游代理配置已更新', { from: redactProxyUrl(prev), to: redactProxyUrl(next) });
  return true;
}

// ── 流式转发 ────────────────────────────────────────

async function forwardToCC(body, apiKey, incomingHeaders = {}, signal, promptCacheKey) {
  const url = `${CFG.apiBase}/alpha/generate`;
  const traceparent = generateTraceparent();
  const { id: sessionId, source: sessionSource } = getSessionId(incomingHeaders, apiKey, promptCacheKey, body);
  // CLI 的 toWireThreadId：只有合法 UUID 才放进信封，否则整个键省略。
  // 同时按 CLI 的键顺序重排：config, memory, taste, skills, permissionMode, threadId, mode, params
  if (isWireUuid(sessionId)) {
    const ordered = {};
    for (const k of ['config', 'memory', 'taste', 'skills', 'permissionMode']) ordered[k] = body[k];
    ordered.threadId = sessionId;
    for (const k of ['mode', 'promptCache', 'params']) if (k in body) ordered[k] = body[k];
    body = ordered;
  }

  // 与 CLI 的 buildCommandAuthHeaders 对齐：没有 x-co-flag；User-Agent 固定 "cli"
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'cli',
    'x-command-code-version': CC_VERSION,
    'x-cli-environment': 'production',
    'x-project-slug': slugifyProjectPath(DEVICE_PROFILE.projectDir),
    'x-taste-learning': 'false',
    'x-session-id': sessionId,
    'Authorization': `Bearer ${apiKey}`,
    'traceparent': traceparent,
  };

  if (CFG.zdr || incomingHeaders['x-cmd-zdr'] === '1') {
    headers['x-cmd-zdr'] = '1';
  }

  // 会话 ID 决定上游的缓存命名空间，此处记录一次以便确认「客户端传的有没有透传出去」
  log('info', 'Forwarding to CC', {
    model: body?.params?.model,
    sessionId,
    sessionSource,
  });

  const response = await upstreamFetch(url, {
    method: 'POST',
    headers,
    // 唯一的序列化点：孤立代理项在这里统一清掉，三种协议与所有字段一次覆盖
    //（见 sanitizeSurrogates 的注释；官方 CLI 依赖的 provider 也做同样的事）。
    // 同一请求的多次尝试（换 Key / 闪断重试 / 上限降档）共用这份序列化结果，
    // 见 serializeCcBody —— 带图长会话重新 stringify 一次要上百毫秒同步时间。
    body: serializeCcBody(body),
    signal,
  });

  return response;
}

// 上游错误是否值得换个 Key 重试（Key 失效 / 余额不足 / 限流 / 上游 5xx）
const RETRYABLE_KEY_STATUS = new Set([401, 402, 403, 429, 500, 502, 503, 504]);

// 状态码之外还要看错误体：上游把「模型不在套餐内」这类与 Key 无关的业务限制
// 也用 401/403 表达，若一律当作 Key 失效，多 Key 下会把每个 Key 都试一遍才放弃。
//
// 只保留**模型维度**的标记。额度类（INSUFFICIENT_CREDITS / USAGE_EXCEEDED /
// PREMIUM_CREDITS_EXHAUSTED / insufficient credits）是**账号维度**的，换 Key 正是
// 正确处置 —— 若也归到这里，多 Key 部署会对着同一个余额不足的账号反复失败，
// 而池里其它 Key 明明还能用。这与参考实现（dsh-commandcode-provider）把额度类
// 当作「该换账号」的信号是同一个判断，只是本项目的处置动作叫「换 Key」。
// 匹配要容忍大小写与下划线/空格两种写法（上游 JSON 是 MODEL_NOT_IN_PLAN，
// 错误正文里是 "model not in plan"），这也是参考实现 hasTerminalStreamMarker 的口径。
const NON_KEY_ERROR_MARKERS = ['model not in plan'];

function isKeyIndependentError(bodyText) {
  const normalized = String(bodyText || '').toLowerCase().replaceAll('_', ' ');
  return NON_KEY_ERROR_MARKERS.some(marker => normalized.includes(marker));
}

// 输出上限拒绝：上游会用 `max_tokens: 200000 > 128000, which is the maximum
// allowed number of output tokens for <model>` 这种句式把**真实上限**写在错误里。
// 只解析带比较式的形态 —— 只报「invalid max_tokens」而不给数字时猜一个值，
// 比直接失败更糟：猜出来的数字和真实上限在后续请求里无从区分。
const OUTPUT_CEILING_REJECTION = /max_tokens:\s*\d+\s*>\s*(\d+)/i;

// 进程级学习结果：模型 → 上游亲口报出的输出上限。只收紧、不放大。
// 命中一次之后，同一模型的后续请求在 buildCcRequest 里就被预先夹到这个值，
// 不必每个请求都白吃一次 400（参考实现 learnedOutputLimits 的同一思路）。
const learnedOutputCeilings = new Map();

function parseOutputCeiling(text) {
  const stated = OUTPUT_CEILING_REJECTION.exec(String(text || ''))?.[1];
  if (stated === undefined) return null;
  const n = Number(stated);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 该模型已知的输出上限（目录公布的与运行时学到的取小）；未知返回 Infinity。 */
function outputCeilingFor(model) {
  if (!model) return Infinity;
  // catalog 在模块初始化之后才被赋值，但本函数只在处理请求时调用，不存在 TDZ 问题
  const published = catalog.get(model)?.maxOutputTokens;
  const learned = learnedOutputCeilings.get(model);
  const values = [published, learned].filter(v => Number.isFinite(v) && v > 0);
  return values.length ? Math.min(...values) : Infinity;
}

// 读取错误响应体并还原为等价的新 Response。body 只能消费一次，
// 因此判定「不值得换 Key」后必须把响应还原回去交给调用方；
// 且 undici 已自动解压，只保留 content-type，避免残留的 content-encoding 触发二次解压
async function drainErrorResponse(response) {
  const text = await response.text().catch(() => '');
  const headers = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  return {
    text,
    response: new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  };
}

// 带换 Key 重试的上游调用：始终返回最后一次的响应，错误映射仍由调用方按原逻辑处理
// 单 Key（或透传模式）下 maxAttempts ≤ 1，等价于不重试，行为与改动前一致
async function forwardWithKeyRetry(ccBody, firstKey, incomingHeaders, signal, promptCacheKey) {
  const maxAttempts = Math.min(Math.max(keyPool.size, 1), MAX_KEY_ATTEMPTS);
  const tried = new Set();
  let key = firstKey;
  // 输出上限降档只允许一次：上游亲口报出的上限收下之后重发同一请求，
  // 再被拒就是别的原因了，继续重试只会白烧额度。
  let ceilingDownshifted = false;

  for (let attempt = 1; ; attempt++) {
    tried.add(key);
    await ensureInitialized(key, signal);
    // let：输出上限降档分支会把消费过的响应换成还原出来的等价响应
    let response = await forwardToCC(ccBody, key, incomingHeaders, signal, promptCacheKey);

    if (response.ok) {
      keyPool.recordRequest(key, { ok: true });
      return { response };
    }

    // 输出上限拒绝与 Key 无关，换 Key 也没用 —— 但降档后重发**同一次**是有效的：
    // 把上游写明的上限记下来（进程级，只收紧不放大），夹住 max_tokens 再发一次。
    if (!ceilingDownshifted && (response.status === 400 || response.status === 422)) {
      const { text, response: restored } = await drainErrorResponse(response);
      const ceiling = parseOutputCeiling(text);
      const sent = ccBody?.params?.max_tokens;
      const model = ccBody?.params?.model;
      if (ceiling && Number.isFinite(sent) && ceiling < sent) {
        ceilingDownshifted = true;
        const prev = learnedOutputCeilings.get(model);
        if (prev === undefined || ceiling < prev) learnedOutputCeilings.set(model, ceiling);
        ccBody.params.max_tokens = ceiling;
        log('warn', 'Upstream output ceiling is lower than requested, retrying once at the stated ceiling', {
          model, requestedMaxTokens: sent, ceiling, status: response.status,
        });
        // 不记这个 Key 的失败：这是请求侧的预算问题，与该 Key 的健康/额度无关
        attempt--;   // 降档重发不计入 Key 轮换次数：这不是「换一个 Key」，是重发同一请求
        continue;
      }
      // 不是输出上限拒绝 → 把响应还原回去，继续走原来的分类逻辑
      response = restored;
    }

    // 状态码本身不值得换 Key，或已达尝试上限 → 记一次失败后交调用方处理
    if (attempt >= maxAttempts || !RETRYABLE_KEY_STATUS.has(response.status)) {
      keyPool.recordRequest(key, { ok: false });
      keyPool.recordFailure(key, {
        category: classifyProbe({ ok: false, httpStatus: response.status }),
        message: `HTTP ${response.status}`,
      });
      return { response };
    }

    // 状态码看似可重试，还要排除「换 Key 也无济于事」的业务错误
    const { text, response: restored } = await drainErrorResponse(response);
    const category = classifyProbe({ ok: false, httpStatus: response.status, bodyText: text });

    keyPool.recordRequest(key, { ok: false });

    if (isKeyIndependentError(text)) {
      // 模型不在套餐内：这是模型维度的结论，换 Key 没用，也不能把 Key 罚下场
      log('warn', 'Upstream error is key-independent, not switching key', {
        status: response.status, attempt, triedCount: tried.size, category,
      });
      return { response: restored };
    }

    // 真正与 Key 相关（额度/鉴权/网络）才进冷却，供后续请求避开
    keyPool.recordFailure(key, { category, message: summarizeUpstreamError(text, 200) });

    const nextKey = pickUpstreamKey(tried);
    if (!nextKey || tried.has(nextKey)) return { response: restored };   // 已无其他可用 Key

    log('warn', 'Upstream key failed, switching key', {
      status: response.status, attempt, triedCount: tried.size, category,
    });
    key = nextKey;
  }
}

/**
 * 把一个请求的 token 用量记到对应 Key 上。
 *
 * 为什么不逐个终态分支手动记账：三条协议 × 流式/非流式共 6 条收尾路径
 * （正常完成 / 上游报错 / 零输出 / 客户端断连 …），逐个人工埋点必漏，
 * 而且很容易在同一条请求上重复累加。这里改成：
 *   调用方只把「当前已知的 usage」塞进来（赋值，不累加），
 *   真正的记账挂在 response 的 finish/close 钩子上，配合一次性守卫保证恰好记一次。
 * 上游没给 token 数（0/0）时不消耗守卫，等后续拿到真实值再记。
 */
/**
 * 从上游 usage 里拆出输入的三桶。
 * 字段来源（实测 CC）：inputTokenDetails.cacheReadTokens / cacheWriteTokens / noCacheTokens，
 * 顶层 cachedInputTokens 是 cacheReadTokens 的同义字段（老版本可能只给这个）。
 * 缺明细时返回 0，由 recordTokens 把差额归入"未命中"，保证三桶之和恒等于输入总数。
 */
function splitInputTokens(u) {
  const d = (u && u.inputTokenDetails) || {};
  const read = Number(d.cacheReadTokens ?? u?.cachedInputTokens) || 0;
  // 顶层 cacheWriteTokens 不是上游 usage 的字段，而是两处**代理内部**的载体：
  //   1) chat 翻译器（把 1.87.1 的 cache-write-tokens 事件单独收下的值暴露出来）；
  //   2) messages 非流式的 ctx.cacheWriteTokens。
  // 放在明细之后兜底：有 inputTokenDetails 就以它为准，避免两处相加重复计账。
  const write = Number(d.cacheWriteTokens) || Number(u?.cacheWriteTokens) || 0;
  return { cacheRead: read, cacheWrite: write };
}

function attachUsageRecording(res, key) {
  const box = { usage: null };
  let done = false;

  const flush = () => {
    if (done || !box.usage) return;
    const { inputTokens: tokensIn = 0, outputTokens: tokensOut = 0, cacheRead = 0, cacheWrite = 0 } = box.usage;
    if (tokensIn <= 0 && tokensOut <= 0) return;
    done = true;
    keyPool.recordTokens(key, { tokensIn, tokensOut, cacheRead, cacheWrite });
  };

  res.once('finish', flush);
  res.once('close', flush);

  return (u) => {
    if (!u) return;
    const tokensIn = u.inputTokens ?? u.input_tokens;
    const tokensOut = u.outputTokens ?? u.output_tokens;
    if (tokensIn === undefined && tokensOut === undefined) return;
    const { cacheRead, cacheWrite } = splitInputTokens(u);
    box.usage = { inputTokens: tokensIn, outputTokens: tokensOut, cacheRead, cacheWrite };
  };
}

// ── Web search（CC 自带的 /alpha/web-search）─────────────────────
// 官方 CLI 内置的 web_search 打的就是这个端点，同一把 key。
//   请求  { query: string, numResults: 1-10 }
//   响应  { query, results: [{ title, url, snippet }], formatted }
// 后端是 DuckDuckGo，且不过滤赞助结果（duckduckgo.com/y.js?...&ad_type=txad，单条 URL 2KB+），
// 这里剥掉广告后再喂模型 / 回给客户端，所以不直接用上游的 formatted。
const WEB_SEARCH_ROUTE = '/alpha/web-search';
const WEB_SEARCH_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_WEB_SEARCH_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 8000;
})();
const WEB_SEARCH_AD_RE = /duckduckgo\.com\/y\.js|[?&]ad_type=|[?&]ad_provider=/i;

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
function domainMatches(hostname, domain) {
  const d = String(domain || '').toLowerCase().replace(/^\*\./, '');
  return !!d && (hostname === d || hostname.endsWith('.' + d));
}

// 返回 { blocks, textForModel } 或 { errorCode }。errorCode 对齐 Anthropic 的
// web_search_tool_result_error：too_many_requests / invalid_input / max_uses_exceeded / unavailable。
async function executeWebSearch(query, apiKey, incomingHeaders = {}, signal, opts = {}) {
  if (typeof query !== 'string' || !query.trim()) return { errorCode: 'invalid_input' };
  const want = Math.max(1, Math.min(10, Number.isInteger(opts.numResults) ? opts.numResults : 5));

  // 头与 forwardToCC 完全一致（CLI 对 generate / web-search 用同一套 buildCommandAuthHeaders）
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'cli',
    'x-command-code-version': CC_VERSION,
    'x-cli-environment': 'production',
    'x-project-slug': slugifyProjectPath(DEVICE_PROFILE.projectDir),
    'x-taste-learning': 'false',
    'x-session-id': getSessionId(incomingHeaders, apiKey),
    'Authorization': `Bearer ${apiKey}`,
    'traceparent': generateTraceparent(),
  };
  if (CFG.zdr || incomingHeaders['x-cmd-zdr'] === '1') headers['x-cmd-zdr'] = '1';

  const timeout = AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let data;
  try {
    // 经 upstreamFetch：配置了 CC_UPSTREAM_PROXY 时与 generate 一样走代理（issue #18）
    const r = await upstreamFetch(`${CFG.apiBase}${WEB_SEARCH_ROUTE}`, {
      method: 'POST',
      headers,
      signal: combined,
      // 多要几条抵消被剥掉的广告
      body: JSON.stringify({ query: query.trim(), numResults: Math.min(10, want + 3) }),
    });
    if (!r.ok) {
      log('warn', 'Web search upstream error', { status: r.status });
      return { errorCode: r.status === 429 ? 'too_many_requests' : 'unavailable' };
    }
    data = await r.json();
  } catch (e) {
    if (signal?.aborted) throw e; // 客户端断连，交给上层收尾
    log('warn', 'Web search failed', { message: e.message, timedOut: timeout.aborted });
    return { errorCode: 'unavailable' };
  }
  if (!Array.isArray(data?.results)) return { errorCode: 'unavailable' };

  const results = data.results
    .filter(x => x && typeof x.url === 'string' && x.url && !WEB_SEARCH_AD_RE.test(x.url))
    .filter(x => {
      const h = hostnameOf(x.url);
      if (opts.allowedDomains?.length && !opts.allowedDomains.some(d => domainMatches(h, d))) return false;
      if (opts.blockedDomains?.length && opts.blockedDomains.some(d => domainMatches(h, d))) return false;
      return true;
    })
    .slice(0, want);

  // encrypted_content 是 Anthropic 加密的正文，客户端只透传；这里放自编码的摘要，
  // 只有本 proxy 回放历史时读（decodeWebSearchResultBlocks）。
  const blocks = results.map(x => ({
    type: 'web_search_result',
    url: x.url,
    title: x.title || '',
    encrypted_content: Buffer.from(JSON.stringify({ s: x.snippet || '' }), 'utf8').toString('base64'),
    page_age: null,
  }));
  const textForModel = `Search results for: ${query.trim()}\n\n` + (results.length
    ? results.map((x, i) => `${i + 1}. **${x.title || x.url}**\n   ${x.url}\n   ${x.snippet || ''}`).join('\n\n')
    : '(no results)');
  return { blocks, textForModel };
}

// 历史回放：把客户端原样带回的 web_search_tool_result.content 还原成模型可读文本
function decodeWebSearchResultBlocks(content) {
  if (!Array.isArray(content)) {
    return `Search failed: ${content?.error_code || 'unavailable'}`;
  }
  if (content.length === 0) return '(no results)';
  return content.map((x, i) => {
    let snippet = '';
    try { snippet = JSON.parse(Buffer.from(String(x.encrypted_content || ''), 'base64').toString('utf8')).s || ''; } catch {}
    return `${i + 1}. **${x.title || x.url || ''}**\n   ${x.url || ''}\n   ${snippet}`;
  }).join('\n\n');
}

// ── 路由 ────────────────────────────────────────────

async function handleChatCompletions(req, res) {
  let openaiReq;
  try {
    openaiReq = await readBody(req);
  } catch (e) {
    if (e.statusCode === 413) {
      sendJSON(res, 413, { error: { message: e.message, type: 'invalid_request_error' } });
      return;
    }
    sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
    return;
  }

  const auth = authenticate(req.headers);
  if (auth.error) {
    sendAuthError(res, auth.error);
    return;
  }
  const apiKey = auth.upstreamKey;

  const trackUsage = attachUsageRecording(res, apiKey);
  const stream = openaiReq.stream === true;
  const model = openaiReq.model || fallbackModel('deepseek/deepseek-v4-flash', '/chat/completions');
  // 明确被禁用的模型直接拒掉：只在 /v1/models 里隐藏它是不够的 ——
  // 客户端缓存了模型名照样能调，禁用就成了摆设
  const disabledErr = disabledModelError(openaiReq.model);
  if (disabledErr) {
    sendJSON(res, 400, { error: { message: disabledErr, type: 'invalid_request_error' } });
    return;
  }
  const completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = nowUnix();

  // 把「解析出来的 model」写回请求对象。
  // buildCcRequest 内部是从 openaiReq.model 取值的，不写回去的话，
  // 上面 fallbackModel() 算出的兜底模型只会进入日志，实际发出去的仍是写死的那个 id。
  openaiReq.model = model;

  // 构建 CC 请求体
  const ccBody = buildCcRequest(openaiReq);
  // issue #20：ccBody 建好后，openaiReq 这棵 20MB 级对象树只剩 prompt_cache_key 还被用到。
  // 先取出该值再断开引用，让这一份副本可以更早被 GC 回收（原来是整段请求期间一直活着）。
  const promptCacheKey = openaiReq.prompt_cache_key;
  openaiReq = null;

  // 连续超时的作用域：优先用客户端给的会话标识，没有就按内容派生。
  // forwardToCC 里会再算一次同样的值 —— 这里先取是为了让超时计数按会话隔离。
  const sessionKey = getSessionId(req.headers, apiKey, promptCacheKey, ccBody).id;

  // AbortController 用于客户端断连时真正打断 CC 上游（pi-commandcode-provider 模式）
  // 每次尝试都换一个新的（已 abort 的 signal 不可复用）
  let abortController = new AbortController();
  let aborted = false;
  // 提前初始化，断连回调/超时 catch 安全引用（避免块级作用域 ReferenceError）
  const startTime = Date.now();
  let bytesReceived = 0; let lastCcEvent = ''; let keepaliveCount = 0; let fullText = '';
  let reader = null;
  let translator = null;
  let attempt = 0;
  let upstreamError = null;   // 非流式路径解析出的上游语义错误（error 事件）
  let delivered = false;      // 本次尝试是否真的把正常响应交付给了下游（用于重试后的日志/计数）

  // 发起下一次尝试前，把本次尝试的上游连接收干净并记账。
  // 只在「下游尚未收到任何字节」时调用 —— 下游没有开始过，重试才是无损的。
  const rewindAttempt = async (message, fields) => {
    try { reader?.cancel().catch(() => {}); } catch {}
    try { abortController.abort(); } catch {}
    upstreamRetryStats.rewinds++;
    log('warn', message, {
      path: '/v1/chat/completions',
      model,
      attempt,
      maxAttempts: UPSTREAM_RETRY_MAX + 1,
      elapsedMs: Date.now() - startTime,
      ...fields,
    });
    await sleep(UPSTREAM_RETRY_BASE_MS * attempt);
  };

  // 下游断连检测：打断 CC 上游 + 记录日志 —— 必须挂在重试循环**之前**、无条件注册恰好一次。
  // #50 初版把它放在「attempt === 1 且已拿到上游响应头」的分支里：而第 1 次尝试恰恰可能在
  // 响应头之前就闪断（这正是重试特性要处理的场景），该分支永远走不到，之后所有尝试便
  // 再也没有断连监听 —— 客户端已断开仍会继续打上游（白烧额度 / 放大 QPS），还会把
  // 「对着空气交付」误记成 retry recovered（issue #55）。
  // 回调读的 abortController 是每次尝试重绑的 let，闭包取到的永远是当前尝试的控制器，
  // 所以注册一次即可，重试不需要重复挂载。
  res.on('close', () => {
    if (res.writableEnded) return; // Normal completion, not a disconnect
    aborted = true;
    const reason = lastCcEvent?.startsWith('tool-input') ? 'tool-input-silent-timeout'
      : lastCcEvent?.includes('delta') ? 'streaming-active-disconnect'
      : 'client-hangup';
    abortController.signal.aborted || log('warn', 'Client disconnected', {
      path: '/v1/chat/completions',
      model, completionId, reason,
      streaming: stream,
      elapsedMs: Date.now() - startTime,
      bytesSent: bytesReceived,
      lastCcEvent: lastCcEvent || '(none)',
      keepaliveCount,
      inputTokens: translator?.inputTokens ?? 0,
      outputTokens: translator?.outputTokens ?? 0,
      cachedInputTokens: translator?.cachedInputTokens ?? 0,
    });
    if (!abortController.signal.aborted) {
      // 断连前抢发 usage=0 终止 chunk，避免下游自行估算 token
      try {
        res.write(`data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
      } catch {}
      try { abortController.abort(); } catch {}
    }
  });

  // 上游闪断重试循环：只在「传输层闪断」且「尚未向下游写出任何字节」时
  // 才再来一遍；正常路径第一轮即 break。循环体沿用原有缩进、未做重排，只为把 diff 控到最小。
  attemptLoop: for (attempt = 1; attempt <= UPSTREAM_RETRY_MAX + 1; attempt++) {
  // 退避期间客户端断开了：下游已经走了，再打一次上游只是白烧额度
  if (attempt > 1 && aborted) {
    log('info', 'Upstream retry abandoned (client disconnected during backoff)', {
      path: '/v1/chat/completions', model, attempt, elapsedMs: Date.now() - startTime,
    });
    return;
  }
  // 每次尝试开始：重置本次请求的状态（上一次可能已被中断 / 半途失败）
  abortController = new AbortController();
  bytesReceived = 0; lastCcEvent = ''; keepaliveCount = 0; fullText = '';
  reader = null; translator = null; upstreamError = null; delivered = false;

  // 记录本次用量，缓存是否命中可直接由此判断。三条终态分支（上游报错、零输出、
  // 正常完成）都要记 —— 零输出时最需要看清的就是缓存到底有没有命中。
  const logUsage = () => {
    trackUsage(translator);
    log('info', 'Request completed', {
      path: '/v1/chat/completions',
      model,
      streaming: true,
      elapsedMs: Date.now() - startTime,
      id: completionId,
      inputTokens: translator?.inputTokens ?? 0,
      outputTokens: translator?.outputTokens ?? 0,
      cachedInputTokens: translator?.cachedInputTokens ?? 0,
    });
  };

  try {
    // 转发到 CC API（传入客户端 headers 用于提取 session ID；遇 Key 失效/限流自动换 Key 重试，
    // forwardWithKeyRetry 内部已含每 Key 的 ensureInitialized）
    const { response: ccResponse } = await forwardWithKeyRetry(
      ccBody, apiKey, req.headers, abortController.signal, promptCacheKey
    );

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      const mapped = mapCcError(ccResponse.status, errorText);
      log('error', 'CC API error', { status: ccResponse.status, code: mapped.code, body: summarizeUpstreamError(errorText) });
      sendJSON(res, mapped.status, mapped.body);
      return;
    }

    if (stream) {
      // ── 流式响应 ──
      translator = createSseTranslator(model, completionId, created);
      let buffer = '';
      let started = false; // 延迟写 200 header，超时/output=0 时返回 JSON 429/502 让 SDK 自动重试
      const decoder = new TextDecoder();
      reader = ccResponse.body.getReader();

      const idle = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS);
      try {
        while (true) {
          const result = await Promise.race([reader.read(), idle.arm()]);
          const { done, value } = result;
          if (done) break;
          if (aborted) break;
          bytesReceived += value.length;

          const chunkText = decoder.decode(value, { stream: true });
          buffer += chunkText;
          // 仅在新到数据含换行时才切分：buffer 中永不残留 '\n'，故无换行即无完整行。
          // 避免对增长中的超长单行（大 tool-call / tool_result）反复做全量 split —— O(n²) → O(n)。
          let lines = [];
          if (chunkText.indexOf('\n') !== -1) {
            lines = buffer.split('\n');
            buffer = lines.pop() || '';
          }

          let hadOutput = false;
          for (const line of lines) {
            const events = translator.parseLine(line);
            if (events) {
              if (!started) {
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                  'X-Accel-Buffering': 'no',
                });
                started = true;
              }
              for (const evt of events) res.write(evt);
              await waitDrain(res);
              hadOutput = true;
            }
            if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
          }
          // silent events 期间发 keepalive，防止客户端超时断开
          if (started && !hadOutput) {
            try { res.write(': keepalive\n\n'); keepaliveCount++; } catch {}
            await waitDrain(res);
          }
        }

        if (!aborted) {
          // 成功完成一次请求，重置本会话的连续超时计数
          clearTimeouts(sessionKey);
          if (buffer.trim()) {
            const events = translator.parseLine(buffer);
            if (events) {
              if (!started) started = true;
              for (const evt of events) res.write(evt);
              await waitDrain(res);
            }
          }
          if (translator.upstreamError) {
            logUsage();
            if (!started) {
              sendJSON(res, translator.upstreamError.status, translator.upstreamError.body);
              return;
            }
            try { res.write(`data: ${JSON.stringify(translator.upstreamError.body)}\n\n`); } catch {}
          // 上游没有正常走完 finish（无 finish 事件 / provider 报连接失败）：
          // 不能补一个 finish_reason 就 [DONE] —— 那等于把截断谎报成完整回答。
          // 对齐 CLI：这一族一律按可重试的 502 处理。
          // 必须排在零输出判定之前 —— 上游压根没发 finish 时，「no finish event」才是根因，
          // 零输出只是它的表象（此时按 429 报会掩盖真实原因）。
          } else if (translator.incompleteDetail()) {
            const detail = translator.incompleteDetail();
            // 对端 FIN（干净收尾、没有 finish 事件）与 RST 是同一类闪断：既然还没向下游吐过
            // 字节，就先内部重试，而不是直接把 502 交给下游去自行重发整个上下文。
            if (!started && !aborted && attempt <= UPSTREAM_RETRY_MAX) {
              await rewindAttempt('Upstream stream ended incomplete before first byte - retrying', { reason: detail });
              continue attemptLoop;
            }
            log('warn', 'Upstream stream incomplete', { path: '/v1/chat/completions', reason: detail });
            const err = incompleteUpstreamError(detail);
            try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
            if (!started) { sendJSON(res, err.status, err.body); return; }
            try { res.write(`data: ${JSON.stringify(err.body)}\n\n`); } catch {}
          // 输出 token 为 0 时记为错误，避免下游异常计费
          } else if (translator.outputTokens === 0) {
            logUsage();
            try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
            if (!started) {
              sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
              return;
            }
            try { res.write(`data: ${JSON.stringify({ error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 })}\n\n`); } catch {}
          } else {
            if (!started) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
              });
              started = true;
            }
            res.write(translator.getDoneEvent());
            logUsage();
            delivered = true;
          }
        }
      } catch (e) {
        if (aborted) {
          // 客户端已断连，只清理（close handler 已调用 abortController.abort()）
          // cancel() 返回 promise：不接住的话，连接已被对端掐断时会抛 UnhandledPromiseRejection
          try { reader.cancel().catch(() => {}); } catch {}
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/chat/completions',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: completionId,
            bytesReceived,
            lastCcEvent: lastCcEvent || '(none)',
            inputTokens: translator.inputTokens,
            outputTokens: translator.outputTokens,
            cachedInputTokens: translator.cachedInputTokens,
          });
          try { reader.cancel().catch(() => {}); } catch {}
          try { abortController.abort(); } catch {} // 打断 CC 上游，避免浪费 token
          const timeoutMsg = timeoutMessage(sessionKey);
          if (!started) {
            sendJSON(res, 429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
            return;
          }
          if (!res.writableEnded) {
            // 必须 end() 而不是 destroy()：res.write 是异步的，紧接着 destroy 会把尚未
            // 刷出的缓冲丢掉并发 RST。反向代理看到上游连接被重置，要么回 502，要么让
            // 客户端看到 connection error —— 这正是"吐字慢 + 间歇性 502"的成因之一。
            // end() 会把错误事件正常送进 SSE 流再发 FIN，客户端 SDK 能按可重试错误处理。
            // 下游若已僵死（不读也不断），由 CLIENT_DRAIN_TIMEOUT_MS 那条路径负责兜底。
            try { res.end(`data: ${JSON.stringify({ error: { message: timeoutMsg, type: 'rate_limit_error' }, retry_after: 5 })}\n\n`); } catch {}
          }
        // 已经解析出上游语义错误（429/503 等）时不重试：那是有意传下来的信号，重试会把它吞掉
        } else if (!started && !aborted && !translator?.upstreamError
                   && attempt <= UPSTREAM_RETRY_MAX && isRetryableUpstreamError(e)) {
          // 传输层闪断且尚未向下游写过任何字节 → 代理内部静默重试（下游全程无感）
          await rewindAttempt('Upstream stream terminated before first byte - retrying', {
            message: e.message,
            cause: e.cause?.code || e.cause?.message || '(none)',
          });
          continue attemptLoop;
        } else {
          // 传输层错误不要覆盖已经解析到的语义错误：把「上游容量不足」说成「代理挂了」是误导
          if (translator?.upstreamError && !started) {
            log('warn', 'Upstream terminated after a parsed semantic error', { message: e.message });
            try { abortController.abort(); } catch {}
            sendJSON(res, translator.upstreamError.status, translator.upstreamError.body);
            return;
          }
          log('error', 'Stream error', { message: e.message });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
            return;
          }
          if (!res.writableEnded) {
            try { res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'proxy_error' } })}\n\n`); } catch {}
          }
        }
      } finally {
        idle.dispose();
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式响应（缓冲完整 NDJSON）──
      let reasoningContent = '';
      let finishReason = 'stop';
      let sawFinish = false;
      let usage = null;
      let toolCalls = null;

      // 记录本次用量，缓存是否命中可直接由此判断。
      // 三条终态分支（上游报错、零输出、正常完成）都要记。
      const logNonStreamUsage = () => {
        trackUsage(usage);
        log('info', 'Request completed', {
          path: '/v1/chat/completions',
          model,
          streaming: false,
          elapsedMs: Date.now() - startTime,
          id: completionId,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cachedInputTokens: usage?.cachedInputTokens ?? 0,
        });
      };

      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
          try {
            const event = JSON.parse(trimmed);
            switch (event.type) {
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'reasoning-delta': lastCcEvent = event.type; reasoningContent += event.text || ''; break;
              case 'tool-call':
                lastCcEvent = event.type;
                toolCalls = toolCalls || [];
                toolCalls.push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  function: {
                    name: event.toolName || '',
                    arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                  },
                });
                break;
              case 'finish-step':
              case 'finish':
                lastCcEvent = event.type;
                sawFinish = true;
                finishReason = mapFinishReason(event.finishReason || 'stop');
                if (event.totalUsage) usage = event.totalUsage;
                break;
              case 'error':
                lastCcEvent = event.type;
                upstreamError = mapCcEventError(event);
                log('warn', 'CC stream error (non-stream)', {
                  message: event.error?.message || event.message,
                  upstreamStatus: upstreamError.reportedStatus,
                  upstreamRetryable: event.error?.isRetryable,
                  code: upstreamError.code,
                  mappedTo: upstreamError.status,
                });
                break;
              // 无内容的事件：与流式翻译器的静默列表保持一致。
              // text-start / start / start-step / reasoning-start 原先只在流式路径被识别，
              // 非流式路径会掉进 default 打成 'Unknown CC event type' —— 上游每个响应都会发，
              // 于是线上刷屏。它们本身不携带内容（内容在 text-delta），纯粹是噪音。
              case 'text-start': case 'text-end': case 'start': case 'start-step':
              case 'reasoning-start': case 'reasoning-end':
              case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end':
              // 1.87.1 起上游还会发 cache-write-tokens（写缓存用量单发一条）与
              // server_tool_result / tool-result（providerExecuted 的服务端工具结果）。
              // 非流式路径不区分这些细粒度事件，只要不刷 Unknown 警告即可。
              case 'cache-write-tokens': case 'server_tool_result': case 'tool-result':
              case 'tool-error':
                // Silent - no user-visible content
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type });
                break;
            }
          } catch {}
        }
      };

      const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);
      // 读循环抛错（闪断）时也必须释放看门狗：否则每次失败尝试都会留下一个 armed 的定时器，
      // 重试期间累积（流式路径的 finally 已覆盖同一件事）
      try {
        while (true) {
          const result = await Promise.race([reader.read(), idle.arm()]);
          const { done, value } = result;
          if (done) break;
          bytesReceived += value.length;
          const chunkText = decoder.decode(value, { stream: true });
          buf += chunkText;
          // 无换行则不可能产生完整行，跳过全量 split（见 handleChatCompletions 流式段同处说明）
          if (chunkText.indexOf('\n') !== -1) processLines();
        }
      } finally {
        idle.dispose();
      }
      processLines();

      if (upstreamError) {
        logNonStreamUsage();
        sendJSON(res, upstreamError.status, upstreamError.body);
        return;
      }

      // 上游没有正常走完 finish —— 对齐 CLI 按可重试 502 处理，不谎报成功
      const incomplete = incompleteUpstreamDetail(sawFinish, finishReason);
      if (incomplete) {
        // 尚未向下游写过任何字节（非流式此时 headers 还没发）→ 与传输层闪断同等对待，先重试
        if (!aborted && !upstreamError && attempt <= UPSTREAM_RETRY_MAX) {
          await rewindAttempt('Upstream stream ended incomplete before first byte - retrying', { reason: incomplete });
          continue attemptLoop;
        }
        log('warn', 'Upstream stream incomplete', { path: '/v1/chat/completions', reason: incomplete });
        const err = incompleteUpstreamError(incomplete);
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendJSON(res, err.status, err.body);
        return;
      }

      // 输出 token 为 0 时记为错误，避免下游异常计费
      if ((usage?.outputTokens ?? 0) === 0) {
        logNonStreamUsage();
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
        return;
      }

      clearTimeouts(sessionKey);
      sendJSON(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: Object.assign(
            { role: 'assistant', content: fullText || null },
            toolCalls ? { tool_calls: toolCalls } : {},
            reasoningContent ? { reasoning_content: reasoningContent } : {},
          ),
          finish_reason: toOpenAIFinishReason(finishReason),
        }],
    usage: (() => {
      if (!usage) usage = {};
      normalizeUsage(usage);
      return {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
      };
    })(),
      });
      logNonStreamUsage();
      delivered = true;
    }
    // 只有本次尝试真的交付了正常响应才算「重试救回来了」；
    // 已向下游报错的尝试（502/429）不能记成 recovered
    if (attempt > 1 && delivered) {
      upstreamRetryStats.recovered++;
      log('info', 'Upstream retry recovered', {
        path: '/v1/chat/completions', model, attempt, elapsedMs: Date.now() - startTime,
      });
    }
    break attemptLoop;   // 本次尝试已完整处理（成功或已按语义返回错误）
  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/chat/completions',
        model,
        completionId,
      });
      return; // 下游已断连：不再重试（res 已关闭）
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        path: '/v1/chat/completions',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: completionId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: fullText ? fullText.length : 0,
      });
      try { reader?.cancel().catch(() => {}); } catch {}
      try { abortController.abort(); } catch {} // 打断 CC 上游
      const timeoutMsg = timeoutMessage(sessionKey);
      res.setHeader('Retry-After', '5');
      sendJSON(res, 429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
      return; // 超时已按语义回给下游（由下游决定是否重试），本代理不重试
    // 已解析出上游语义错误（429/503 等）时不重试：那是有意传下来的信号，重试会把它吞掉
    } else if (!res.headersSent && !aborted && !upstreamError && !translator?.upstreamError
               && attempt <= UPSTREAM_RETRY_MAX && isRetryableUpstreamError(e)) {
      // 传输层闪断且尚未向下游写出任何字节 → 代理内部静默重试（下游全程无感）
      await rewindAttempt('Upstream error before first byte - retrying', {
        message: e.message,
        cause: e.cause?.code || e.cause?.message || '(none)',
      });
      continue attemptLoop;
    } else {
      // 传输层错误不要覆盖已经解析到的语义错误：把「上游容量不足」说成「代理挂了」是误导
      const semantic = upstreamError || translator?.upstreamError;
      if (semantic && !res.headersSent) {
        log('warn', 'Upstream terminated after a parsed semantic error', { message: e.message });
        try { abortController.abort(); } catch {}
        sendJSON(res, semantic.status, semantic.body);
        return;
      }
      log('error', 'Upstream error', { message: e.message });
      try { abortController.abort(); } catch {} // 打断 CC 上游
      sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
      return;
    }
  }
  }   // ← end of attemptLoop
}

// ── Anthropic /v1/messages 协议转换 ─────────────────

function mapAnthropicStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'stop': return 'end_turn';
    // Anthropic 的原生枚举，必须原样透出：它表示「这一轮被暂停，后面还有内容」。
    // 折成 end_turn 会让下游把半截回答当成写完了（CLI 是靠自动续写把它吸收掉的，
    // 代理不自动续写，就必须如实上报，不能吞掉）。
    case 'pause_turn': return 'pause_turn';
    case 'refusal': return 'refusal';
    default: return 'end_turn';
  }
}

// OpenAI 的 finish_reason 只有 stop | length | tool_calls | content_filter | function_call。
// pause_turn 没有对应值：折成 'stop' 是谎报完成（正是要修的问题），
// 折成 'length' 至少如实表达了「输出不完整」，下游的截断处理会做对的事。
const OPENAI_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);

// 内部规范化取值 → 可透出的 OpenAI finish_reason。必须**全函数**：任何非标准值
// 原样写进 SSE / JSON body，严格客户端（GrokZen 的 FinishReason 是无兜底的枚举）
// 会把整条流判成反序列化失败，丢的是已经流出去的回答。
//
// 三种未知值，两种待遇：
//   · upstream_error —— 上游连接失败族，保留原值：流尾 incompleteDetail() /
//     incompleteUpstreamDetail() 按可重试 502 上报（语义不动）。
//   · 其余不认识的值（实测 'other'）—— 上游**确实发过** finish，只是原因不在标准
//     词汇表里：AI SDK 把不认识的 finish_reason 归成 other，而「一个完成信号都没
//     收到」在同一实现里归成 error，两者不是一回事。本代理另外两条协议面本来也
//     就是这么判的（/v1/messages 的 mapAnthropicStopReason 默认 end_turn、
//     /v1/responses 在 3152 行只拦 no finish / upstream_error，其余走
//     response.completed），这里对齐成 stop；以前 chat 路径把它折成可重试 502 并
//     写 response was truncated，既把「完成了但原因不认识」说成「没完成」，又白丢
//     一轮回答（provider 若稳定返回 other 会重试到上限后整轮失败）。
function toOpenAIFinishReason(finishReason) {
  if (finishReason === 'pause_turn') return 'length';
  // refusal 是 OpenAI 侧唯一合法的「被拦截」枚举（refusal / content_filter /
  // content-filter 三种上游写法已在 mapFinishReason 归一）。不折成 content_filter
  // 就会被当成「不认识的结束原因」→ 折成 stop 谎报完成，或走 502 白丢一轮回答。
  if (finishReason === 'refusal') return 'content_filter';
  if (finishReason === 'upstream_error') return finishReason;
  if (OPENAI_FINISH_REASONS.has(finishReason)) return finishReason;
  log('warn', 'Unrecognized upstream finish reason', { reason: String(finishReason), mappedTo: 'stop' });
  return 'stop';
}

// Generate a Claude-format fake signature for thinking blocks.
// Anthropic validates thinking signatures cryptographically; third-party
// proxies cannot mint valid ones. Claude Code's shallow check only requires
// base64 starting with 'E' (single-layer) / 'R' (double-layer) with payload
// first byte 0x12 — this satisfies that, letting CC display thinking.
// The payload is derived from the thinking text so each block's signature
// differs (closer to spec, avoids identical-signature quirks).
function fakeThinkingSignature(thinkingText) {
  const seed = crypto.createHash('sha256').update(thinkingText || 'dsh-proxy-thinking').digest().subarray(0, 64);
  const raw = Buffer.concat([Buffer.from([0x12, seed.length]), seed]);
  return raw.toString('base64');
}

function buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText) {
  const content = [];
  if (thinkingText) content.push({ type: 'thinking', thinking: thinkingText, signature: fakeThinkingSignature(thinkingText) });
  if (fullText) content.push({ type: 'text', text: fullText });
  if (toolCalls) {
    for (const tc of toolCalls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }
  return {
    id: `msg_${randomUUID().slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapAnthropicStopReason(finishReason || 'stop'),
    stop_sequence: null,
    usage: (() => {
      normalizeUsage(usage || {});
      // CC 未回报 usage 时按内容长度估算输出 token，避免客户端展示/记账为 0
      const estOut = Math.max(1,
        Math.ceil(((fullText || '').length + (thinkingText || '').length) / 4) + (toolCalls ? toolCalls.length * 20 : 0));
      return {
        // input_tokens 只计非缓存部分（Anthropic 语义），与 cache_* 相加才等于总输入
        input_tokens: anthropicInputTokens(usage),
        output_tokens: usage?.outputTokens || estOut,
        cache_creation_input_tokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
        cache_read_input_tokens: usage?.cachedInputTokens ?? 0,
      };
    })(),
  };
}

// Anthropic 服务端工具的 type → 内部种类。这类工具没有 input_schema，由 Anthropic 服务器执行；
// 经 CC 上游时只能由本 proxy 代为执行（web_search 已实现，见 executeWebSearch）或剥掉。
const SERVER_TOOL_TYPES = {
  web_search_20250305: 'web_search',
  web_fetch_20250910: 'web_fetch',
};
const DEFAULT_WEB_SEARCH_MAX_USES = 5;
const strippedServerToolWarned = new Set();
function warnServerToolStripped(type) {
  if (strippedServerToolWarned.has(type)) return;
  strippedServerToolWarned.add(type);
  log('info', 'Stripped Anthropic server tool (not executable via CC upstream)', {
    type,
    hint: type === 'web_search_20250305' ? 'set CC_WEB_SEARCH=1 to serve it via /alpha/web-search' : undefined,
  });
}

function convertAnthropicToOpenAI(anthropicReq) {
  // 1. Extract system prompt (top-level, not in messages array)
  let systemPrompt = '';
  let systemBlocks = null;
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemPrompt = anthropicReq.system;
    } else if (Array.isArray(anthropicReq.system)) {
      // 保留 cache_control：buildCcRequest 需要块数组才能把断点下发（CLI 的 params.system 就是块数组）
      systemBlocks = anthropicReq.system
        .filter(b => b && b.type === 'text')
        .map(b => {
          const blk = { type: 'text', text: b.text ?? '' };
          if (b.cache_control) blk.cache_control = b.cache_control;
          return blk;
        });
      systemPrompt = systemBlocks.map(b => b.text).join('\n');
    }
  }

  // 2. Build tool name map + convert messages
  const toolNameFromId = {};
  const openaiMessages = [];

  if (systemPrompt) {
    openaiMessages.push({ role: 'system', content: systemBlocks && systemBlocks.length ? systemBlocks : systemPrompt });
  }

  const messages = anthropicReq.messages || [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // 一条 Anthropic assistant 消息可能内含 [text?, server_tool_use, web_search_tool_result, text]
      //（本 proxy 上一轮代执行搜索后回给客户端、客户端原样带回的形态）。OpenAI 语义要求拆成
      // assistant{tool_calls} → tool{result} → assistant{text}，所以遇到搜索结果块时先 flush。
      let textContent = '';
      // Anthropic 的 thinking block 承载思考内容，需转成 reasoning_content
      // 交给 buildCcRequest 回传，否则 CC 会因缺少 reasoning 而拒绝
      let thinkingContent = '';
      let textParts = [];
      let textHasCache = false;
      let toolCalls = [];
      let pushedAny = false;
      const flushAssistant = () => {
        if (!textParts.length && !thinkingContent && !toolCalls.length) return;
        const assistantMsg = { role: 'assistant', content: (textParts.length > 1 || textHasCache) ? textParts : (textContent || null) };
        if (thinkingContent) assistantMsg.reasoning_content = thinkingContent;
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        openaiMessages.push(assistantMsg);
        pushedAny = true;
        textContent = ''; thinkingContent = ''; textParts = []; textHasCache = false; toolCalls = [];
      };
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
      for (const block of blocks) {
        if (block.type === 'text') {
          textContent += block.text || '';
          const part = { type: 'text', text: block.text || '' };
          if (block.cache_control) { part.cache_control = block.cache_control; textHasCache = true; }
          textParts.push(part);
        } else if (block.type === 'thinking') {
          thinkingContent += block.thinking || '';
        } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          // server_tool_use = 本 proxy 上一轮代执行的搜索调用，回放成普通 tool_call
          toolNameFromId[block.id] = block.name;
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        } else if (block.type === 'web_search_tool_result') {
          flushAssistant();
          openaiMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            name: toolNameFromId[block.tool_use_id] || 'web_search',
            content: decodeWebSearchResultBlocks(block.content),
          });
          pushedAny = true;
        }
      }
      flushAssistant();
      // 保持原行为：空 assistant 消息也推一条 content:null（不能在 tool 消息后多推一条空的）
      if (!pushedAny) openaiMessages.push({ role: 'assistant', content: null });
    } else if (msg.role === 'user') {
      let textContent = '';
      // parts 保持原始顺序（text / image_url），与 CLI 的 toWireMessages 一致
      const parts = [];
      let textHasCache = false;
      const toolResults = [];
      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += block.text || '';
            const part = { type: 'text', text: block.text || '' };
            if (block.cache_control) { part.cache_control = block.cache_control; textHasCache = true; }
            parts.push(part);
          } else if (block.type === 'image') {
            // Anthropic 图片块：{ type:'image', source:{ type:'base64', media_type, data } } 或 source.url
            const s = block.source || {};
            const url = s.type === 'base64' && s.data
              ? `data:${s.media_type || 'image/png'};base64,${s.data}`
              : (s.url || '');
            if (url) parts.push({ type: 'image_url', image_url: { url } });
          } else if (block.type === 'tool_result') {
            toolResults.push(block);
          }
        }
      }
      if (textContent) {
        // 暂存，tool_result 优先入队：OpenAI 语义要求 tool 消息紧跟 assistant 的
        // tool_calls，同一条 user 消息里的文本要排在 tool 结果之后
      }
      for (const tr of toolResults) {
        const toolContent = typeof tr.content === 'string' ? tr.content
          : Array.isArray(tr.content) ? tr.content.map(c => c.text || '').join('\n')
          : String(tr.content || '');
        // OpenAI 语义里 tool 消息的 name 是可选的；会话恢复等场景下 tool_use_id 可能
        // 找不到对应 assistant tool_use（历史被客户端裁剪），此时不硬塞空 name，
        // 避免 CC 上游报 "Tool result is missing"（issue #15）
        const toolMsg = { role: 'tool', tool_call_id: tr.tool_use_id, content: toolContent };
        if (toolNameFromId[tr.tool_use_id]) toolMsg.name = toolNameFromId[tr.tool_use_id];
        openaiMessages.push(toolMsg);
      }
      if (parts.length || textContent) {
        // 单块纯文本仍用字符串（线格不变）；多块 / 带断点 / 含图片时用块数组（CLI 的形态）。
        // 注意：content 为字符串时 parts 为空，必须用 textContent 判空（否则整条消息会丢）
        const singleText = parts.length <= 1 && (parts.length === 0 || parts[0].type === 'text') && !textHasCache;
        openaiMessages.push({ role: 'user', content: singleText ? textContent : parts });
      }
    }
  }

  // 3. Build OpenAI request
  const openaiReq = {
    model: anthropicReq.model || 'deepseek/deepseek-v4-flash',
    messages: openaiMessages,
    max_tokens: anthropicReq.max_tokens || 64000,
    stream: anthropicReq.stream === true,
  };

  // 4. Map tools
  // Anthropic 服务端工具（web_search_20250305 等）没有 input_schema，原实现会把它压成一个
  // 无描述、空参数的 function tool 喂给模型（模型要么不用，要么瞎调后客户端找不到处理器）。
  // 现在：默认剥掉；CC_WEB_SEARCH=1 时把 web_search 改写成带真实 schema 的 function tool，
  // 并把 max_uses / 域名限制记到 openaiReq._serverTools，由 handleMessages 的搜索循环消费。
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    const serverTools = {};
    const mapped = [];
    for (const t of anthropicReq.tools) {
      const serverKind = SERVER_TOOL_TYPES[t.type];
      if (serverKind) {
        if (!CFG.webSearch || serverKind !== 'web_search') {
          warnServerToolStripped(t.type);
          continue;
        }
        serverTools[t.name] = {
          kind: serverKind,
          maxUses: Number.isInteger(t.max_uses) && t.max_uses > 0 ? t.max_uses : DEFAULT_WEB_SEARCH_MAX_USES,
          allowedDomains: Array.isArray(t.allowed_domains) && t.allowed_domains.length ? t.allowed_domains : null,
          blockedDomains: Array.isArray(t.blocked_domains) && t.blocked_domains.length ? t.blocked_domains : null,
          used: 0,
        };
        mapped.push({
          type: 'function',
          function: {
            name: t.name,
            description: 'Search the web for current information. Returns a numbered list of results with title, URL and snippet. Use it when the answer depends on recent events or facts you are not certain about.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string', description: 'The search query' } },
              required: ['query'],
            },
          },
        });
        continue;
      }
      mapped.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      });
    }
    if (mapped.length > 0) openaiReq.tools = mapped;
    if (Object.keys(serverTools).length > 0) openaiReq._serverTools = serverTools;
  }

  // 5. Map tool_choice
  if (anthropicReq.tool_choice) {
    const tc = anthropicReq.tool_choice;
    if (tc.type === 'auto' || tc.type === undefined) {
      openaiReq.tool_choice = 'auto';
    } else if (tc.type === 'any') {
      openaiReq.tool_choice = 'required';
    } else if (tc.type === 'tool') {
      openaiReq.tool_choice = { type: 'function', function: { name: tc.name } };
    } else if (tc.type === 'none') {
      openaiReq.tool_choice = 'none';
    }
  }

  // 6. Optional params
  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p;
  if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences;
  if (anthropicReq.metadata?.user_id) openaiReq.user = anthropicReq.metadata.user_id;

  // 7. Anthropic thinking → reasoning_effort（LiteLLM 标准映射）
  if (anthropicReq.thinking) {
    const t = anthropicReq.thinking;
    if (t.type === 'disabled' || t.type === 'none') {
      // 不发送 reasoning_effort
    } else if (t.type === 'adaptive') {
      openaiReq.reasoning_effort = t.effort ?? 'medium';
    } else if (t.budget_tokens !== undefined) {
      if (t.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high';
      else if (t.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium';
      else if (t.budget_tokens >= 2000) openaiReq.reasoning_effort = 'low';
      else openaiReq.reasoning_effort = 'low'; // <2000 → low
    }
  }

  return openaiReq;
}

/**
 * Async generator that reads CC NDJSON response body and yields
 * Anthropic SSE events for streaming.
 */
async function* createAnthropicSseTranslator(response, model, messageId, ctx) {
  // 搜索循环会用多个翻译器实例续写同一条消息：块索引从 ctx 接续，结束时写回（见 finally）
  let nextBlockIndex = ctx.nextBlockIndex ?? 0;
  let currentBlockIndex = -1;
  let currentBlockType = null;
  let blockStarted = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let noCacheTokens = -1;   // -1 = 上游未提供该字段，改用减法兜底
  let stopReason = null;
  // 归一化后的 finishReason（mapAnthropicStopReason 之前的值），用于判定「是否正常结束」
  let finishNorm = null;
  // 是否见过终态 finish 事件。CLI 用同一个标志判定流是否被截断 —— 它只认 'finish'，
  // 'finish-step' 不在 CLI 的事件集里，故这里同样只认 'finish'。
  let sawFinish = false;
  let hasError = false;
  let currentThinkingText = ''; // accumulated thinking text for the open block

  // Close the current block (text or thinking) if one is active.
  // For thinking blocks, emit a signature_delta (Anthropic standard) before stop.
  function closeBlock() {
    if (blockStarted) {
      const idx = currentBlockIndex;
      const type = currentBlockType;
      let out = '';
      if (type === 'thinking') {
        out += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: fakeThinkingSignature(currentThinkingText) } })}\n\n`;
        currentThinkingText = '';
      }
      blockStarted = false;
      currentBlockType = null;
      return out + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;
    }
    return '';
  }
  const closeTextBlock = closeBlock;

  // Open a new block of the given type (closing any previous block first)
  function startBlock(type, contentBlock) {
    if (!blockStarted || currentBlockType !== type) {
      const close = closeBlock();
      currentBlockIndex = nextBlockIndex++;
      currentBlockType = type;
      blockStarted = true;
      return close + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: contentBlock })}\n\n`;
    }
    return '';
  }

  // Open a new text block (closing any previous block first)
  function startTextBlock() {
    return startBlock('text', { type: 'text', text: '' });
  }

  // Open a new thinking block (closing any previous block first)
  function startThinkingBlock() {
    return startBlock('thinking', { type: 'thinking', thinking: '' });
  }

  // Emit message_start (always the first event)；搜索循环第 2 轮起由 ctx.suppressMessageStart 抑制
  if (!ctx.suppressMessageStart) yield `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  })}\n\n`;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const idle = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS);

  try {
    while (true) {
      const result = await Promise.race([reader.read(), idle.arm()]);
      const { done, value } = result;
      if (done) break;
      ctx.bytesReceived += value.length;
      const chunkText = decoder.decode(value, { stream: true });
      buffer += chunkText;
      // 同 handleChatCompletions：无换行即无完整行，跳过全量 split
      let lines = [];
      if (chunkText.indexOf('\n') !== -1) {
        lines = buffer.split('\n');
        buffer = lines.pop() || '';
      }

      let hadOutput = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === '[DONE]') continue;
        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }
        if (!event.type) continue;
        ctx.lastCcEvent = event.type;

        switch (event.type) {
          case 'start': case 'start-step': case 'text-start': case 'reasoning-start':
            // Signal events, no user-visible data
            break;

          case 'reasoning-delta': {
            // CC reasoning → Anthropic thinking block (Claude Code shows this as thinking)
            const text = event.text || '';
            if (!text) break;
            const startBlock = startThinkingBlock();
            currentThinkingText += text;
            if (ctx.serverTools) ctx.thinkingAll = (ctx.thinkingAll || '') + text; // 搜索循环追加历史时回传 reasoning
            yield startBlock + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: text } })}\n\n`;
            hadOutput = true;
            break;
          }

          case 'text-delta': {
            const text = event.text || '';
            const startBlock = startTextBlock();
            yield startBlock + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`;
            outputTokens += 1;
            hadOutput = true;
            if (ctx.serverTools) ctx.roundText = (ctx.roundText || '') + text; // 搜索循环追加历史时保留本轮已发文本
            break;
          }

          case 'tool-call': {
            // Close any pending text block
            const closeBlock = closeTextBlock();
            if (closeBlock) yield closeBlock;

            const id = event.toolCallId || `toolu_${randomUUID().slice(0, 12)}`;
            const name = event.toolName || '';
            const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});

            // 服务端工具（web_search）：不当客户端 tool_use 下发——客户端没有它的处理器——
            // 改发 Anthropic 的 server_tool_use 块，并登记到 ctx.pendingSearches 交给
            // handleMessages 的搜索循环执行。本轮不终结消息（见 finalize 处的早退）。
            if (ctx.serverTools && ctx.serverTools[name]) {
              const srvId = 'srvtoolu_' + randomUUID().slice(0, 12);
              const srvIndex = nextBlockIndex++;
              yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: srvIndex, content_block: { type: 'server_tool_use', id: srvId, name, input: {} } })}\n\n`;
              yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: srvIndex, delta: { type: 'input_json_delta', partial_json: input } })}\n\n`;
              yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: srvIndex })}\n\n`;
              outputTokens += 20;
              hadOutput = true;
              (ctx.pendingSearches ||= []).push({
                id: srvId,                                    // 发给客户端的 id（回放时客户端原样带回）
                name,
                input: tryParseJSON(input),
                upstreamToolCallId: event.toolCallId || srvId, // 追加历史时对齐上游生成的 id
              });
              break;
            }

            const tcIndex = nextBlockIndex++;
            yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: tcIndex, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`;
            yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: tcIndex, delta: { type: 'input_json_delta', partial_json: input } })}\n\n`;
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: tcIndex })}\n\n`;
            outputTokens += 20;
            break;
          }

          case 'finish-step':
          case 'finish': {
            // 上游的 finishReason 是 'tool-calls'（连字符），必须先过 mapFinishReason 规范化成
            // 'tool_calls'，否则会掉进 mapAnthropicStopReason 的 default 变成 end_turn。
            // 真机实测踩到过：工具调用成功但 stop_reason 报 end_turn。
            sawFinish = true;   // finish-step 与 finish 都算完成信号
            if (event.finishReason) {
              finishNorm = mapFinishReason(event.finishReason);
              stopReason = mapAnthropicStopReason(finishNorm);
            }
            const u = event.totalUsage || event.usage;
            if (u) {
              normalizeUsage(u);
              inputTokens = u.inputTokens ?? inputTokens;
              outputTokens = u.outputTokens ?? outputTokens;
              cachedInputTokens = u.cachedInputTokens ?? cachedInputTokens;
              cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens ?? cacheWriteTokens;
              if (typeof u.inputTokenDetails?.noCacheTokens === 'number') {
                noCacheTokens = u.inputTokenDetails.noCacheTokens;
              }
              ctx.inputTokens = inputTokens;
              ctx.outputTokens = outputTokens;
              ctx.cachedInputTokens = cachedInputTokens;
            }
            // 上游未回报 usage 时保留本地按 delta 计数的估算值——清零会把有内容的
            // 响应误判成零输出（触发 429）。未知字段保持原值即可。
            break;
          }

          case 'error': {
            hasError = true;
            const upstreamError = mapCcEventError(event);
            ctx.upstreamError = upstreamError;
            yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: upstreamError.body.error })}\n\n`;
            break;
          }

          // 1.87.1 新增：写缓存用量单发一条事件；本路径以 finish 里的 usage 为准，
          // 这里只在 usage 明细缺失时补齐（与 chat 翻译器同一口径）。
          case 'cache-write-tokens': {
            const n = Number(event.cacheWriteTokens);
            if (Number.isFinite(n) && n >= 0 && n > cacheWriteTokens) cacheWriteTokens = n;
            break;
          }

          // 服务端工具结果（providerExecuted）：代理不执行工具，静默忽略。
          case 'server_tool_result': case 'tool-result':
          case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
            // Silent - no user-visible content
            break;
          default:
            log('warn', 'Unknown CC event type', { type: event.type });
            break;
        }
      }
    }

    // 无论上游是否回报 usage，都把本地计数同步进 ctx（零输出判定与超时日志依赖它）。
    // 注意：ctx.inputTokens 保存的是上游原始总数，仅供日志排查；
    // message_delta 的 input_tokens 走 anthropicInputTokens / noCacheTokens 换算，不读它。
    ctx.inputTokens = inputTokens;
    ctx.outputTokens = outputTokens;
    ctx.cachedInputTokens = cachedInputTokens;
    ctx.cacheWriteTokens = cacheWriteTokens;

    // Finalize — close pending text block, emit message_delta + message_stop
    if (!hasError) {
      const closeBlock = closeTextBlock();
      if (closeBlock) yield closeBlock;

      // 搜索循环：本轮有待执行的服务端工具调用 → 不发 message_delta / message_stop，
      // 把本轮 usage 累进 ctx.usageCarry，由 handleMessages 执行搜索后开下一轮续写。
      if (ctx.pendingSearches && ctx.pendingSearches.length) {
        const c = (ctx.usageCarry ||= { input: 0, output: 0, cached: 0, cacheWrite: 0 });
        c.input += noCacheTokens >= 0 ? noCacheTokens : Math.max(0, inputTokens - cachedInputTokens - (cacheWriteTokens || 0));
        c.output += outputTokens;
        c.cached += cachedInputTokens;
        c.cacheWrite += cacheWriteTokens || 0;
        return;
      }

      // 上游没有正常走完 finish（无 finish 事件 / provider 报连接失败）：
      // 绝不能补一个 end_turn 就 message_stop —— 那等于把截断谎报成完整回答。
      // 对齐 CLI：这一族一律按可重试错误处理。
      const incomplete = incompleteUpstreamDetail(sawFinish, finishNorm);
      if (incomplete) {
        log('warn', 'Upstream stream incomplete', { path: '/v1/messages', reason: incomplete });
        yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: incompleteUpstreamError(incomplete).body.error })}\n\n`;
      // 输出 token 为 0 时记为错误，避免下游异常计费
      } else if (outputTokens === 0) {
        yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`;
      } else {
        // 搜索循环：前几轮的 usage 记在 ctx.usageCarry，这里一并汇总（下游只看这一条 message_delta 计费）
        const carry = ctx.usageCarry || { input: 0, output: 0, cached: 0, cacheWrite: 0 };
        const finalUsage = {
          output_tokens: outputTokens + carry.output,
          cache_read_input_tokens: cachedInputTokens + carry.cached,
          cache_creation_input_tokens: (cacheWriteTokens || 0) + carry.cacheWrite,
          // 只计非缓存部分；否则下游把 input 与 cache_read 相加会得到约两倍（issue #25）
          input_tokens: (noCacheTokens >= 0
            ? noCacheTokens
            : Math.max(0, inputTokens - cachedInputTokens - (cacheWriteTokens || 0))) + carry.input,
        };
        if (ctx.searchCount) finalUsage.server_tool_use = { web_search_requests: ctx.searchCount };
        yield `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason || 'end_turn' },
          usage: finalUsage,
        })}\n\n`;

        yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
      }
    }
  } finally {
    ctx.nextBlockIndex = nextBlockIndex; // 搜索循环下一轮 / 结果块从这里接着编号
    // 确保流中断时通知上游
    idle.dispose();
    try { reader.cancel().catch(() => {}); } catch {}
  }
}

function sendAnthropicError(res, status, type, message, retryAfter) {
  const body = { type: 'error', error: { type, message } };
  const headers = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) {
    body.retry_after = retryAfter;
    headers['Retry-After'] = String(retryAfter);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function handleMessages(req, res) {
  let anthropicReq;
  try {
    anthropicReq = await readBody(req);
  } catch (e) {
    if (e.statusCode === 413) {
      sendAnthropicError(res, 413, 'invalid_request_error', e.message);
      return;
    }
    sendAnthropicError(res, 400, 'invalid_request_error', 'Invalid JSON body');
    return;
  }

  const auth = authenticate(req.headers);
  if (auth.error) {
    sendAuthError(res, auth.error, true);
    return;
  }
  const apiKey = auth.upstreamKey;

  const trackUsage = attachUsageRecording(res, apiKey);
  const stream = anthropicReq.stream === true;
  const model = anthropicReq.model || fallbackModel('claude-sonnet-4-6', '/messages');
  const disabledErr = disabledModelError(anthropicReq.model);
  if (disabledErr) {
    sendAnthropicError(res, 400, 'invalid_request_error', disabledErr);
    return;
  }

  // Convert Anthropic → OpenAI → CC
  let openaiReq = convertAnthropicToOpenAI(anthropicReq);
  // 同 chat：buildCcRequest 读的是这个对象的 model，兜底结果必须写回去才生效
  openaiReq.model = model;
  if (!stream && openaiReq._serverTools) {
    // 搜索循环只实现了流式（Claude Code 只走流式）；非流式退回剥掉服务端工具
    const names = new Set(Object.keys(openaiReq._serverTools));
    openaiReq.tools = (openaiReq.tools || []).filter(t => !names.has(t.function?.name));
    if (!openaiReq.tools.length) delete openaiReq.tools;
    delete openaiReq._serverTools;
  }
  let ccBody = buildCcRequest(openaiReq); // 搜索循环每轮追加历史后重建
  // issue #20：原始请求树（anthropicReq）在此之后不再被引用，显式断开以便尽早回收。
  // 但 **openaiReq 不能置空** —— PR #46 的搜索循环要往它的 messages/tools 上追加历史
  // 并重建 ccBody；issue #20 里置空它的前提（只剩 prompt_cache_key 还被用到）已不成立。
  anthropicReq = null;

  // 连续超时的作用域：优先用客户端给的会话标识，没有就按内容派生（与 chat 路径同一口径）。
  // 这里的 promptCacheKey 恒为 undefined —— Anthropic 协议没有这个字段，本路径的
  // forwardWithKeyRetry 也不传它，所以两边算出来的 session 才是同一个。
  const sessionKey = getSessionId(req.headers, apiKey, undefined, ccBody).id;

  const abortController = new AbortController();
  let aborted = false;
  // 提前初始化，断连回调/超时 catch 安全引用（避免块级作用域 ReferenceError）
  const startTime = Date.now();
  let messageId = '';
  let reader = null;
  let bytesReceived = 0; let lastCcEvent = ''; let fullText = '';

  try {
    // 转发到 CC API（遇 Key 失效/限流自动换 Key 重试）
    const { response: ccResponse } = await forwardWithKeyRetry(
      ccBody, apiKey, req.headers, abortController.signal
    );

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      const mapped = mapCcError(ccResponse.status, errorText);
      log('error', 'CC API error (Anthropic)', { status: ccResponse.status, code: mapped.code, body: summarizeUpstreamError(errorText) });
      sendAnthropicError(res, mapped.status, mapped.body.error.type, mapped.body.error.message);
      return;
    }

    // 下游断连检测：打断 CC 上游 + 记录日志
    res.on('close', () => {
      if (res.writableEnded) return; // Normal completion, not a disconnect
      aborted = true;
      if (!abortController.signal.aborted) {
        // 断连前抢发 usage=0 终止事件，避免下游自行估算 token
        try {
          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0 },
          })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        } catch {}
        try { abortController.abort(); } catch {}
      }
      log('warn', 'Client disconnected', {
        path: '/v1/messages',
        model,
        messageId,
        streaming: stream,
        elapsedMs: Date.now() - startTime,
      });
    });

    if (stream) {
      // ── 流式 Anthropic SSE ──
      // 行为与 /v1/chat/completions 对齐：首个上游事件（thinking/text/tool_use）到达即
      // 发 header——之前扣到 text_delta 才发，推理模型 thinking 阶段客户端收不到任何
      // 字节，触发下游 60s 首字节超时（context canceled）。message_start 仍缓冲：
      // 完全无输出时还能回 JSON 429/502 让 SDK 自动重试（同 chat 端点）。
      let started = false;
      const buf = [];
      const SSE_HEADERS = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      };
      const flushBuf = async () => {
        if (!started) {
          res.writeHead(200, SSE_HEADERS);
          started = true;
        }
        for (const ev of buf) { try { res.write(ev); } catch {} }
        buf.length = 0;
        await waitDrain(res);
      };

      // 心跳：等价于 chat 端点的 ': keepalive'——chat 在每轮读到静默事件时发注释行，
      // Anthropic 翻译器会吞掉 signal 事件，这里改用空闲计时发 ping（Anthropic 标准
      // 事件，官方 SDK 会忽略），覆盖上游排队/长 thinking 的静默窗口
      let lastSentAt = Date.now();
      const heartbeat = setInterval(() => {
        // 不向已积压的下游继续塞数据：定时器回调是同步的，无法 await waitDrain，
        // 因此用 writableNeedDrain 直接跳过本轮心跳（背压场景下少发一个 ping 无副作用）
        if (started && !aborted && !res.writableEnded && !res.writableNeedDrain && Date.now() - lastSentAt > 15000) {
          try { res.write('event: ping\ndata: {"type":"ping"}\n\n'); lastSentAt = Date.now(); } catch {}
        }
      }, 5000);

      let ctx;
      try {
        messageId = 'msg_' + randomUUID().slice(0, 12);
        ctx = {
          bytesReceived: 0, lastCcEvent: '', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, upstreamError: null,
          // 搜索循环状态：serverTools 来自 convertAnthropicToOpenAI；pendingSearches 由翻译器登记
          serverTools: openaiReq._serverTools || null,
          pendingSearches: null, usageCarry: null, searchCount: 0, nextBlockIndex: 0,
          suppressMessageStart: false, thinkingAll: '', roundText: '',
        };
        const emit = async (ev) => {
          if (started) {
            try { res.write(ev); } catch {}
            lastSentAt = Date.now();
            await waitDrain(res);
          } else {
            buf.push(ev);
          }
        };

        // ── 服务端工具（web_search）由本 proxy 代执行 ──
        // 模型发 tool call → 调 CC 的 /alpha/web-search → 结果以 web_search_tool_result 块下发
        // → 以 tool_calls + tool 消息追加历史、重建 ccBody 重发上游 → 模型续写。每轮一个翻译器实例，
        // 块索引 / usage 通过 ctx 接续。轮数上限 = 各工具 max_uses 之和 + 1（末轮收尾），再硬性封顶。
        // 轮数上限 = 各工具 max_uses 之和（硬性封顶 10；模型可能一轮并行调多次，一轮就吃掉多个额度）。
        // 额度用完后：给模型一轮 max_uses_exceeded 的错误结果，并把该工具移出定义让它物理上不能再调
        //（CC 的 tool_choice 只有 auto/any/tool，没有 none——真机 400 验证过）；它若还连续再调，
        // 不再上游，本地补错误块 + 终结事件，保证流一定有 message_stop。
        const maxSearchRounds = ctx.serverTools
          ? Math.min(10, Object.values(ctx.serverTools).reduce((s, t) => s + t.maxUses, 0))
          : 0;
        let roundResponse = ccResponse;
        let exhaustedRounds = 0; // 连续"全部 max_uses_exceeded"的轮数
        // 本地终结：不再上游，用累计 usage 发 message_delta + message_stop
        const finalizeLocally = async (why) => {
          const c = ctx.usageCarry || { input: 0, output: 0, cached: 0, cacheWrite: 0 };
          const usage = { output_tokens: c.output, input_tokens: c.input, cache_read_input_tokens: c.cached, cache_creation_input_tokens: c.cacheWrite };
          if (ctx.searchCount) usage.server_tool_use = { web_search_requests: ctx.searchCount };
          await emit(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage })}\n\n`);
          await emit(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          log('warn', 'Web search loop finalized locally', { why, id: messageId });
        };
        for (let round = 0; ; round++) {
          ctx.pendingSearches = null;
          ctx.roundText = '';
          ctx.thinkingAll = '';
          ctx.suppressMessageStart = round > 0;
          const generator = createAnthropicSseTranslator(roundResponse, model, messageId, ctx);
          for await (const event of generator) {
            if (aborted) break;
            if (!started && !event.startsWith('event: message_start')) {
              await flushBuf();
            }
            await emit(event);
          }
          if (aborted || !ctx.pendingSearches || !ctx.pendingSearches.length) break;

          if (round > maxSearchRounds) {
            // 失控保护：轮数封顶。补错误结果块并本地收尾。
            for (const p of ctx.pendingSearches) {
              const idx = ctx.nextBlockIndex++;
              await emit(
                `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'web_search_tool_result', tool_use_id: p.id, content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } } })}\n\n`
                + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`,
              );
            }
            await finalizeLocally(`round cap ${maxSearchRounds} exceeded`);
            break;
          }

          const assistantToolCalls = [];
          const toolMessages = [];
          for (const p of ctx.pendingSearches) {
            const tool = ctx.serverTools[p.name];
            let result;
            if (tool.used >= tool.maxUses) {
              result = { errorCode: 'max_uses_exceeded' };
            } else {
              tool.used++;
              ctx.searchCount++;
              result = await executeWebSearch(p.input?.query, apiKey, req.headers, abortController.signal, {
                allowedDomains: tool.allowedDomains,
                blockedDomains: tool.blockedDomains,
              });
            }
            const content = result.errorCode
              ? { type: 'web_search_tool_result_error', error_code: result.errorCode }
              : result.blocks;
            const idx = ctx.nextBlockIndex++;
            await emit(
              `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'web_search_tool_result', tool_use_id: p.id, content } })}\n\n`
              + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`,
            );
            assistantToolCalls.push({ id: p.upstreamToolCallId, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input || {}) } });
            toolMessages.push({
              role: 'tool', tool_call_id: p.upstreamToolCallId, name: p.name,
              content: result.errorCode ? `Search failed: ${result.errorCode}` : result.textForModel,
            });
          }
          if (aborted) break;

          // 模型拿到 max_uses_exceeded 还连续再调 → 不再上游，本地收尾
          const allExhausted = toolMessages.length > 0 && toolMessages.every(m => m.content.startsWith('Search failed: max_uses_exceeded'));
          exhaustedRounds = allExhausted ? exhaustedRounds + 1 : 0;
          if (exhaustedRounds >= 2) { await finalizeLocally('model kept calling after max_uses_exceeded'); break; }

          // 追加历史：assistant{本轮已发文本 + tool_calls (+ reasoning：CC 在 thinking 模式下校验它随历史带回)} → tool 结果
          const assistantMsg = { role: 'assistant', content: ctx.roundText || null, tool_calls: assistantToolCalls };
          if (ctx.thinkingAll) assistantMsg.reasoning_content = ctx.thinkingAll;
          openaiReq.messages.push(assistantMsg, ...toolMessages);
          // 额度用完的服务端工具移出定义：模型物理上不能再调，客户端工具不受影响
          const exhausted = new Set(Object.keys(ctx.serverTools).filter(n => ctx.serverTools[n].used >= ctx.serverTools[n].maxUses));
          if (exhausted.size && Array.isArray(openaiReq.tools)) {
            openaiReq.tools = openaiReq.tools.filter(t => !exhausted.has(t.function?.name));
            const tc = openaiReq.tool_choice;
            if (tc === 'required' || (tc && typeof tc === 'object' && exhausted.has(tc.function?.name))) openaiReq.tool_choice = 'auto';
            if (!openaiReq.tools.length) { delete openaiReq.tools; delete openaiReq.tool_choice; }
          }
          ccBody = buildCcRequest(openaiReq);
          log('info', 'Web search round', { round: round + 1, searches: assistantToolCalls.length, removedTools: [...exhausted], id: messageId });

          roundResponse = await forwardToCC(ccBody, apiKey, req.headers, abortController.signal);
          if (!roundResponse.ok) {
            const errorText = await roundResponse.text().catch(() => '');
            const mapped = mapCcError(roundResponse.status, errorText);
            log('error', 'CC API error (web search round)', { status: roundResponse.status, code: mapped.code, body: summarizeUpstreamError(errorText) });
            ctx.upstreamError = mapped;
            await emit(`event: error\ndata: ${JSON.stringify({ type: 'error', error: mapped.body.error })}\n\n`);
            break;
          }
        }

        if (!aborted) {
          clearTimeouts(sessionKey);
          if (ctx.upstreamError) {
            if (!started) {
              sendAnthropicError(
                res,
                ctx.upstreamError.status,
                ctx.upstreamError.body.error.type,
                ctx.upstreamError.body.error.message,
              );
            }
            // started 时 error 事件已在循环中经 SSE 下发，按规范 error 事件即终结
          } else if (ctx.outputTokens === 0) {
            try { abortController.abort(); } catch {}
            if (!started) {
              sendAnthropicError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
              return;
            }
            await flushBuf();
          } else {
            await flushBuf();
          }
        }
      } catch (e) {
        if (aborted) {
          // 客户端已断连，只清理（close handler 已调用 abortController.abort()）
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/messages',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: messageId,
            bytesReceived: ctx.bytesReceived,
            lastCcEvent: ctx.lastCcEvent || '(none)',
            inputTokens: ctx.inputTokens,
            outputTokens: ctx.outputTokens,
            cachedInputTokens: ctx.cachedInputTokens,
          });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            const timeoutMsg = timeoutMessage(sessionKey);
            sendAnthropicError(res, 429, 'rate_limit_error', timeoutMsg);
            return;
          }
          if (!res.writableEnded) {
            const timeoutMsg = timeoutMessage(sessionKey);
            // end() 而不是 destroy()：理由见 handleChatCompletions 流式超时分支
            try { res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: timeoutMsg }, retry_after: 5 })}\n\n`); } catch {}
          }
        } else {
          log('error', 'Anthropic stream error', { message: e.message });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            sendAnthropicError(res, 502, 'proxy_error', `Upstream error: ${e.message}`, 10);
            return;
          }
          if (!res.writableEnded) {
            try {
              res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: e.message } })}\n\n`);
            } catch {}
          }
        }
      } finally {
        clearInterval(heartbeat);
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式 Anthropic JSON ──
      const messageId = 'msg_' + randomUUID().slice(0, 12);
      let finishReason = 'stop';
      let sawFinish = false;
      let usage = null;
      let toolCalls = null;
      let thinkingText = ''; // CC reasoning → Anthropic thinking block
      let upstreamError = null;

      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]') continue;
          try {
            const event = JSON.parse(trimmed);
            switch (event.type) {
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'reasoning-delta': lastCcEvent = event.type; thinkingText += event.text || ''; break;
              case 'tool-call':
                lastCcEvent = event.type;
                (toolCalls = toolCalls || []).push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  function: {
                    name: event.toolName || '',
                    arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                  },
                });
                break;
              case 'finish-step':
              case 'finish':
                lastCcEvent = event.type;
                sawFinish = true;
                finishReason = mapFinishReason(event.finishReason || 'stop');
                if (event.totalUsage || event.usage) { usage = event.totalUsage || event.usage; trackUsage(usage); }
                break;
              case 'error':
                lastCcEvent = event.type;
                upstreamError = mapCcEventError(event);
                log('warn', 'CC error (Anthropic non-stream)', {
                  message: event.error?.message || event.message,
                  upstreamStatus: upstreamError.reportedStatus,
                  upstreamRetryable: event.error?.isRetryable,
                  code: upstreamError.code,
                  mappedTo: upstreamError.status,
                });
                break;
              // 无内容的事件：与流式翻译器的静默列表保持一致。
              // text-start / start / start-step / reasoning-start 原先只在流式路径被识别，
              // 非流式路径会掉进 default 打成 'Unknown CC event type' —— 上游每个响应都会发，
              // 于是线上刷屏。它们本身不携带内容（内容在 text-delta），纯粹是噪音。
              case 'text-start': case 'text-end': case 'start': case 'start-step':
              case 'reasoning-start': case 'reasoning-end':
              case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end':
              // 1.87.1 起上游还会发 cache-write-tokens（写缓存用量单发一条）与
              // server_tool_result / tool-result（providerExecuted 的服务端工具结果）。
              // 非流式路径不区分这些细粒度事件，只要不刷 Unknown 警告即可。
              case 'cache-write-tokens': case 'server_tool_result': case 'tool-result':
              case 'tool-error':
                // Silent - no user-visible content
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type });
                break;
            }
          } catch {}
        }
      };

      const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);
      while (true) {
        const result = await Promise.race([reader.read(), idle.arm()]);
        const { done, value } = result;
        if (done) break;
        bytesReceived += value.length;
        const chunkText = decoder.decode(value, { stream: true });
        buf += chunkText;
        // 无换行则不可能产生完整行，跳过全量 split
        if (chunkText.indexOf('\n') !== -1) processLines();
      }
      idle.dispose();
      processLines();

      if (upstreamError) {
        sendAnthropicError(res, upstreamError.status, upstreamError.body.error.type, upstreamError.body.error.message);
        return;
      }

      // 上游没有正常走完 finish —— 对齐 CLI 按可重试 502 处理，不谎报成功
      {
        const incomplete = incompleteUpstreamDetail(sawFinish, finishReason);
        if (incomplete) {
          log('warn', 'Upstream stream incomplete', { path: '/v1/messages', reason: incomplete });
          const err = incompleteUpstreamError(incomplete);
          try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
          sendAnthropicError(res, err.status, err.body.error.type, err.body.error.message, err.retry_after);
          return;
        }
      }

      // 零输出判定改为按实际内容：上游偶发不回 totalUsage 时，旧逻辑（usage?.outputTokens ?? 0 === 0）
      // 会把有完整文本的响应误杀成 429
      if (!fullText && !thinkingText && !toolCalls) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendAnthropicError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
        return;
      }

      clearTimeouts(sessionKey);
      trackUsage(usage);
      sendJSON(res, 200, buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText));
    }
  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/messages',
        model,
        messageId,
      });
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        path: '/v1/messages',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: messageId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: fullText ? fullText.length : 0,
      });
      try { reader?.cancel().catch(() => {}); } catch {}
      try { abortController.abort(); } catch {} // 打断 CC 上游
      const timeoutMsg = timeoutMessage(sessionKey);
      res.setHeader('Retry-After', '5');
      sendAnthropicError(res, 429, 'rate_limit_error', timeoutMsg);
    } else {
      log('error', 'Upstream error', { message: e.message });
      try { abortController.abort(); } catch {} // 打断 CC 上游
      sendAnthropicError(res, 502, 'proxy_error', `Upstream error: ${e.message}`, 10);
    }
  }
}

// ── 动态模型列表 ────────────────────────────────────

function isPricingRow(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.id === 'string'
    && value.availability && typeof value.availability === 'object'
    && !Array.isArray(value.availability);
}

function findPricingRows(value) {
  if (Array.isArray(value)) {
    for (const child of value) {
      const nested = findPricingRows(child);
      if (nested.length) return nested;
    }
  } else if (value && typeof value === 'object') {
    if (Array.isArray(value.rows)) {
      const rows = value.rows.filter(isPricingRow);
      if (rows.length === value.rows.length && rows.length) return rows;
    }
    for (const child of Object.values(value)) {
      const nested = findPricingRows(child);
      if (nested.length) return nested;
    }
  }
  return [];
}

function extractPricingRows(rsc) {
  for (const line of rsc.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    try {
      const rows = findPricingRows(JSON.parse(line.slice(separator + 1)));
      if (rows.length) return rows;
    } catch { /* RSC also contains non-JSON control records. */ }
  }
  return [];
}

function filterModelsByPlan(models, planId, rows) {
  if (!planId) return models;
  const modelKey = id => String(id).split('/').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
  const keysFor = item => [item.id, item.name].filter(Boolean).map(modelKey);
  const availability = new Map();
  for (const row of rows.filter(isPricingRow)) {
    for (const key of keysFor(row)) availability.set(key, row.availability);
  }
  return models.filter(model => !keysFor(model).some(key => availability.get(key)?.[planId] === false));
}

// 套餐过滤所需的两份数据（订阅 planId、pricing 表）只缓存成功结果。
// 刷新失败先重试；重试仍失败则降级用最后一次成功的结果（即使已过期），
// 从没成功过才返回 null（调用方据此不过滤，输出全量）。失败本身不缓存，下次请求会再试。
const planFilterCache = new Map();      // apiKey → { data: planId|null, expiresAt }
const planFilterInFlight = new Map();
const pricingRowsState = { cache: null, inFlight: null };
const PLAN_FILTER_ATTEMPTS = 3;
const PLAN_FILTER_RETRY_BASE_MS = 300;

/** 不值得重试的失败（如 401/403、页面结构变了）：重试也只会得到同样结果。 */
class NonRetryableError extends Error {}

async function withRetry(load) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await load();
    } catch (e) {
      if (e instanceof NonRetryableError || attempt >= PLAN_FILTER_ATTEMPTS) throw e;
      await sleep(PLAN_FILTER_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
}

/**
 * 读缓存或刷新。entry 由 getEntry/setEntry 存取，并发刷新共用 inFlight。
 * 返回 { data, ok }：ok=false 表示本次刷新失败且没有任何历史成功结果。
 */
async function cachedRefresh({ what, getEntry, setEntry, getInFlight, setInFlight, load }) {
  const entry = getEntry();
  if (entry && entry.expiresAt > Date.now()) return { data: entry.data, ok: true };
  const pending = getInFlight();
  if (pending) return pending;

  const p = withRetry(load)
    .then(data => {
      setEntry({ data, expiresAt: Date.now() + CFG.modelRefreshIntervalMs });
      return { data, ok: true };
    })
    .catch(e => {
      const stale = getEntry();
      if (stale) {
        log('warn', `${what} refresh failed, using last known result`, { error: e.message });
        return { data: stale.data, ok: true };
      }
      log('warn', `${what} refresh failed, using unfiltered list`, { error: e.message });
      return { data: null, ok: false };
    })
    .finally(() => setInFlight(null));
  setInFlight(p);
  return p;
}

function httpStatusError(what, response) {
  try { response.body?.cancel?.(); } catch {}
  const msg = `${what} HTTP ${response.status}`;
  // 4xx（除 408/429）是确定性失败，不重试
  const s = response.status;
  return s >= 400 && s < 500 && s !== 408 && s !== 429 ? new NonRetryableError(msg) : new Error(msg);
}

async function fetchPlanId(apiKey) {
  const subscription = await upstreamFetch(`${CFG.apiBase}/alpha/billing/subscriptions`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!subscription.ok) throw httpStatusError('subscription', subscription);
  const subscriptionBody = await subscription.json();
  // 成功响应但没有 planId（如无订阅）是有效结果，照常缓存，不当失败处理
  const planId = subscriptionBody?.data?.planId;
  return typeof planId === 'string' && planId ? planId : null;
}

async function fetchPricingRowsOnce() {
  const pricing = await upstreamFetch('https://commandcode.ai/docs/resources/pricing-limits', {
    headers: { rsc: '1' },
    signal: AbortSignal.timeout(10000),
  });
  if (!pricing.ok) throw httpStatusError('pricing', pricing);
  const rows = extractPricingRows(await pricing.text());
  if (!rows.length) throw new NonRetryableError('pricing model rows not recognized');
  return rows;
}

function fetchPricingRows() {
  return cachedRefresh({
    what: 'Pricing model rows',
    getEntry: () => pricingRowsState.cache,
    setEntry: entry => { pricingRowsState.cache = entry; },
    getInFlight: () => pricingRowsState.inFlight,
    setInFlight: p => { pricingRowsState.inFlight = p; },
    load: fetchPricingRowsOnce,
  });
}

function fetchPlanIdCached(apiKey) {
  return cachedRefresh({
    what: 'Plan subscription',
    getEntry: () => planFilterCache.get(apiKey),
    setEntry: entry => planFilterCache.set(apiKey, entry),
    getInFlight: () => planFilterInFlight.get(apiKey),
    setInFlight: p => { if (p) planFilterInFlight.set(apiKey, p); else planFilterInFlight.delete(apiKey); },
    load: () => fetchPlanId(apiKey),
  });
}

async function applyPlanFilter(models, apiKey) {
  if (!CFG.useProviderModelsWithPlanFilter || !apiKey) return models;
  const plan = await fetchPlanIdCached(apiKey);
  if (!plan.ok || !plan.data) return models;
  const pricing = await fetchPricingRows();
  if (!pricing.ok) return models;
  return filterModelsByPlan(models, plan.data, pricing.data);
}

// 目录的拉取/缓存/单飞/静态回退都在 lib/models.mjs 的 catalog 里（旧实现只取 id/name，
// 丢掉了 context_length / maxOutputTokens / supported_endpoints，后台「模型」页要用）。
// 这里只负责形状适配 + 可选的套餐过滤。
async function fetchModels(apiKey) {
  const models = await catalog.sync({ apiKey });
  return applyPlanFilter(models, apiKey);
}

// ── OpenAI Responses API（/v1/responses）──────────────
// 供 Codex 等使用 Responses 协议的客户端接入。代理仍是无状态转换层：
// 把 input 翻译成内部 Chat 格式，复用同一套 CC 转发管线。
// 不支持 previous_response_id / store（需要服务端保存会话，与无状态定位冲突），
// 收到直接 400，避免静默降级成错误答案。

function responsesTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => (p && typeof p === 'object' ? (p.text || '') : '')).join('');
}

/** `input_image` 部件（含省略 type 只带 image_url 的写法）。 */
function isResponsesImagePart(part) {
  return !!part && typeof part === 'object' && (part.type === 'input_image' || part.image_url !== undefined);
}

/** Responses 的图 → Chat 的 `image_url` 部件（对象形的 image_url，CC 侧读 `.url`）。 */
function responsesImagePartsOf(parts) {
  if (!Array.isArray(parts)) return [];
  return parts.filter(isResponsesImagePart).map(part => {
    const raw = part.image_url !== undefined ? part.image_url : part.input_image;
    const url = typeof raw === 'string' ? raw : (raw && raw.url) || '';
    return url ? { type: 'image_url', image_url: { url } } : null;
  }).filter(Boolean);
}

// data URL 图片：一段文本里超过这个长度的 data URL 就当成"图"，提出来单独发；小图留在文本里
const INLINE_IMAGE_MIN = 256 * 1024;
// 单张 data URL 上限：再大就不要了，只留一句占位说明（既撑爆上游窗口，也撑爆内存）
const MAX_TOOL_IMAGE_URL = 12 * 1024 * 1024;
const DATA_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

// 从一段文本里捞出体积可观的 data URL 图片，原地替换成 [image] 占位。
// 必要性：base64 一旦被上游按**文本**分词就极其昂贵 —— 真机实测单张 2.76MB 截图 ≈ 1.92M token。
function extractInlineImages(text) {
  const images = [];
  const stripped = String(text).replace(DATA_URL_RE, (url) => {
    if (url.length < INLINE_IMAGE_MIN) return url;          // 小图留文本，别把工具输出切碎
    if (url.length > MAX_TOOL_IMAGE_URL) return '[image omitted: too large]';
    images.push(url);
    return '[image]';
  });
  return { text: stripped, images };
}

// Responses 的 function_call_output.output 可能是字符串，也可能是内容块数组；后者能带图。
// Codex Desktop 的截图工具就是 [{type:'input_image', image_url:'data:image/png;base64,...'}]。
// 返回 { text, images }，images 为 data URL 字符串数组。
function splitToolOutput(output) {
  if (output === undefined || output === null) return { text: '', images: [] };
  const texts = [];
  const images = [];
  const pushText = (raw) => {
    const r = extractInlineImages(raw);
    if (r.text) texts.push(r.text);
    images.push(...r.images);
  };
  if (typeof output === 'string') {
    pushText(output);
  } else if (Array.isArray(output)) {
    for (const part of output) {
      if (!part) continue;
      if (part.type === 'input_image' || part.type === 'image_url') {
        const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url && part.image_url.url) || '';
        if (url.startsWith('data:')) {
          if (url.length <= MAX_TOOL_IMAGE_URL) images.push(url);
          else texts.push('[image omitted: too large]');
        } else if (url) {
          texts.push(`[image: ${url}]`);      // 外链图上游不认，只能留个说明
        }
      } else if (typeof part.text === 'string') {
        pushText(part.text);
      } else {
        pushText(JSON.stringify(part));       // 未知块保持原样，与旧行为一致
      }
    }
  } else {
    pushText(JSON.stringify(output));
  }
  return { text: texts.filter(Boolean).join('\n'), images };
}
// 单条请求内"工具截图"的总字节预算。工具截图会随每一轮请求全量重传，是内存与首字延迟的
// 头号杀手：真机实测一个 Codex 会话里 11 张截图 ≈5.5MB base64，配合 README 记录的内存放大
// ×5.1~7.4，把 1GB 的机器打到 global OOM（node anon-rss 532MB，内核把整机拖死）。
// 策略：从**最新**往回保留，预算内照发，超预算的老图替换成占位说明 —— 让模型知道有图被丢，
// 而不是以为历史里本来就没图。CC_MAX_TOOL_IMAGE_MB=0 关闭该行为。
const MAX_TOOL_IMAGE_BYTES = (() => {
  const mb = Number.parseFloat(process.env.CC_MAX_TOOL_IMAGE_MB ?? '6');
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 0;
})();

function trimToolImages(messages) {
  if (!MAX_TOOL_IMAGE_BYTES) return;
  const refs = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) if (part && part._toolImage) refs.push({ m, part });
  }
  if (!refs.length) return;
  const keep = new Set();
  let used = 0;
  for (let i = refs.length - 1; i >= 0; i--) {           // 从最新往回挑，至少保一张
    const len = (refs[i].part.image_url && refs[i].part.image_url.url || '').length;
    if (keep.size === 0 || used + len <= MAX_TOOL_IMAGE_BYTES) { keep.add(i); used += len; }
  }
  if (keep.size === refs.length) return;                 // 没超预算，原样不动
  let droppedBytes = 0;
  for (let i = 0; i < refs.length; i++) {
    if (keep.has(i)) continue;
    const idx = refs[i].m.content.indexOf(refs[i].part);
    if (idx === -1) continue;
    droppedBytes += (refs[i].part.image_url && refs[i].part.image_url.url || '').length;
    refs[i].m.content[idx] = { type: 'text', text: '[older tool screenshot omitted: image budget exceeded]' };
  }
  log('warn', 'Tool images trimmed to budget', {
    total: refs.length, kept: keep.size, dropped: refs.length - keep.size,
    keptBytes: used, droppedBytes, budgetBytes: MAX_TOOL_IMAGE_BYTES,
  });
}


function responsesReasoningOf(item) {
  if (!item) return '';
  if (Array.isArray(item.summary) && item.summary.length) return item.summary.map(p => (p && p.text) || '').join('');
  if (Array.isArray(item.content) && item.content.length) return item.content.map(p => (p && p.text) || '').join('');
  return typeof item.text === 'string' ? item.text : '';
}

function newResponsesId(prefix) {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 24);
}

function convertResponsesToChat(respReq) {
  const messages = [];

  if (respReq.instructions !== undefined && respReq.instructions !== null) {
    const sys = responsesTextOf(respReq.instructions);
    if (sys) messages.push({ role: 'system', content: sys });
  }

  // Responses 把 reasoning / message / function_call 拆成并列 item，
  // Chat 要求它们挂在同一条 assistant 消息上，故先累积再冲刷。
  let pending = null;
  // 并行 tool_call 的图片必须集中放在所有 tool_result 之后：CC/Anthropic 要求
  // tool_result 紧跟 tool_use，若图片 user 消息插在多个 tool_result 之间，会打断
  // 配对 —— 上游报 "Tool result is missing for tool call ..."。
  // 单个 tool_call 带图时图片本就在序列末尾，不受影响；并行多个都带图时才触发。
  let pendingToolImages = [];
  const flushToolImages = () => {
    if (!pendingToolImages.length) return;
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: '[images returned by tool calls]' },
        ...pendingToolImages,
      ],
    });
    pendingToolImages = [];
  };
  const ensurePending = () => (pending = pending || { role: 'assistant', content: null, tool_calls: [] });
  const flushPending = () => {
    if (!pending) return;
    if (!pending.tool_calls.length) delete pending.tool_calls;
    if (!pending.reasoning_content) delete pending.reasoning_content;
    if (pending.content === null && !pending.tool_calls) { pending = null; return; }
    messages.push(pending);
    pending = null;
  };

  const input = respReq.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const _itemType = item.type ?? (item.role ? 'message' : undefined);
      // 非 function_call_output 的 item 打断了 tool_result 序列，先把累积的图片 flush
      if (_itemType !== 'function_call_output') flushToolImages();
      // OpenAI 规范里 input 数组的联合类型第一个成员是 EasyInputMessage，它的
      // required 只有 role 与 content —— type 是可选的（官方文档与 SDK 示例普遍写作
      // { role: 'user', content: 'hi' }）。item.type 为 undefined 但有 role 时按
      // message 处理，否则这类 item 会落进 default 被丢弃：全部省略时只剩
      // "input is required" 的误导性报错；混合形态时更糟 —— 校验能过，用户在
      // HTTP 200 下静默丢消息。这里只在 type 缺失时兜底，带 type 的 item 判定不变。
      switch (_itemType) {
        case 'reasoning': {
          const t = responsesReasoningOf(item);
          if (t) ensurePending().reasoning_content = t;
          break;
        }
        case 'message': {
          const text = responsesTextOf(item.content);
          const images = responsesImagePartsOf(item.content);
          if (item.role === 'assistant') {
            // assistant 消息上的图没有落点：Chat 的 assistant 内容只有文本槽
            if (text) ensurePending().content = text;
          } else if (item.role === 'system' || item.role === 'developer') {
            flushPending();
            messages.push({ role: 'system', content: text });
          } else if (images.length) {
            // 用户槽的图必须原样保留：CC 只收 user 角色上的图，丢掉时上游照样回 200，
            // 客户端侧看不见任何异常（只表现为模型"没看到图"）。
            flushPending();
            messages.push({
              role: 'user',
              content: [...(text ? [{ type: 'text', text }] : []), ...images],
            });
          } else {
            flushPending();
            messages.push({ role: 'user', content: text });
          }
          break;
        }
        case 'function_call': {
          ensurePending().tool_calls.push({
            id: item.call_id || item.id || ('call_' + randomUUID().slice(0, 8)),
            type: 'function',
            function: { name: item.name || '', arguments: item.arguments || '{}' },
          });
          break;
        }
        case 'function_call_output': {
          flushPending();
          // 工具结果里可能带图（Codex Desktop 截图工具即 output=[{type:'input_image', image_url:'data:image/png;base64,...'}]）。
          // 绝不能 JSON.stringify 成文本送上游：base64 会按文本分词，真机实测单张 2.76MB 截图 ≈ 1.92M token，
          // 直接撞穿模型 1M 窗口（"maximum context length is 1048576 tokens ... 1922800 in the messages"）。
          // 官方 CLI 的排布是：tool-result 只放文本，图片提出来放进紧跟其后的一条 user 消息
          // （见 command-code@1.66.0 dist/cli.mjs 的 convertUserMessage / tool_result 分支）。
          const { text, images } = splitToolOutput(item.output);
          messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: text });
          if (images.length) {
            log('info', 'Deferred tool-output images (batched after tool results)', {
              call_id: item.call_id, count: images.length, bytes: images.reduce((a, u) => a + u.length, 0),
            });
            // 不立即 push：并行 tool_call 的图片统一累积，由 flushToolImages() 放到所有
            // tool_result 之后。content 走 image_url 形态，交给 buildCcRequest 的 user 图片分支转换。
            pendingToolImages.push(
              ...images.map(url => ({ type: 'image_url', image_url: { url }, _toolImage: true })),
            );
          }
          break;
        }
        default: {
          log('warn', 'Unknown Responses input item type', { type: item.type });
          break;
        }
      }
    }
  }
  flushPending();
  flushToolImages();

  // 统一裁剪工具截图（此时所有 item 都已转成 chat 形态，按顺序处理最直观）
  trimToolImages(messages);

  let tools;
  if (Array.isArray(respReq.tools) && respReq.tools.length) {
    tools = respReq.tools.filter(t => t && (t.type === 'function' || t.name)).map(t => ({
      type: 'function',
      function: {
        name: t.name || '',
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }));
    if (!tools.length) tools = undefined;
  }

  let toolChoice;
  const tc = respReq.tool_choice;
  if (typeof tc === 'string') toolChoice = tc;
  else if (tc && typeof tc === 'object' && tc.name) toolChoice = { type: 'function', function: { name: tc.name } };

  const out = { model: respReq.model, messages, stream: respReq.stream === true };
  if (tools) out.tools = tools;
  if (toolChoice) out.tool_choice = toolChoice;
  if (respReq.max_output_tokens !== undefined) out.max_tokens = respReq.max_output_tokens;
  if (respReq.temperature !== undefined) out.temperature = respReq.temperature;
  if (respReq.top_p !== undefined) out.top_p = respReq.top_p;
  if (respReq.parallel_tool_calls !== undefined) out.parallel_tool_calls = respReq.parallel_tool_calls;
  const eff = respReq.reasoning && typeof respReq.reasoning === 'object' ? respReq.reasoning.effort : undefined;
  if (eff) out.reasoning_effort = eff;
  return out;
}

// Responses 的 input_tokens 是总数，cached / cache_write 均为其子集 ——
// 与 Anthropic 相反（那里 cache_read 是独立增量，必须做减法，见 issue #25）。
// 本代理上游 CC 的 inputTokens 同样已含缓存，故此处直接沿用、不做减法。
// 实测：total_tokens === input_tokens + output_tokens（即使 cached 占绝大多数）。
function buildResponsesUsage(usage, fallbackOutputTokens) {
  const u = usage || {};
  normalizeUsage(u);
  const inTok = u.inputTokens || 0;
  const outTok = u.outputTokens || fallbackOutputTokens || 0;
  return {
    input_tokens: inTok,
    // 规范里 cached_tokens 与 cache_write_tokens 都是 required
    input_tokens_details: {
      cached_tokens: u.cachedInputTokens || 0,
      cache_write_tokens: (u.inputTokenDetails && u.inputTokenDetails.cacheWriteTokens) || 0,
    },
    output_tokens: outTok,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inTok + outTok,
  };
}

function buildResponsesOutput(fullText, thinkingText, toolCalls) {
  const output = [];
  if (thinkingText) {
    output.push({ type: 'reasoning', id: newResponsesId('rs_'), summary: [{ type: 'summary_text', text: thinkingText }] });
  }
  if (fullText) {
    output.push({
      type: 'message', id: newResponsesId('msg_'), status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: fullText, annotations: [] }],
    });
  }
  for (const tc of (toolCalls || [])) {
    const rawArgs = tc.function ? tc.function.arguments : '{}';
    output.push({
      type: 'function_call', id: newResponsesId('fc_'), call_id: tc.id,
      name: tc.function ? (tc.function.name || '') : '',
      arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {}),
      status: 'completed',
    });
  }
  return output;
}

function buildResponsesObject(responseId, model, created, fullText, thinkingText, toolCalls, usage, opts) {
  const o = opts || {};
  const truncated = o.finishReason === 'length';
  const paused = o.finishReason === 'pause_turn';
  // Responses 的 incomplete_details.reason 只有 max_output_tokens / content_filter
  // 两个合法值。上游的 refusal（内容拦截）属于后者：报成 completed 是把「被拦截」
  // 谎报成「答完了」，报 max_output_tokens 又会误导下游去压缩上下文。
  const filtered = o.finishReason === 'refusal';
  return {
    id: responseId,
    object: 'response',
    created_at: created,
    status: (truncated || paused || filtered) ? 'incomplete' : 'completed',
    completed_at: nowUnix(),
    error: null,
    incomplete_details: truncated ? { reason: 'max_output_tokens' }
      : filtered ? { reason: 'content_filter' }
      : paused ? { reason: 'pause_turn' } : null,
    input: o.input || [],
    instructions: o.instructions === undefined ? null : o.instructions,
    max_output_tokens: o.max_output_tokens === undefined ? null : o.max_output_tokens,
    model,
    output: buildResponsesOutput(fullText, thinkingText, toolCalls),
    output_text: fullText || '',
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: o.reasoning || null,
    store: false,
    temperature: o.temperature === undefined ? 1 : o.temperature,
    text: { format: { type: 'text' } },
    tool_choice: o.tool_choice || 'auto',
    tools: o.tools || [],
    top_p: o.top_p === undefined ? 1 : o.top_p,
    truncation: 'disabled',
    usage: buildResponsesUsage(usage, 0),
    user: null,
    metadata: {},
  };
}

function sendResponsesError(res, status, type, message, retryAfter) {
  const body = { error: { message, type, code: null, param: null } };
  if (retryAfter !== undefined) body.retry_after = retryAfter;
  sendJSON(res, status, body);
}

// CC NDJSON → Responses 具名 SSE 事件（每个事件都必需的 sequence_number 递增发送）
function createResponsesSseTranslator(model, responseId, created) {
  let seq = 0;
  const sse = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type, sequence_number: seq++ }, data)) + '\n\n';
  let createdSent = false;
  let current = null;
  let outputIndex = 0;
  const doneItems = [];
  let usage = null;
  let textAcc = '';
  let finishReason = null;
  // 是否见过完成信号（见 incompleteUpstreamDetail 的口径说明）
  let sawFinish = false;

  const baseResponse = (status, output) => ({
    id: responseId, object: 'response', created_at: created, status,
    output: output || [], output_text: '', model, error: null, incomplete_details: null,
    parallel_tool_calls: true, previous_response_id: null, store: false, tools: [], metadata: {},
  });

  function startResponse() {
    createdSent = true;
    return [
      sse('response.created', { response: baseResponse('in_progress') }),
      sse('response.in_progress', { response: baseResponse('in_progress') }),
    ];
  }

  function closeItem() {
    if (!current) return [];
    const out = [];
    const item = current.item;
    const idx = current.index;
    if (current.kind === 'message') {
      out.push(sse('response.output_text.done', { item_id: item.id, output_index: idx, content_index: 0, text: current.textBuf, logprobs: [] }));
      out.push(sse('response.content_part.done', {
        item_id: item.id, output_index: idx, content_index: 0,
        part: { type: 'output_text', text: current.textBuf, annotations: [] },
      }));
      item.content = [{ type: 'output_text', text: current.textBuf, annotations: [] }];
      item.status = 'completed';
    } else if (current.kind === 'function_call') {
      out.push(sse('response.function_call_arguments.done', { item_id: item.id, output_index: idx, arguments: item.arguments }));
      item.status = 'completed';
    } else if (current.kind === 'reasoning') {
      out.push(sse('response.reasoning_summary_text.done', { item_id: item.id, output_index: idx, summary_index: 0, text: current.textBuf }));
      out.push(sse('response.reasoning_summary_part.done', {
        item_id: item.id, output_index: idx, summary_index: 0,
        part: { type: 'summary_text', text: current.textBuf },
      }));
      item.summary = [{ type: 'summary_text', text: current.textBuf }];
      item.status = 'completed';
    }
    out.push(sse('response.output_item.done', { output_index: idx, item }));
    doneItems.push(item);
    current = null;
    return out;
  }

  function openItem(kind, item) {
    const out = closeItem();
    current = { kind, index: outputIndex++, item, textBuf: '' };
    out.push(sse('response.output_item.added', { output_index: current.index, item }));
    if (kind === 'message') {
      out.push(sse('response.content_part.added', {
        item_id: item.id, output_index: current.index, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }));
    } else if (kind === 'reasoning') {
      out.push(sse('response.reasoning_summary_part.added', {
        item_id: item.id, output_index: current.index, summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }));
    }
    return out;
  }

  return {
    lastCcEvent: '',
    upstreamError: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    // 提前发 created/in_progress（不带内容）：上游是 reasoning 模型，大 prompt 首字可能要十几秒，
    // 这期间一个字节都不出网就会被中间层（实测 EdgeOne 源站 ~15s）或客户端首字节超时掐掉
    start: startResponse,
    get started() { return createdSent; },
    // 是否真的产出过 output item（开过 item 或收尾过 item 都算）。
    // #54 之后 created/in_progress 在收到 200 时就先行发出，started 恒为 true，
    // 零输出防护不能再拿它当判据 —— 只能看「有没有实际内容」。
    get hasOutput() { return outputIndex > 0 || doneItems.length > 0; },
    get stopReason() { return finishReason; },
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;
      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;
      const out = [];

      switch (event.type) {
        case 'text-start': case 'reasoning-start': case 'start': case 'start-step':
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          if (!createdSent) out.push.apply(out, startResponse());
          if (!current || current.kind !== 'message') {
            out.push.apply(out, openItem('message', { type: 'message', id: newResponsesId('msg_'), status: 'in_progress', role: 'assistant', content: [] }));
          }
          current.textBuf += text;
          textAcc += text;
          out.push(sse('response.output_text.delta', { item_id: current.item.id, output_index: current.index, content_index: 0, delta: text, logprobs: [] }));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          if (!createdSent) out.push.apply(out, startResponse());
          if (!current || current.kind !== 'reasoning') {
            out.push.apply(out, openItem('reasoning', { type: 'reasoning', id: newResponsesId('rs_'), summary: [], status: 'in_progress' }));
          }
          current.textBuf += text;
          out.push(sse('response.reasoning_summary_text.delta', {
            item_id: current.item.id, output_index: current.index, summary_index: 0, delta: text,
          }));
          break;
        }

        case 'tool-call': {
          if (!createdSent) out.push.apply(out, startResponse());
          const callId = event.toolCallId || newResponsesId('call_');
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          out.push.apply(out, openItem('function_call', {
            type: 'function_call', id: newResponsesId('fc_'), call_id: callId,
            name: event.toolName || '', arguments: '', status: 'in_progress',
          }));
          current.item.arguments = args;
          out.push(sse('response.function_call_arguments.delta', { item_id: current.item.id, output_index: current.index, delta: args }));
          break;
        }

        case 'finish': {
          sawFinish = true;
          // 必须归一化：截断类不止 'length'（还有 max_output_tokens /
          // model_context_window_exceeded），原来直接比对原始值会漏判成 completed。
          finishReason = event.finishReason ? mapFinishReason(event.finishReason) : null;
          const u = event.totalUsage || event.usage || null;
          if (u) {
            normalizeUsage(u);
            usage = u;
            this.inputTokens = u.inputTokens || 0;
            this.outputTokens = u.outputTokens || 0;
            this.cachedInputTokens = u.cachedInputTokens || 0;
          }
          break;
        }

        case 'error': {
          this.upstreamError = mapCcEventError(event);
          // 上游在 HTTP 200 之后于**流内**报错时，这里以前只赋值不打日志：客户端收到 400，
          // 而 journalctl 里一片安静（本次排障就是靠 nginx 的 body_bytes_sent=0 反推的）。
          // 对齐 /v1/chat/completions 路径的 CC stream error。
          log('warn', 'CC stream error', {
            path: '/v1/responses',
            message: event.error?.message || event.message || 'Unknown error',
            upstreamStatus: this.upstreamError.reportedStatus,
            code: this.upstreamError.code,
            mappedTo: this.upstreamError.status,
          });
          break;
        }

        default: break;
      }
      return out.length ? out : null;
    },
    finish() {
      if (!createdSent) return [];
      const out = closeItem();
      // 上游没有正常走完 finish —— 不能报 response.completed（那是把截断谎报成完整）。
      // 对齐 CLI：按可重试的 upstream_error 处理。
      const incomplete = incompleteUpstreamDetail(sawFinish, finishReason);
      if (incomplete) {
        log('warn', 'Upstream stream incomplete', { path: '/v1/responses', reason: incomplete });
        out.push(sse('response.failed', {
          response: Object.assign(baseResponse('failed'), {
            error: { code: 'upstream_error', message: incompleteUpstreamError(incomplete).body.error.message },
          }),
        }));
        return out;
      }
      // 'length' 表示被截断（max_output_tokens / model_context_window_exceeded 都归一到这里）；
      // 'pause_turn' 同样是「后面还有内容没发完」，规范要求 status=incomplete；
      // 'refusal'（上游 content_filter 一族）同样是「没答完」，且必须如实说明是被拦截。
      const truncated = finishReason === 'length';
      const paused = finishReason === 'pause_turn';
      const filtered = finishReason === 'refusal';
      const notDone = truncated || paused || filtered;
      out.push(sse(notDone ? 'response.incomplete' : 'response.completed', {
        response: Object.assign(baseResponse(notDone ? 'incomplete' : 'completed', doneItems.slice()), {
          output_text: textAcc,
          incomplete_details: truncated ? { reason: 'max_output_tokens' }
            : filtered ? { reason: 'content_filter' }
            : paused ? { reason: 'pause_turn' } : null,
          usage: buildResponsesUsage(usage, this.outputTokens),
        }),
      }));
      return out;
    },
    fail(message) {
      if (!createdSent) return [];
      return [sse('response.failed', {
        response: Object.assign(baseResponse('failed'), {
          error: { code: 'upstream_error', message: message || 'Upstream error' },
        }),
      })];
    },
    errorEvent(message) {
      return sse('error', { code: null, message: message || 'Upstream error', param: null });
    },
  };
}

async function handleResponses(req, res) {
  let respReq;
  try {
    respReq = await readBody(req);
  } catch (e) {
    if (e.statusCode === 413) { sendResponsesError(res, 413, 'invalid_request_error', e.message); return; }
    sendResponsesError(res, 400, 'invalid_request_error', 'Invalid JSON body');
    return;
  }

  if (respReq.previous_response_id) {
    sendResponsesError(res, 400, 'invalid_request_error',
      'previous_response_id is not supported (this proxy is stateless); send the full input each turn');
    return;
  }

  const auth = authenticate(req.headers);
  if (auth.error) {
    // 未启用访问保护时 auth.error 只会是 missing，保持原有的 400/401 提示不被改写
    if (auth.error === 'missing') {
      sendResponsesError(res, 401, 'authentication_error',
        'Missing API key. Send in Authorization: Bearer <key> or x-api-key header');
    } else {
      const status = auth.error === 'upstream_unconfigured' ? 500 : 401;
      sendResponsesError(res, status, 'authentication_error', AUTH_ERR_MSG[auth.error]);
    }
    return;
  }
  const apiKey = auth.upstreamKey;

  let chatReq = convertResponsesToChat(respReq);
  if (!chatReq.messages.length) {
    sendResponsesError(res, 400, 'invalid_request_error', 'input is required');
    return;
  }

  const trackUsage = attachUsageRecording(res, apiKey);
  const stream = chatReq.stream === true;
  const model = chatReq.model || fallbackModel('deepseek/deepseek-v4-flash', '/chat/completions');
  const disabledErr = disabledModelError(chatReq.model);
  if (disabledErr) {
    sendResponsesError(res, 400, 'invalid_request_error', disabledErr);
    return;
  }
  const responseId = newResponsesId('resp_');
  const created = nowUnix();
  const echoOpts = {
    instructions: respReq.instructions === undefined ? null : respReq.instructions,
    max_output_tokens: respReq.max_output_tokens === undefined ? null : respReq.max_output_tokens,
    temperature: respReq.temperature,
    top_p: respReq.top_p,
    reasoning: respReq.reasoning || null,
    tool_choice: typeof respReq.tool_choice === 'string' ? respReq.tool_choice : 'auto',
    tools: respReq.tools || [],
  };
  // 同上：兜底模型要写回，否则省略 model 时发出去的仍是写死的 id
  chatReq.model = model;
  const ccBody = buildCcRequest(chatReq);
  const promptCacheKey = chatReq.prompt_cache_key;
  // respReq 是 Codex/客户端送来的完整会话，比 chatReq 还大一份，及时释放避免内存驻留
  chatReq = null;
  respReq = null;

  const abortController = new AbortController();
  let aborted = false;
  const startTime = Date.now();
  let bytesReceived = 0;
  let lastCcEvent = '';
  let reader = null;
  let translator = null;

  // 连续超时的作用域：优先用客户端给的会话标识，没有就按内容派生（与 chat 路径同一口径）。
  const sessionKey = getSessionId(req.headers, apiKey, promptCacheKey, ccBody).id;

  res.on('close', () => {
    if (res.writableEnded) return;
    aborted = true;
    log('warn', 'Client disconnected', {
      path: '/v1/responses', model, responseId, elapsedMs: Date.now() - startTime,
      bytesSent: bytesReceived, lastCcEvent: lastCcEvent || '(none)',
    });
    if (!abortController.signal.aborted) { try { abortController.abort(); } catch (e2) {} }
  });

  try {
    await ensureInitialized(apiKey, abortController.signal);
    const { response: ccResponse } = await forwardWithKeyRetry(ccBody, apiKey, req.headers, abortController.signal, promptCacheKey);

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      const mapped = mapCcError(ccResponse.status, errorText);
      log('error', 'CC API error', { status: ccResponse.status, path: '/v1/responses', code: mapped.code, body: summarizeUpstreamError(errorText) });
      sendResponsesError(res, mapped.status, mapped.body.error.type, mapped.body.error.message, mapped.body.retry_after);
      return;
    }

    if (stream) {
      translator = createResponsesSseTranslator(model, responseId, created);
      let buffer = '';
      let started = false;
      const decoder = new TextDecoder();
      reader = ccResponse.body.getReader();
      const idle = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS);
      const SSE_HEADERS = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      };
      const writeEvents = async (evts) => {
        if (!started) { res.writeHead(200, SSE_HEADERS); started = true; }
        for (const e2 of evts) res.write(e2);
        await waitDrain(res);
      };

      // 上游已 200：立刻把响应头 + response.created / response.in_progress 推下去。
      // 不能等首个内容事件 —— Codex 实测 reasoning_effort=max + 大 prompt，首字要 15s+，
      // 这段时间此前**零字节出网**，于是 nginx access.log 全是 `499 0`（body_bytes_sent=0）、
      // 中间 CDN（EdgeOne）按源站超时掐掉连接、客户端只能每 15 秒重试一次。
      // created 是不带内容的协议首事件，先发符合 Responses 语义；上游随后失败会走 response.failed。
      await writeEvents(translator.start());

      // SSE 保活：对齐 /v1/messages 的心跳思路，但这里发**注释行**。
      // Responses 协议没有 ping 事件，塞未知 event 类型有被严格解析器判错的风险；
      // 注释行（以 ':' 开头）按 SSE 规范必须被忽略 —— chat 端点在静默事件时也是这么发的。
      // 为什么必须发：首字前的静默期实测 15~40s，中间层的"源站空闲"超时（EdgeOne 实测约 15s）
      // 会把连接掐掉 —— 现象是客户端 ~16s 断连、代理侧 Client disconnected、nginx 只记到很少字节。
      const heartbeat = setInterval(() => {
        // 回调是同步的，无法 await waitDrain，所以用 writableNeedDrain 直接跳过（背压时少一条注释无副作用）
        if (aborted || !started || res.writableEnded || res.writableNeedDrain) return;
        try { res.write(': keepalive\n\n'); } catch (e2) {}
      }, 5000);

      try {
        while (true) {
          const result = await Promise.race([reader.read(), idle.arm()]);
          const done = result.done;
          const value = result.value;
          if (done) break;
          if (aborted || res.destroyed) break;
          bytesReceived += value.length;

          const chunkText = decoder.decode(value, { stream: true });
          buffer += chunkText;
          let lines = [];
          if (chunkText.indexOf('\n') !== -1) {
            lines = buffer.split('\n');
            buffer = lines.pop() || '';
          }

          for (const line of lines) {
            const evts = translator.parseLine(line);
            if (evts) await writeEvents(evts);
            if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
          }
        }

        if (!aborted) {
          if (buffer.trim()) {
            const evts = translator.parseLine(buffer);
            if (evts) await writeEvents(evts);
          }
          if (translator.upstreamError) {
            if (!started) {
              sendResponsesError(res, translator.upstreamError.status,
                translator.upstreamError.body.error.type, translator.upstreamError.body.error.message,
                translator.upstreamError.body.retry_after);
              return;
            }
            const failed = translator.fail(translator.upstreamError.body.error.message);
            if (failed.length) await writeEvents(failed);
          } else if (translator.outputTokens === 0 && !translator.hasOutput) {
            try { if (!abortController.signal.aborted) abortController.abort(); } catch (e2) {}
            if (!started) {
              sendResponsesError(res, 429, 'rate_limit_error',
                'Empty response from upstream (zero output tokens)', 10);
              return;
            }
            // created 已随 200 先行发出，响应头按 200 提交后状态码改不回 429 ——
            // 这里再调 sendResponsesError 会抛 ERR_HTTP_HEADERS_SENT（issue #56）。
            // 按本文件既有失败口径走 response.failed：空响应绝不能经 finish() 包装成
            // response.completed 谎报成功（与 #38/#39 修掉的静默截断同类）。
            const failed = translator.fail('Empty response from upstream (zero output tokens)');
            if (failed.length) await writeEvents(failed);
            // 就地收尾：下面的 return 会跳过流式分支尾部的 res.end()，
            // 漏掉这条客户端会挂在永不结束的 SSE 上。
            if (!res.writableEnded) res.end();
            return;
          } else {
            if (!started) { res.writeHead(200, SSE_HEADERS); started = true; }
            for (const e2 of translator.finish()) res.write(e2);
          }
          clearTimeouts(sessionKey);
        }
      } catch (e) {
        if (aborted) {
          try { reader.cancel().catch(() => {}); } catch (e2) {}
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/responses', model, streaming: true, timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime, bytesReceived, lastCcEvent: lastCcEvent || '(none)',
          });
          const timeoutMsg = timeoutMessage(sessionKey);
          if (!started) { sendResponsesError(res, 429, 'rate_limit_error', timeoutMsg, 5); return; }
          if (!res.writableEnded) {
            // end() 而不是 destroy()：理由见 handleChatCompletions 流式超时分支
            try { res.end(translator.errorEvent(timeoutMsg)); } catch (e2) {}
          }
        } else {
          log('error', 'Stream error', { message: e.message, path: '/v1/responses' });
          try { abortController.abort(); } catch (e2) {}
          if (!started) {
            sendResponsesError(res, 502, 'proxy_error', 'Upstream error: ' + e.message, 10);
            return;
          }
          if (!res.writableEnded) {
            try { res.write(translator.errorEvent(e.message)); } catch (e2) {}
          }
        }
      } finally {
        clearInterval(heartbeat);
        idle.dispose();
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式：缓冲完整 NDJSON 后一次性构造 Responses 对象 ──
      let fullText = '';
      let thinkingText = '';
      let usage = null;
      let finishReason = 'stop';
      let sawFinish = false;
      let upstreamError = null;
      const toolCalls = [];
      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
          let event;
          try { event = JSON.parse(trimmed); } catch (e2) { continue; }
          switch (event.type) {
            case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
            case 'reasoning-delta': lastCcEvent = event.type; thinkingText += event.text || ''; break;
            case 'tool-call': {
              lastCcEvent = event.type;
              toolCalls.push({
                id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                type: 'function',
                function: {
                  name: event.toolName || '',
                  arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                },
              });
              break;
            }
            case 'finish-step':
            case 'finish':
              lastCcEvent = event.type;
              sawFinish = true;
              finishReason = mapFinishReason(event.finishReason || 'stop');
              if (event.totalUsage || event.usage) { usage = event.totalUsage || event.usage; trackUsage(usage); }
              break;
            case 'error':
              lastCcEvent = event.type;
              upstreamError = mapCcEventError(event);
              log('warn', 'CC stream error (non-stream)', {
                message: event.error ? event.error.message : event.message,
                upstreamStatus: upstreamError.reportedStatus,
                upstreamRetryable: event.error?.isRetryable,
                code: upstreamError.code,
                mappedTo: upstreamError.status,
              });
              break;
            // 无内容的事件：与流式翻译器以及另两条非流式路径保持一致。
            // 这条路径原先**没有静默列表**，于是上游每个响应都会发的一串无内容事件
            //（text-start / text-end / start / start-step / reasoning-start / reasoning-end /
            //  provider-metadata / tool-input-* / tool-error）全部掉进 default 打成
            // 'Unknown CC event type'，线上刷屏、把真正的错误淹掉。
            case 'text-start': case 'text-end': case 'start': case 'start-step':
            case 'reasoning-start': case 'reasoning-end':
            case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end':
            case 'cache-write-tokens': case 'server_tool_result': case 'tool-result':
            case 'tool-error':
              // Silent - no user-visible content
              break;
            default:
              log('warn', 'Unknown CC event type', { type: event.type });
              break;
          }
        }
      };

      const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);
      while (true) {
        const result = await Promise.race([reader.read(), idle.arm()]);
        const done = result.done;
        const value = result.value;
        if (done) break;
        bytesReceived += value.length;
        const chunkText = decoder.decode(value, { stream: true });
        buf += chunkText;
        if (chunkText.indexOf('\n') !== -1) processLines();
      }
      idle.dispose();
      processLines();

      if (upstreamError) {
        sendResponsesError(res, upstreamError.status, upstreamError.body.error.type,
          upstreamError.body.error.message, upstreamError.body.retry_after);
        return;
      }

      // 上游没有正常走完 finish —— 对齐 CLI 按可重试 502 处理，不谎报成功
      {
        const incomplete = incompleteUpstreamDetail(sawFinish, finishReason);
        if (incomplete) {
          log('warn', 'Upstream stream incomplete', { path: '/v1/responses', reason: incomplete });
          const err = incompleteUpstreamError(incomplete);
          try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
          sendResponsesError(res, err.status, err.body.error.type, err.body.error.message, err.retry_after);
          return;
        }
      }

      if (!fullText && !thinkingText && !toolCalls.length) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch (e2) {}
        sendResponsesError(res, 429, 'rate_limit_error',
          'Empty response from upstream (zero output tokens)', 10);
        return;
      }

      clearTimeouts(sessionKey);
      echoOpts.finishReason = finishReason;
      trackUsage(usage);
      sendJSON(res, 200, buildResponsesObject(
        responseId, model, created, fullText, thinkingText, toolCalls, usage, echoOpts));
    }
  } catch (e) {
    if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return;
    log('error', 'Responses handler error', { message: e.message });
    if (!res.headersSent) {
      sendResponsesError(res, 502, 'proxy_error', 'Upstream error: ' + e.message, 10);
    } else if (!res.writableEnded) {
      try { res.write(translator ? translator.errorEvent(e.message) : ''); } catch (e2) {}
      try { res.end(); } catch (e2) {}
    }
  }
}

async function handleModels(req, res) {
  const auth = authenticate(req.headers);
  // 保护未启用时，模型列表仍对无凭证请求开放（保持原有行为）
  if (auth.error && CFG.proxyKey) {
    sendAuthError(res, auth.error);
    return;
  }
  // 拉目录需要一个上游 Key：优先用本次鉴权得到的，否则从池里取一个
  const keyForCatalog = auth.upstreamKey || keyPool.pick()?.key || null;
  const models = await fetchModels(keyForCatalog);
  const now = nowUnix();
  // 被禁用的模型不出现在这里：下游客户端就发现不到它，自然不会去用
  const visible = modelState.filterEnabled(models);
  sendJSON(res, 200, {
    object: 'list',
    data: visible.map(m => ({
      id: m.id,
      object: 'model',
      created: now,
      owned_by: 'command-code',
    })),
  });
}

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}

// ── 后台 API 装配 ────────────────────────────────────
// 依赖在这里显式注入，lib/ 之间因此没有循环 import —— 装配点只有这一处。
const adminApi = createAdminApi({
  auth: adminAuth,
  pool: keyPool,
  apiKeys: apiKeyPool,
  catalog,
  modelState,
  runner: modelTestRunner,
  logBus,
  log: (...args) => log(...args),
  probe: probeModel,
  // 测试消息的默认值与上限：由这里注入，后台只要读取即可（避免默认值写两份）
  testMessage: { default: DEFAULT_TEST_MESSAGE, maxLen: MAX_TEST_MESSAGE_LEN },
  startedAt: SERVER_STARTED_AT,
  reloadUpstreamProxy: refreshUpstreamProxy,
  getInflight: () => inflightCount,
  get address() { return `http://${CFG.host}:${CFG.port}`; },
});

// ── 服务器 ──────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS（仅数据面）。后台接口在 adminApi 内部显式摘掉这些头：
  // 后台用 Cookie 鉴权，带 ACAO:* 只会白白扩大可被跨站页面驱动的面。
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);

  // 后台请求先分流：它既不该占用数据面的在途配额，也不该受 MAX_INFLIGHT 影响。
  // SSE 日志流是长连接，若按数据面计数会永久占住一个槽位。
  if (adminApi.isAdminPath(url.pathname)) {
    try {
      if (adminApi.isApiPath(url.pathname)) {
        await adminApi.handle(req, res, url);
      } else {
        // /admin、/admin/、/admin/login 与前端静态资源
        adminApi.serveAsset(req, res, url.pathname);
      }
    } catch (e) {
      log('error', '后台请求处理异常', { path: url.pathname, error: e.message });
      if (!res.headersSent) sendJSON(res, 500, { error: { message: e.message, type: 'internal_error' } });
    }
    return;
  }

  // 在途上限准入。/health 与 / 例外：探活与编排器不该因业务繁忙而收 503。
  const isLiveness = url.pathname === '/health' || url.pathname === '/';
  if (!isLiveness && MAX_INFLIGHT > 0) {
    if (inflightCount >= MAX_INFLIGHT) {
      log('warn', 'In-flight limit reached, rejecting request', {
        maxInflight: MAX_INFLIGHT, inflight: inflightCount, path: url.pathname,
      });
      sendJSON(res, 503, {
        error: { message: `Too many concurrent requests (limit ${MAX_INFLIGHT}), retry shortly`, type: 'server_busy' },
        retry_after: 5,
      });
      return;
    }
    inflightCount++;
    // 释放时机：响应写完（finish）或连接终止（close）—— 取先到者，且幂等，
    // 保证任何退出路径（成功/出错/客户端断连/超时）都不会泄漏槽位。
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (inflightCount > 0) inflightCount--;
    };
    res.once('finish', release);
    res.once('close', release);
  }

  try {
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      await handleChatCompletions(req, res);
    } else if (url.pathname === '/v1/messages' && req.method === 'POST') {
      await handleMessages(req, res);
    } else if (url.pathname === '/v1/responses' && req.method === 'POST') {
      await handleResponses(req, res);
    } else if (url.pathname === '/v1/models' && req.method === 'GET') {
      await handleModels(req, res);
    } else if (url.pathname === '/health' || url.pathname === '/') {
      handleHealth(req, res);
    } else {
      sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    }
  } catch (e) {
    sendJSON(res, 500, { error: { message: e.message, type: 'internal_error' } });
  }
});

// 全局兜底：abort 触发的异步 rejection 不会让进程崩溃
process.on('unhandledRejection', (reason) => {
  if (reason?.name === 'AbortError' || reason?.code === 'ABORT_ERR') {
    // 客户端断连触发的 abort — 预期行为，静默处理
    log('info', 'Aborted request cleaned up');
  } else if (isRetryableUpstreamError(reason)) {
    // 上游传输层闪断造成的异步 rejection（如 socket terminated），已被重试机制或上层吸收
    log('info', 'Upstream socket terminated asynchronously (handled)');
  } else {
    log('error', 'Unhandled rejection', { message: reason?.message || String(reason), stack: reason?.stack?.split('\n')[0] });
  }
});

// ── keep-alive 时序（放在反向代理后面时是必调项） ──────────────
// 反代（nginx/OpenResty）的 upstream keepalive_timeout 必须**小于**这里的值，
// 否则反代会复用一条后端已经关掉的连接：它把请求体写过去，后端早已 FIN，
// 写这一侧就是 EPIPE —— nginx 侧表现为
//   sendfile() failed (32: Broken pipe) while sending request to upstream
// 而这条请求是 POST（非幂等），nginx 默认不会重试 → 客户端直接吃 502。
//
// Node 默认 keepAliveTimeout=5s。反代若用常见的 4s，余量只有 1 秒；一旦反代的
// 空闲判定基准与后端差一点（大响应体读完的时刻 vs 后端写完的时刻），就会踩上。
// 这里显式抬到 65s，让「谁先关」不再取决于一两秒的抖动 —— 与 Node 官方在
// 反向代理后部署的建议一致（keepAliveTimeout > 前端 idle timeout）。
// 反代侧仍建议设 keepalive_timeout 60s 以内。
const KEEPALIVE_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_KEEPALIVE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 65000;
})();
server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
server.headersTimeout = KEEPALIVE_TIMEOUT_MS + 1000;   // Node 要求 headersTimeout > keepAliveTimeout

server.listen(CFG.port, CFG.host, () => {
  const keyState = keyPool.countByState();
  log('info', 'CC Proxy started', {
    url: `http://${CFG.host}:${CFG.port}`,
    admin: `http://${CFG.host}:${CFG.port}/admin/`,
    api: CFG.apiBase,
    keys: `上游 ${keyState.total} 个（启用 ${keyState.enabled}）· 2API ${apiKeyPool.size} 个`,
    strategy: CFG.strategy,
    models: MODELS.length,
    session: 'content-derived x-session-id',
    zdr: CFG.zdr ? 'enabled (x-cmd-zdr: 1 on generation/init requests)' : 'off (CMD_ZDR=1 or per-request x-cmd-zdr: 1 to enable)',
    emptySystemPlaceholder: CFG.emptySystemPlaceholder ? 'on (space placeholder for requests without system prompt, issue #17)' : 'off',
    webSearch: CFG.webSearch ? `on (Anthropic web_search_20250305 served via ${WEB_SEARCH_ROUTE}, timeout ${WEB_SEARCH_TIMEOUT_MS}ms)` : 'off (Anthropic server tools stripped; CC_WEB_SEARCH=1 to enable)',
    logFile: CFG.logFile || '(console only)',
    logLevel: CFG.logLevel,
    clientDrainTimeout: CLIENT_DRAIN_TIMEOUT_MS > 0 ? `${CLIENT_DRAIN_TIMEOUT_MS}ms` : 'disabled',
    keepAliveTimeout: `${KEEPALIVE_TIMEOUT_MS}ms (反代侧 keepalive_timeout 必须小于它)`,
    idleTimeouts: `stream ${STREAM_IDLE_TIMEOUT_MS}ms / nonstream ${NONSTREAM_IDLE_TIMEOUT_MS}ms`,
    maxInflight: MAX_INFLIGHT > 0 ? `${MAX_INFLIGHT} (global, /health 与 /admin/* 豁免)` : 'unlimited (CC_MAX_INFLIGHT=0)',
    upstreamProxy: redactProxyUrl(UPSTREAM_PROXY),
    dataDir: DATA_DIR,
    // 明确说出 .env 有没有被读到、读了哪些键（值不打印，里面有密码）。
    // 容器里必然是「未找到」—— Docker 下 .env 由 compose 在宿主侧读取后作为真实环境变量注入，
    // 文件本身不在容器内，这里点明以免被误解成配置没生效。
    dotenv: DOTENV.found
      ? `已加载（${DOTENV.keys.length} 项：${DOTENV.keys.join(', ')}）`
      : '本项目目录未找到 .env（Docker 下由 compose 注入环境变量，属正常）',
    upstreamRetry: UPSTREAM_RETRY_MAX > 0
      ? `${UPSTREAM_RETRY_MAX} retries, base ${UPSTREAM_RETRY_BASE_MS}ms (only before first byte)`
      : 'disabled (CC_UPSTREAM_RETRY_MAX=0)',
    fingerprint: `derived from API key (salt: ${CFG.fingerprintSalt ? 'set' : 'unset'})`,
  });
  if (CLIENT_DRAIN_TIMEOUT_MS > 0) {
    log('info', 'Client drain timeout enabled', { timeoutMs: CLIENT_DRAIN_TIMEOUT_MS });
  }
  // 内存提示：body 上限隐含的最坏内存 = 上限 × 实测放大系数（见 MAX_BODY_SIZE 注释 / issue #20）
  const bodyCapMB = Math.round(MAX_BODY_SIZE / 1048576);
  const worstCaseMB = Math.round(bodyCapMB * 5.5);
  if (worstCaseMB >= 500) {
    log('warn', 'Request body limit implies high per-request worst-case memory', {
      maxBodyMB: bodyCapMB,
      worstCaseRSSPerRequestMB: worstCaseMB,
      hint: 'lower CC_MAX_BODY_MB, set CC_MAX_INFLIGHT, and/or cap in-flight requests at the reverse proxy (see README)',
    });
  }

  // 把两套 Key 的分工在启动横幅里说清楚 —— 这是最容易搞混的地方
  const clientEnabled = apiKeyPool.countEnabled();
  const clientTotal = apiKeyPool.size;
  const strictMode = clientTotal > 0 || !!CFG.proxyKey;

  if (strictMode) {
    log('info', '访问保护已启用（2API Key 归下游，上游 Key 归服务端）', {
      客户端凭证: clientTotal > 0
        ? `2API Key：${clientEnabled} 个启用 / ${clientTotal} 个已签发（在 /admin/ 的「2API Key」页管理）`
        : 'proxyKey：单口令（旧配置兼容）',
      上游凭证: `上游 Key：${keyState.enabled} 个启用，按 ${CFG.strategy} 轮询`,
      单请求最多换: Math.min(Math.max(keyState.enabled, 1), MAX_KEY_ATTEMPTS) + ' 个上游 Key',
    });
    if (keyState.enabled === 0) {
      log('warn', '上游 Key 池为空：所有 API 请求都会返回 500，请到 /admin/ 的「上游 Key」页添加 Command Code Key（user_ 开头）');
    }
    if (clientTotal > 0 && clientEnabled === 0) {
      log('warn', '所有 2API Key 都被禁用：所有客户端请求都会返回 401（不会因此退回免鉴权模式）');
    }
  } else {
    log('warn', '访问保护未启用：任何能访问到本端口的人都可以借这套代理调用（用他自己的上游 Key）。要限制访问，请在 /admin/ 的「2API Key」页签发一个 Key。');
  }

  // 后台可用性提示：未设密码时后台整体拒绝访问（不是「无密码可进」）
  if (!adminAuth.isConfigured()) {
    log('warn', '后台未设置管理密码，/admin/ 拒绝访问。请设置 ADMIN_PASSWORD 环境变量，或在后台首次初始化后于 data/.admin-auth.json 中保存密码。');
  } else {
    log('info', '后台管理面板可用', { url: `http://${CFG.host}:${CFG.port}/admin/`, passwordSource: adminAuth.source() });
  }

  // 启动即预热模型目录：后台「模型」页打开时就有数据，不必等用户点刷新
  const warmKey = keyPool.pick()?.key || null;
  if (warmKey) {
    catalog.sync({ apiKey: warmKey }).catch(() => {});
  }

  // 手工编辑 config.json 也能热生效（轮询 mtime，不依赖 fs.watch 的跨平台可靠性）
  startConfigWatcher({
    onReload: (cfg) => {
      refreshUpstreamProxy();
      log('info', 'config.json 已变更并热加载', {
        strategy: cfg.strategy, logLevel: cfg.logLevel, upstreamProxy: redactProxyUrl(cfg.upstreamProxy || ''),
      });
    },
    onError: (e) => log('warn', 'config.json 热加载失败', { error: e.message }),
  });
});

// ── 退出前把防抖中的用量计数落盘 ──────────────────────
// 用量是每 5 秒才落一次盘，进程被 SIGTERM 时最后一次改动还在内存里。
function flushAndExit(signal) {
  log('info', `收到 ${signal}，正在落盘 Key 池用量后退出`);
  try { keyPool.flushSync(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => flushAndExit('SIGTERM'));
process.on('SIGINT', () => flushAndExit('SIGINT'));
