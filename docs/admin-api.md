# 管理后台 API 契约

本文件是**前后端唯一接口约定**。后端按此实现，前端 `web/` 按此调用。
任何一方改动本文件中的字段名/状态码，必须同步另一方。

- 所有后台接口前缀：`/admin/api`
- 请求/响应体：`application/json; charset=utf-8`（SSE 除外）
- 认证：Cookie `admin_session`（`HttpOnly; SameSite=Lax; Path=/`）。
  未登录访问受保护接口 → **401**，并返回下面「错误信封」的 `auth_error` 形式。
  前端收到 401 必须跳回登录视图。

## 两套 Key（务必分清）

本项目有**两套完全不同的 Key**，接口路径也刻意分开，不要混用：

| | 上游 Key | 2API Key |
|---|---|---|
| 是什么 | Command Code 账号 Key（`user_` 开头）| 本项目自己签发的 Key（`ccp_` 开头）|
| 谁用 | **服务端自己**：代理拿它去调用 Command Code | **下游客户端**：别人拿它来调用本代理 |
| 能给别人吗 | 绝不 —— 等于把账号送人 | 可以，本来就是发出去的 |
| 管理路径 | `/admin/api/keys*` | `/admin/api/apikeys*` |
| 存储 | `data/keys.json` | `data/api-keys.json` |
| 后台页面 | 🔑 上游 Key | 🔐 2API Key |
| 来源 | `ui` / `config` / `env` 三种 | 只能在后台签发 |

一次请求的链路：

```
下游客户端 --(2API Key)--> 本代理 --(按策略挑一个上游 Key)--> Command Code
```

**为什么要分开**：上游 Key 泄露只能整个换号；2API Key 可以按客户端逐个签发，
某个客户端泄露只吊销它自己。混用会让「谁能调用」和「用谁的账号」纠缠不清。

**访问保护何时启用**：只要**签发过任何 2API Key**（不论是否启用）或设置了 `proxyKey`，
就要求客户端提供凭证。两者都没有时是**透传模式** —— 客户端带自己的上游 Key。

> ⚠️ 判据是「签发过」而不是「启用中」：否则把最后一个 Key 禁用就会静默退回透传模式，
> 等于关掉访问控制 —— 这个方向太危险，宁可失败也不放行。

## 统一响应信封

成功：

```json
{ "success": true, "data": { }, "message": "可选提示" }
```

失败：

```json
{ "success": false, "error": "人类可读的中文错误", "retry_after": 30 }
```

- `data` / `error` / `message` 按需出现；`success` **始终存在**。
- `retry_after`（秒）仅在限速时出现。
- 未登录时（401）固定为：
  ```json
  { "error": { "message": "未登录或登录已过期，请先登录", "type": "auth_error" } }
  ```

## 认证

### `POST /admin/api/login` （公开）
请求：`{ "password": "..." }`
- 200 `{ "success": true }` + `Set-Cookie: admin_session=...`
- 401 `{ "success": false, "error": "密码错误" }`
- 400 `{ "success": false, "error": "invalid request" }`（body 非法）
- 429 `{ "success": false, "error": "尝试过于频繁，请稍后再试", "retry_after": <秒> }`
- 503 `{ "success": false, "error": "后台未设置管理密码..." }`（未配置密码时）

### `POST /admin/api/logout` （公开）
200 `{ "success": true }`，并清除 Cookie。幂等。

### `GET /admin/api/session` （保护）
```json
{ "success": true, "data": {
  "authenticated": true,
  "passwordConfigured": true,
  "passwordSource": "file" | "env" | "none"
} }
```

### `POST /admin/api/password` （保护）
请求：`{ "current": "...", "new": "..." }`
- 200 `{ "success": true, "message": "密码已更新" }`（并使其它会话失效）
- 400 `{ "success": false, "error": "新密码至少 8 位" }`
- 401 `{ "success": false, "error": "当前密码错误" }`

## 总览

### `GET /admin/api/stats` （保护）
```json
{ "success": true, "data": {
  "version": "1.1.0",
  "uptimeSec": 1234,
  "strategy": "round_robin",
  "keys":    { "total": 3, "enabled": 3, "cooldown": 0, "unhealthy": 0 },
  "models":  { "total": 82, "lastSyncAt": "2026-09-28T06:00:00.000Z", "syncing": false },
  "requests":{ "today": 120, "total": 8300, "failedToday": 2, "inflight": 1 },
  "tokens":  { "inToday": 1, "inTotal": 1, "outToday": 1, "outTotal": 1,
               "cacheReadToday": 1, "cacheReadTotal": 1,
               "cacheWriteToday": 1, "cacheWriteTotal": 1,
               "cacheMissToday": 1, "cacheMissTotal": 1,
               "cacheHitRateToday": 0.85, "cacheHitRateTotal": 0.85 },
  "admin":   { "address": "http://0.0.0.0:3050", "dataDir": "/app/data" }
} }
```

## 2API Key（下游客户端凭证）

列表项：

```json
{
  "id": "ak_1759000000000_ab12",
  "label": "给朋友",
  "keyMasked": "ccp_1a0e78…901b",
  "enabled": true,
  "createdAt": "2026-09-28T09:00:00.000Z",
  "lastUsedAt": "2026-09-28T09:10:00.000Z",
  "requests": 42
}
```

| 接口 | 方法 | 说明 |
|---|---|---|
| `/admin/api/apikeys` | GET | `{success,data:{keys,counts:{total,enabled},proxyKeySet,protectionEnabled}}` |
| `/admin/api/apikeys` | POST | 签发。请求 `{label?, key?}`；`key` 留空则自动生成 |
| `/admin/api/apikeys/update` | POST | `{id,label?,enabled?}` |
| `/admin/api/apikeys/delete` | POST | `{id}` |
| `/admin/api/apikeys/reveal` | POST | `{id}` → `{success,data:{key:"ccp_..."}}` |

**创建响应会把明文放在 `data.plainKey`**（`data.key` 是不含明文的列表项）：
明文只在创建这一次返回，列表始终脱敏，之后要看只能走 `reveal`。
`data.generated` 表示是否为系统自动生成。

校验：自定义 `key` 必须以 `ccp_` 开头，否则 400
（错误信息会明确指向「上游 user_ Key 请到上游 Key 页添加」）；长度不足 12 → 400；
重复 → 400 `该 2API Key 已存在`。

**禁用后立即失效**，且不会因此退回免鉴权（仍返回 401）。删除同理。
把 2API Key **全部删光**才是「关闭访问保护」的正规做法（回到透传模式）。

客户端提交凭证的方式（与数据面一致）：`Authorization: Bearer <ccp_...>` 或 `x-api-key: <ccp_...>`。
若客户端误把上游 `user_` Key 当成本代理的凭证提交，会返回 401 并明确提示应使用 2API Key。

## 上游 Key 管理

Key 列表项（下称 `KeyItem`）：

```json
{
  "id": "k_1759000000000_ab12",
  "label": "主号",
  "keyMasked": "user_ab…12cd",
  "source": "ui" | "config" | "env",
  "enabled": true,
  "createdAt": "2026-09-28T06:00:00.000Z",
  "lastUsedAt": "2026-09-28T06:10:00.000Z",
  "cooldownUntil": null,
  "lastError": null,
  "usage": {
    "requestsToday": 12, "requestsTotal": 340,
    "failedToday": 0, "failedTotal": 3,
    "tokensInToday": 100, "tokensInTotal": 2000,
    "tokensOutToday": 50,  "tokensOutTotal": 900
  },
  "health": {
    "status": "unknown" | "ok" | "unauthorized" | "quota" | "not_in_plan" | "network" | "error",
    "checkedAt": "2026-09-28T06:12:00.000Z",
    "latencyMs": 812,
    "message": "链路正常"
  }
}
```

- `source`：`ui` = 后台添加（可删可改）；`config` = 来自 `config.json` 的 `apiKey`；`env` = 来自 `CC_API_KEY`。后两者**只读**，删除/禁用会被拒绝（400，error 说明原因），可通过「导入」转成 `ui`。
- `keyMasked` 永远脱敏。完整 Key 只能通过 `reveal` 接口单条获取。

| 接口 | 方法 | 说明 |
|---|---|---|
| `/admin/api/keys` | GET | `{success,data:{strategy,keys:[KeyItem...]}}` |
| `/admin/api/keys` | POST | 新增。请求 `{key,label?}` |
| `/admin/api/keys/update` | POST | `{id,label?,enabled?}` |
| `/admin/api/keys/delete` | POST | `{id}` |
| `/admin/api/keys/reveal` | POST | `{id}` → `{success,data:{key:"user_..."}}` |
| `/admin/api/keys/test` | POST | `{id}` 或 `{key}`，可选 `message` → 真实最小请求探测 |
| `/admin/api/keys/import` | POST | 把 `config`/`env` 来源的 Key 导入为 `ui` 来源。传 `{id}` 只导入该条；不传 body 则导入全部 |

**测试消息（`message`）**：`/keys/test`、`/models/test`、`/models/test-batch` 共用同一条提示词。

- 省略、`null`、或纯空白 → 使用后端默认值 **`你是谁，出来干活了`**（与参考项目一致）。
  默认值**只在后端定义一处**，前端通过 `GET /admin/api/config` 的 `defaultTestMessage` 取值预填。
- 非字符串 → 400 `测试消息必须是字符串`；超过 4000 字符 → 400 `测试消息过长（上限 4000 字符）`。
- 响应中的 `prompt` 回显**实际发送**的内容，便于确认「到底发出去的是什么」。

新增/测试请求体校验：Key 必须是 `user_` 开头的非空字符串（含空格→400 `Key 格式不正确`）；重复 Key → 400 `该 Key 已存在`。

`keys/test` 响应：

```json
{ "success": true, "data": {
  "ok": true, "category": "ok", "latencyMs": 812,
  "message": "链路正常", "model": "deepseek/deepseek-v4-flash",
  "httpStatus": 200, "keyId": "k_...", "checkedAt": "...",
  "prompt": "你是谁，出来干活了" } }
```

`category` 枚举（同时用于 `health.status`）：

| category | 含义 |
|---|---|
| `ok` | 正常 |
| `unauthorized` | Key 无效 / 失效（上游 `UNAUTHORIZED`） |
| `quota` | 额度用尽（`USAGE_EXCEEDED`） |
| `not_in_plan` | 该模型不在套餐内（`MODEL_NOT_IN_PLAN`） |
| `network` | 连接失败 / 超时 |
| `error` | 其它上游错误 |

> 注意：`not_in_plan` 是**模型维度**的结论，不代表 Key 失效。前端在 Key 测试里遇到它应提示「Key 有效，但该模型不在套餐内」。## 模型

模型目录来自 Command Code 上游 `GET /provider/v1/models`（缓存，默认 5 分钟）。

```json
{ "success": true, "data": {
  "models": [
    { "id": "claude-sonnet-5", "name": "Claude Sonnet 5",
      "contextLength": 1000000, "supportedEndpoints": ["/messages"],
      "source": "upstream", "enabled": true }
  ],
  "counts": { "total": 82, "enabled": 80, "disabled": 2 },
  "staleDisabled": ["old-model-id"],
  "lastSyncAt": "2026-09-28T06:00:00.000Z",
  "nextSyncInSec": 240,
  "syncing": false,
  "fromUpstream": true,
  "lastError": null,
  "defaultModel": "claude-sonnet-5"
} }
```

- `enabled`：该模型当前是否可用。**默认启用**：禁用状态存成稀疏集合（只记被禁用的 id），
  所以上游新增的模型默认就是可用的，不需要为每个新模型补记录。
- `counts`：`{total, enabled, disabled}`，供列表页显示。
- `staleDisabled`：禁用记录里那些**已不在上游目录**的 id（仅提示，不自动清理 ——
  上游若重新提供该模型，禁用状态仍然生效）。
- `defaultModel`：若配置的默认模型被禁用或不在目录里，会自动退到**第一个启用**的模型。

- `fromUpstream`：`false` 表示当前列表是**静态回退**（没有可用 Key、或上游拉取失败），
  `source` 会是 `"static"`；`true` 表示来自上游真实目录。后台应据此明确提示用户。
- `lastError`：上次同步失败的原因；`null` 表示上次成功。
- `lastSyncAt`：**成功**同步的时间；从未成功过时为 `null`（不会用回退时间冒充成功）。

| 接口 | 方法 | 说明 |
|---|---|---|
| `/admin/api/models` | GET | 目录 |
| `/admin/api/models/refresh` | POST | 立即重新拉取（同步上游模型），返回 `{count, added, removed, counts, fromUpstream}` |
| `/admin/api/models/enable` | POST | `{ids:[id]}` 或 `{all:true}` 启用 |
| `/admin/api/models/disable` | POST | `{ids:[id]}` 或 `{all:true}` 禁用 |
| `/admin/api/models/test` | POST | `{model,keyId?,message?}` 单模型测试 |
| `/admin/api/models/test-batch` | POST | `{models?:[id],keyId?,message?,concurrency?}` 启动批量测试 → `{success,data:{jobId,total,prompt}}`。未指定 `models` 时**只测启用的模型** |

**启用/禁用语义**（两处都生效，否则禁用就只是摆设）：

| 位置 | 行为 |
|------|------|
| `GET /v1/models`（数据面）| 被禁用的模型**不再返回** |
| `POST /v1/chat/completions` / `/v1/messages` / `/v1/responses` | 指名调用被禁用的模型 → **400** `模型 X 已在后台被禁用…` |
| 目录里没有的模型 | **照旧透传**（目录可能过期，不能因此把本来能用的请求拦下来） |

响应的 `data`：`{changed, requested, counts, defaultModel}`。`message` 会说明实际改了几个；
若禁用的正是当前默认模型，会另外提示「默认模型已禁用，将自动改用 X」。

校验：`ids` 与 `all` 都没有 → 400 `需要提供 ids 数组或 all: true`；`ids` 为空数组 → 400；
全部 id 都不在目录中 → 400 `指定的模型都不在目录中`（只接受目录里存在的 id，
避免前端拼错在禁用集合里留下垃圾）。重复禁用/启用不报错，`changed` 为空。
| `/admin/api/models/test-status` | GET | 批量进度与结果 |
| `/admin/api/models/test-cancel` | POST | 取消批量测试 |

单模型测试响应 `data`：

```json
{ "model": "claude-sonnet-5", "ok": true, "category": "ok",
  "latencyMs": 1200, "httpStatus": 200, "message": "链路正常",
  "keyId": "k_...", "checkedAt": "...",
  "prompt": "你是谁，出来干活了",
  "outputPreview": "我是你的 AI 助手，随叫随到。…" }
```

批量状态 `data`：

```json
{ "running": true, "jobId": "j_...", "startedAt": "...", "finishedAt": null,
  "total": 82, "done": 12,
  "results": [ { "model": "...", "ok": true, "category": "ok", "latencyMs": 900,
                 "message": "链路正常", "keyId": "k_...", "checkedAt": "..." } ],
  "summary": { "ok": 10, "unauthorized": 0, "quota": 0, "not_in_plan": 2,
               "network": 0, "error": 0 } }
```

## 用量

### `GET /admin/api/usage` （保护）
```json
{ "success": true, "data": {
  "items": [ { "keyId": "k_...", "label": "主号", "keyMasked": "user_ab…12cd",
               "source": "ui", "enabled": true,
               "requestsToday": 12, "requestsTotal": 340,
               "failedToday": 0, "failedTotal": 3,
               "successToday": 12, "successTotal": 337,
               "tokensInToday": 100, "tokensInTotal": 2000,
               "cacheReadToday": 85, "cacheReadTotal": 1700,
               "cacheWriteToday": 5,  "cacheWriteTotal": 100,
               "cacheMissToday": 10,  "cacheMissTotal": 200,
               "cacheHitRateToday": 0.85, "cacheHitRateTotal": 0.85,
               "tokensOutToday": 50,  "tokensOutTotal": 900,
               "lastUsedAt": "..." } ],
  "summary": { "requestsToday": 12, "requestsTotal": 340,
               "failedToday": 0, "failedTotal": 3,
               "inToday": 100, "inTotal": 2000,
               "cacheReadToday": 85, "cacheReadTotal": 1700,
               "cacheWriteToday": 5, "cacheWriteTotal": 100,
               "cacheMissToday": 10, "cacheMissTotal": 200,
               "cacheHitRateToday": 0.85, "cacheHitRateTotal": 0.85,
               "outToday": 50,  "outTotal": 900 }
} }
```

**输入 token 按缓存分三桶**（上游本来就分开给，只是要显式采集）：

| 字段 | 含义 |
|------|------|
| `cacheRead*` | **缓存命中 / 缓存读取**（最便宜，最能反映前缀缓存有没有生效）|
| `cacheWrite*` | 写入缓存（首次建立缓存，计费口径通常又不同）|
| `cacheMiss*` | 既未命中也没写入（真正的"新"输入）|

不变量：**`cacheRead + cacheWrite + cacheMiss === tokensIn`**（`tokensIn*` 是输入总数，含缓存部分）。
上游没给明细时全部归入 `cacheMiss` —— 宁可算作未命中，也不凭空造出命中。

字段来源（实测 Command Code）：`inputTokenDetails.cacheReadTokens` / `cacheWriteTokens` / `noCacheTokens`，
顶层 `cachedInputTokens` 是 `cacheReadTokens` 的同义字段（老版本可能只给这个）。

`cacheHitRate*` = `cacheRead / tokensIn`，保留 4 位小数，便于一眼看出缓存效果。

### `POST /admin/api/usage/reset` （保护）
请求：`{ "keyId": "k_...", "scope": "today" | "all" }`
200 `{ "success": true, "message": "今日用量已重置" | "全部用量已重置" }`

## 设置

### `GET /admin/api/config` （保护）
```json
{ "success": true, "data": {
  "port": 3050, "host": "0.0.0.0", "apiBase": "https://api.commandcode.ai",
  "projectSlug": "cc-proxy", "proxyKeySet": true,
  "zdr": false, "logLevel": "info", "logFile": "",
  "useProviderModels": true, "modelRefreshIntervalMs": 300000,
  "upstreamProxy": "", "strategy": "round_robin", "defaultModel": "deepseek/deepseek-v4-flash",
  "dataDir": "/app/data", "configPath": "/app/config.json",
  "settingsPath": "/app/data/settings.json",
  "version": "1.1.0",
  "envLocked": ["logLevel"],
  "settingSources": { "strategy": "settings", "logLevel": "env", "port": "config" },
  "defaultTestMessage": "你是谁，出来干活了",
  "maxTestMessageLen": 4000
} }
```

- `defaultTestMessage` / `maxTestMessageLen`：探测用提示词的默认值与长度上限。
  前端**必须**用它预填「测试消息」输入框 —— 默认值只在后端定义一处，两边各写一遍迟早会不一致。

- `settingSources`：每个字段的值当前取自哪一层 —— `default` | `config`（`config.json`）|
  `settings`（后台写入的 `data/settings.json`）| `env`（环境变量）。后台可据此标注来源。
- `envLocked`：被环境变量锁定的字段。这些字段**后台改不动**（不落盘也不改内存），
  提交时会在 `message` 中明确列出。
- `settingsPath`：后台改动的落盘位置。

### `POST /admin/api/config/update` （保护）
请求（全部字段可选，只更新传入的）：
```json
{ "strategy": "round_robin" | "random" | "fill",
  "defaultModel": "deepseek/deepseek-v4-flash",
  "zdr": false,
  "upstreamProxy": "http://127.0.0.1:7890",
  "logLevel": "info", "logFile": "",
  "apiBase": "https://api.commandcode.ai",
  "projectSlug": "cc-proxy",
  "proxyKey": "新口令" }
```
- 200 `{ "success": true, "data": { ...更新后的同 GET 结构... }, "message": "..." }`
- 400：`strategy` 非法 → `策略非法，必须是 round_robin / random / fill`；
  `defaultModel` 不在目录中 → `未知模型: <id>`；
  `upstreamProxy` 非法 → `上游代理地址无效（仅支持 http://host:port）`。

**落盘位置**：改动写入 `data/settings.json`，**不修改 `config.json`**。
`config.json` 是部署期输入（Docker 里通常以只读单文件挂载），保持原样。

**配置分层优先级**：`环境变量` > `data/settings.json`（后台写入）> `config.json` > 内置默认值。
只写被改动的字段（稀疏覆盖），因此后台没碰过的字段仍然听 `config.json` 的。

`message` 会说明落盘结果与需要注意的情况，例如：
`已保存到 data/settings.json；以下字段在 config.json 中也有配置，后台设置（data/settings.json）优先：strategy`、
`以下字段由环境变量锁定，后台修改不会生效：logLevel`、
`端口/监听地址改动需重启进程后生效`。

## 日志

### `GET /admin/api/logs?limit=200&level=info` （保护）
```json
{ "success": true, "data": { "logs": [
  { "time": "2026-09-28T06:00:00.000Z", "level": "info",
    "msg": "CC Proxy started", "data": { "port": 3050 } }
] } }
```
最新在前，服务端最多保留 500 条。

### `GET /admin/api/logs/stream` （保护）
`text/event-stream`，事件名 `log`，data 为单条日志 JSON（同上结构）。
支持 `?level=debug|info|warn|error` 在**服务端**过滤（前端过滤只是省流量的补充手段）。
连接建立时先补发最近 50 条。前端应支持断线自动重连（`EventSource` 原生行为即可）。
带心跳注释行 `: ping`（每 20s），避免中间层掐断空闲连接。

## 前端页面要求

参考项目 Cline-proxy@20260926 的视觉与交互（深色玻璃拟态、左侧 236px 侧边栏、
顶部 toast、原生 `confirm()` 确认）。配色 token 见 `/tmp/ccp-specs/admin-ui-spec.md` §3，
需保持一致：`--bg:#0b0e17`、`--accent:#22d3ee`、`--accent2:#34d399`、
`--danger:#f87171`、`--amber:#f59e0b`、`--radius:14px`。

导航项（侧边栏图标 + 中文标题）：

| 图标 | 标题 | 内容 |
|---|---|---|
| 📊 | 仪表盘 | 统计卡片 + 快捷操作 + 上游连通性测试 |
| 🔑 | Key 管理 | Key 列表（增/改/删/启停/揭示/测试/导入）+ 轮询策略 |
| 🧠 | 模型 | 模型目录（含 contextLength、支持的端点）+ 单测/批量测试 + 进度 |
| 📈 | 用量 | 每 Key 用量表 + 汇总 + 重置 |
| 📜 | 请求日志 | 实时日志（SSE，自动重连，可暂停、可清屏、可按级别过滤） |
| ⚙️ | 设置 | 运行配置 + 修改后台密码 |

侧边栏底部：`⏻ 退出登录`（`confirm('确定退出登录吗？')`）+ 显示 API 地址。

交互约定：
- 所有删除操作使用原生 `confirm()`，文案为 `确定删除该 Key 吗？` / `确定重置用量吗？`。
- 成功/失败统一用右上角 toast：成功绿、失败红，默认 3.5s。
- 长任务按钮进入 loading 态并禁用，防重复提交。
- 401 统一跳回登录视图。
- Key 列表默认脱敏，点击 👁 才调 `reveal` 获取完整值，5 秒后自动重新脱敏。
