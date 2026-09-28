# Command Code Proxy

> [English Docs](README.md)

将 Command Code API 转换为 OpenAI / Anthropic 兼容接口的反代代理。单文件，零外部依赖。

逐条对齐官方 npm 包源码（`command-code@1.53.1`；`dist/cli.mjs` 只是压缩、**没有混淆**）。上游 npm 走到更高版本时代理只打**漂移告警**，不会静默改版本号（见[反检测](#反检测)）。

**完整功能**：OpenAI Chat Completions / **Responses API（`/v1/responses`）** + Anthropic Messages API | 流式/非流式输出 | 工具调用 (tool_use) | 多模态图片输入 | 推理强度 (reasoning_effort) | 动态模型列表 | 缓存命中指标 | 设备指纹伪装（per-key 绑定、自动刷新）| `x-api-key` 鉴权（Anthropic SDK）| 客户端断连检测（上游中止）| 零输出 → 429 自动重试 | 连续超时 → 429 自动重试 | 隐私保护日志

**社区**: [Linux.do](https://linux.do) — 一个友好的中文技术社区。

## 快速开始

```bash
cp config.json.example config.json   # 首次：复制配置模板再按需修改
ADMIN_PASSWORD=你的管理密码 npm start   # 启动（默认监听 http://0.0.0.0:3050）
# 然后打开 http://127.0.0.1:3050/admin/ 在网页里添加 Command Code Key
```

> 模板里 `proxyKey` 与 `apiKey` 都是**空值**（= 功能未启用），且模板不含任何占位口令 ——
> 照抄一份不会莫名其妙进入严格鉴权模式，更不会把公开已知的字符串当密码用。
> 三种给 Key 的方式任选：
> 1. **网页后台**（推荐）：`/admin/` 添加，写入 `data/keys.json`，改完立即生效；
> 2. `config.json` 的 `apiKey`（字符串或数组）；
> 3. 环境变量 `CC_API_KEY`（多个用英文逗号分隔）。
>
> 后两种会以**只读**条目出现在后台，可在后台一键「导入」为可管理条目。

未启用数据面访问保护（`proxyKey` 为空）时，API Key 由客户端通过 `Authorization` 请求头
（Anthropic SDK 可用 `x-api-key`）传入，**无需写入配置文件**。Key 必须以 `user_` 开头
（自动匹配任意前缀，如 `Bearer token_user_xxx`）：

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

> 监听 `0.0.0.0` 时这意味着**任何能访问到的人都可以借这套代理调用**（用他自己的 Key）。
> 想只允许持口令的人使用，就设置 `proxyKey`，见[访问保护](#访问保护)。

## 文件结构

```
commandcode/
├── proxy.mjs             # 入口 + 数据面（转发管线，已针对流式/超时/背压调优）
├── lib/                  # 服务端模块（零运行时依赖）
│   ├── config.mjs        # 配置加载 / 热加载 / 原子写回
│   ├── store.mjs         # 原子持久化（临时文件 + rename）
│   ├── keys.mjs          # Key 池：轮询策略、冷却、用量、健康
│   ├── models.mjs        # 模型目录（上游拉取 + 缓存 + 静态回退）+ 测试任务
│   ├── admin-auth.mjs    # 后台密码（scrypt）、会话、登录限速
│   ├── admin-api.mjs     # 后台 REST API + SSE 实时日志
│   ├── admin-ui.mjs      # 后台静态资源托管
│   └── logbus.mjs        # 日志环形缓冲 + 订阅
├── web/                  # 后台前端（Vite + Vue 3）
│   ├── src/              # 源码
│   └── dist/             # 构建产物（由 npm run build:web 或 Docker 构建生成，不入库）
├── data/                 # 运行时数据（**不入库**）：Key 池、后台密码、模型测试结论
├── docs/
│   ├── admin-api.md      # 后台 API 契约（前后端唯一接口）
│   └── design-notes.md   # 设计约定（不要求 TLS、零运行时依赖、状态放 data/ 等）
├── test/                 # 测试（node:test，无需测试框架依赖）
├── config.json.example   # 配置模板（复制为 config.json 后修改）
├── Dockerfile            # 两阶段构建：先构建前端，再产出运行镜像
├── docker-compose.yml    # 容器编排（默认使用 GHCR 预构建镜像）
├── docker-compose.local.yml   # 本地源码构建编排
├── .github/workflows/docker-publish.yml  # master/main/release 或 v* tag → GHCR 多架构
├── LICENSE               # MIT License
├── README.md             # 英文文档
└── README_zh.md          # 本文档（中文）
```

> `data/` 目录含**上游 Key 明文**（`keys.json`）与**后台密码哈希**（`.admin-auth.json`），
> 已被 `.gitignore` 与 `.dockerignore` 双重排除，绝不会进版本库或镜像。

## 配置

### config.json

从模板复制后修改：`cp config.json.example config.json`。该文件已被 `.gitignore` 排除，不会误提交。

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | `3000` | 监听端口（模板 `config.json.example` 中使用 `3050`） |
| `host` | `0.0.0.0` | 监听地址 |
| `apiBase` | `https://api.commandcode.ai` | CC API 地址 |
| `projectSlug` | `cc-proxy` | `x-project-slug` header |
| `proxyKey` | `""` | 数据面访问口令。**非空即启用严格鉴权**：客户端只认它，上游凭证从 Key 池按策略选取（详见「访问保护」） |
| `apiKey` | `""` | 上游 CC API Key（`user_` 开头），**支持单个字符串或字符串数组**。历史字段：新部署建议改用后台 `/admin/` 管理（写入 `data/keys.json`）；此处配置的 Key 会以**只读**条目出现在后台 |
| `strategy` | `round_robin` | Key 轮询策略：`round_robin`（轮询）/ `random`（随机，避让连续重复）/ `fill`（压满第一个可用） |
| `defaultModel` | `""` | 默认模型（Key 测试与模型测试用它）；空则取目录首项 |
| `logFile` | `""` | 日志文件路径（空=仅控制台） |
| `logLevel` | `info` | 日志级别：`debug` / `info` / `warn` / `error`（**真实生效**，后台日志页也按此过滤）|
| `useProviderModels` | `true` | 从 Provider API 动态拉取模型列表 |
| `modelRefreshIntervalMs` | `300000` | 模型列表缓存刷新间隔（5min） |
| `zdr` | `false` | 请求 Command Code 使用 ZDR-only 路由 |
| `cliMode` | `agent` | 信封 `mode`。上游枚举：`agent` / `learning` / `custom-agent` / `custom-agent-create` / `title-gen` / `tool-desc` / `compact` / `vision` |
| `cliSessionMode` | `interactive` | lifecycle 元数据里的 `mode`（**另一个枚举**：`interactive` / `non-interactive`）|
| `fingerprintSalt` | `""` | 设备指纹的盐。**成批换设备身份**就用它（同一个 key 永远报同一台设备）|
| `deviceProjectDir` | `""` | 伪装的项目目录（空则用内置 `C:\Users\dev\projects\app`）；改了 = 所有账号换一台设备 |
| `emptySystemPlaceholder` | `true` | 无 system prompt 时发空格占位，阻止上游注入约 7.5K token 默认提示词（[#17](https://github.com/MAXeaglet/commandcode-proxy/issues/17)）|

> 📌 `config.json` 是**部署期输入**。后台（`/admin/`）改动的是 `data/settings.json`，
> 不会改写这个文件 —— 所以 Docker 里它可以安全地只读挂载。分层优先级见 [Web 管理后台](#web-管理后台)。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3000`（自带 config.json 为 `3050`）| 监听端口 → `port` |
| `HOST` | `0.0.0.0` | 监听地址 → `host` |
| `PROXY_KEY` | 空 | 数据面访问口令 → `proxyKey`；**非空即启用严格鉴权**，见[访问保护](#访问保护) |
| `CC_API_KEY` | 空 | 上游 CC API Key → `apiKey`，**多个用英文逗号分隔**（以只读条目进入 Key 池）|
| `ADMIN_PASSWORD` | 空 | **管理后台**访问密码（与 `proxyKey` 是两套独立凭证）。**未设置时 `/admin/` 整体拒绝访问**，见 [Web 管理后台](#web-管理后台) |
| `CC_DATA_DIR` | `<项目>/data` | 运行时数据目录（Key 池 / 后台密码 / 模型测试结论）。Docker 部署务必挂卷 |
| `CC_LOG_LEVEL` | `info` | 日志级别 → `logLevel` |
| `ADMIN_COOKIE_SECURE` | 空 | `1` 时给后台会话 Cookie 加 `Secure`（仅在 HTTPS 下开启，否则浏览器不回传 Cookie）|
| `CC_API_BASE` | `https://api.commandcode.ai` | 上游地址 → `apiBase` |
| `CC_UPSTREAM_PROXY` | 空 | 让**发往 CC 上游**的请求走 HTTP 代理（仅 `http://` CONNECT），见下文「上游代理」→ `upstreamProxy` |
| `PROJECT_SLUG` | `cc-proxy` | `x-project-slug` → `projectSlug` |
| `LOG_FILE` | 空 | 日志文件 → `logFile`（**同步写**，见[其它注意事项](#其它注意事项)）|
| `CC_USE_PROVIDER_MODELS` | `true` | 动态拉取模型列表 → `useProviderModels` |
| `CMD_ZDR` | 关 | `1` 开启 ZDR-only 路由 → `zdr` |
| `CC_CLI_MODE` | `agent` | 信封 `mode` → `cliMode` |
| `CC_CLI_SESSION_MODE` | `interactive` | lifecycle 元数据的 `mode` → `cliSessionMode` |
| `CC_FINGERPRINT_SALT` | 空 | 设备指纹盐 → `fingerprintSalt` |
| `CC_DEVICE_PROJECT_DIR` | 空 | 伪装的项目目录 → `deviceProjectDir` |
| `CC_EMPTY_SYSTEM_PLACEHOLDER` | `true` | 无 system prompt 时发空格占位；`false` 关掉 → `emptySystemPlaceholder` |
| `CC_MAX_BODY_MB` | `100` | 请求体上限（MB），超限返回 `413` |
| `CC_STREAM_IDLE_MS` | `30000` | 流式上游读空闲超时，见[上游空闲超时](#上游空闲超时) |
| `CC_NONSTREAM_IDLE_MS` | `90000` | 非流式上游读空闲超时（同上）|
| `CC_MAX_INFLIGHT` | `0`（不限）| 进程内在途请求上限，超限 `503`，见[在途上限](#在途请求上限可选) |
| `CC_CLIENT_DRAIN_TIMEOUT_MS` | 空（禁用）| 下游背压阻塞超过该毫秒数就断开该客户端，见[僵死连接](#僵死连接既不读也不断开) |
| `CC_KEEPALIVE_TIMEOUT_MS` | `65000` | 后端 keep-alive 时长（`headersTimeout` 自动 +1s）。**必须大于反代侧的 keepalive_timeout**，见 [keep-alive 时序](#nginx-反代建议) |

开启后，代理会在 Command Code 生成请求以及 fingerprint/lifecycle 初始化请求中附加
`x-cmd-zdr: 1`。npm 版本检查和代理自己的 `/provider/v1/models` 模型目录请求不会附加该
header。该开关只是请求 Command Code 使用 ZDR-only 路由，实际数据留存和上游可用性仍由上游服务决定。

**请求体上限**：独立于 `config.json` —— 超过 **100MB** 的请求会被拒绝并返回 `HTTP 413`（连接保持可排空，不会直接 reset）。可用 `CC_MAX_BODY_MB`（正整数，单位 MB）覆盖。

> ⚠️ **内存放大**：请求体在转发到上游前会存在多份副本，实测峰值 ≈ body 大小 × **5.1~7.4**（7MB→+52MB、20MB→+116MB；被 `413` 拒绝的请求只要 ×1.05）。因此默认 `CC_MAX_BODY_MB=100` 意味着**单个请求**最坏可吃 ~550MB，且该上限是每请求的、不是全局的。详见[内存与部署](#内存与部署)。

## 两套 Key：上游 Key 与 2API Key

这两套 Key **完全不同**，是接入时最容易搞混的地方，先说清楚：

| | 🔑 上游 Key | 🔐 2API Key |
|---|---|---|
| **是什么** | Command Code 账号 Key（`user_` 开头）| 本项目自己签发的 Key（`ccp_` 开头）|
| **谁用它** | **服务端自己**：代理拿它去调用 Command Code | **下游客户端**：别人拿它来调用本代理 |
| **能给别人吗** | <span>绝对不要</span> —— 等于把账号送人 | 可以，本来就是发出去的 |
| **在哪管理** | 后台「🔑 上游 Key」页 | 后台「🔐 2API Key」页 |
| **存储** | `data/keys.json` | `data/api-keys.json` |
| **来源** | 后台添加 / `config.json` 的 `apiKey` / `CC_API_KEY` | 只能在后台签发 |

一次请求的完整链路：

```
下游客户端 --(2API Key)--> 本代理 --(按策略挑一个上游 Key)--> Command Code
```

**为什么要分开**：上游 Key 一旦泄露只能整个换号；2API Key 可以按客户端逐个签发，
某个客户端泄露只吊销它自己，不影响别人。混用会让「谁能调用」和「用谁的账号」纠缠不清。

### 访问保护

三种状态：

| 状态 | 判据 | 客户端要带什么 | 上游用谁的 Key |
|---|---|---|---|
| **透传模式**（默认）| 没签发过 2API Key，也没设 `proxyKey` | 自己的上游 `user_` Key | 客户端的 |
| **2API Key**（推荐）| 签发过任意 2API Key | `ccp_...`（逐个签发/吊销）| 池里按策略挑，客户端拿不到 |
| **proxyKey**（旧配置）| `config.json` 里设了 `proxyKey` | 那个单口令 | 池里按策略挑 |

> ⚠️ 判据是「**签发过**」而不是「启用中」。否则把最后一个 2API Key 禁用就会静默退回透传模式 ——
> 等于关掉访问控制，这个方向太危险，所以宁可一律 401 也不放行。要关闭保护，把 2API Key **全部删光**。

**透传模式**下不做访问控制，客户端在 `Authorization: Bearer <user_...>` 里带自己的上游 Key。
⚠️ 监听 `0.0.0.0` 时这意味着**任何能访问到本端口的人都能借用这套代理**（用他自己的 Key）。

**想限制访问**，最省事的做法是在后台「🔐 2API Key」页点一下「🎲 生成并添加」——
签发后保护**立即生效，无需重启**：

```bash
# 客户端这样调用（ccp_ 开头的是 2API Key，不是上游 Key）
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer ccp_xxxxxxxx_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

> 下游面板（new-api / one-api 等）把「调用本代理的 Key」填成签发出来的 2API Key 即可，
> 上游 `user_` Key 始终留在本机、不外泄。

鉴权失败响应：

| 场景 | 状态码 | 消息 |
|------|--------|------|
| 未带凭证 | `401` | `Missing API key. Send in Authorization: Bearer <key> or x-api-key header` |
| 凭证错误 / 已禁用 | `401` | `Invalid API key` |
| **误把上游 Key 当客户端凭证** | `401` | `This proxy requires a 2API key issued in the admin panel…` |
| 上游 Key 池为空 | `500` | `Server upstream API key not configured` |

最后一条是特意加的：把上游 Key 发给了下游是最常见的误用，直接告诉他该用哪个，
比笼统回一句 `Invalid API key` 有用得多。

### 多 Key 轮询

`apiKey` 支持配置多个上游 Key（单个字符串或字符串数组），代理**随机选取**其中一个发送请求：

```json
{
  "proxyKey": "your-proxy-key",
  "apiKey": ["user_aaa", "user_bbb", "user_ccc"]
}
```

也可用环境变量注入，多个以英文逗号分隔：

```bash
CC_API_KEY=user_aaa,user_bbb,user_ccc npm start
```

**选择策略**：随机 + 避让连续重复 —— 不会连续两次选中同一个 Key。`MAX_CONSECUTIVE_SAME_KEY = 8` 为兜底上限（仅当避让不可行时才可能触及）。实测 3 个 Key 下分布偏离均匀值 < 0.5%。

**失败自动切换**：上游返回 `401/402/403/429/5xx` 时自动换下一个 Key 重试，单请求最多尝试 `min(Key 数量, 3)` 个；与请求本身相关的错误（如 `400`）不换 Key。

> 每个 Key 拥有**独立的 session 与设备指纹**（`sessionStore`/`keyStateStore` 均按 Key 隔离），多 Key 之间互不污染。代价是每个新 Key 首次使用时会触发一次 fingerprint/lifecycle 初始化请求。

### 安全提示

- `proxyKey` 是明文口令，比对采用定长比较（防时序侧信道）。与参考项目一致，本代理**不要求 TLS**：
  局域网内自用无需任何额外处理，直接 `http://` 访问即可；只有确实要暴露到公网时，才需要自行套一层 HTTPS。
- 日志不记录 `proxyKey` 与 `apiKey` 明文。
- 修改 `config.json` 会自动触发热重载（`dev` 脚本已用 `--watch-path` 显式监听该文件）；`npm start` 无热重载。

### 上游代理（`upstreamProxy` / `CC_UPSTREAM_PROXY`）

让代理**发往 Command Code 的请求**走本地 HTTP 代理 —— 用于出口地区调整，或排查风控 `403` 时做 IP 维度对照。

```json
{ "upstreamProxy": "http://127.0.0.1:7890" }
```

```bash
CC_UPSTREAM_PROXY=http://127.0.0.1:7890 npm start
```

- 作用于 `/alpha/generate`、`/alpha/fingerprint/record`、`/alpha/lifecycle-events` 与 `/provider/v1/models`。
- **不影响**本地监听、`/health` 与 npm 版本检查。
- 仅支持 `http://`（CONNECT）代理。实现方式是自建 CONNECT 隧道 + `node:https` 复用同一 socket，**不新增任何依赖**，Node 18+ 即可用。
- 每个上游请求各自建立一条隧道连接。TLS 为端到端：证书按**目标主机名**校验，绝不针对代理降级。
- **指纹/lifecycle 预请求也走代理**是刻意的：若它们直连而上游生成走代理，同一账号会从两个不同 IP 注册 —— 正是你想避免的那种矛盾。
- 代理地址里带账号密码（`http://user:pass@host:port`）时，日志只保留 `host:port`，**不打印口令**。

> Node 原生 `fetch` **不读** `HTTPS_PROXY`/`HTTP_PROXY`。官方环境变量路线需要 Node ≥ 22.21 / 24.5 且设 `NODE_USE_ENV_PROXY=1`；本选项两者都不需要。

## Web 管理后台

浏览器打开 `http://<主机>:<端口>/admin/` 即可管理 Key、模型与设置，**改动立即生效，无需重启**。

### 访问密码

后台默认**拒绝访问**，必须先设置密码：

```bash
ADMIN_PASSWORD=你的管理密码 npm start
# Docker：在 compose 同目录的 .env 中写 ADMIN_PASSWORD=...，compose 会自动读取
```

- 后台密码与数据面的 `proxyKey` 是**两套独立凭证**：前者给打开面板的人，后者给调用 `/v1/*` 的客户端。混用会让「面板登录」与「API 调用」互相牵制。
- 登录后可在「设置」页改密码：写入 `data/.admin-auth.json`（scrypt 哈希，权限 600），**优先级高于环境变量**，并立即踢掉其它已登录会话。
- 登录失败限速：同一来源 15 分钟内失败 5 次锁定 15 分钟（参考实现没有这一层，而后台常被暴露在 `0.0.0.0` 上）。
- 会话 Cookie：`admin_session`、`HttpOnly`、`SameSite=Lax`、24 小时不滑动续期，重启后需重新登录。

> 后台自身不提供 TLS，与参考项目一致 —— 局域网内自用无需额外处理。
> 若确实要暴露到公网，再套一层反向代理加 HTTPS（密码是明文提交的）。

### 功能

| 页面 | 内容 |
|------|------|
| 📊 仪表盘 | Key / 模型 / 请求 / Token 统计，上游连通性测试 |
| 🔐 **2API Key** | 签发给**下游客户端**的调用凭证：生成 / 逐个吊销 / 启停 / 揭示明文 / 请求计数；页面顶部直接说明「两套 Key 的区别」|
| 🔑 **上游 Key** | Command Code 账号凭证（`user_`）：增删改查、启停、👁 揭示明文、⚡ 真实探测、从 `config`/`env` 导入、切换轮询策略 |
| 🧠 模型 | 上游模型目录（含上下文长度与支持的端点）、单模型测试、批量测试（受限并发 + 可取消）|
| 📈 用量 | 按 Key 的请求数 / 失败数 / Token（今日与累计），可重置 |
| 📜 请求日志 | **SSE 实时推送**（非轮询），可暂停、清屏、按级别过滤 |
| ⚙️ 设置 | 运行配置热更新、修改后台密码 |

### 上游 Key 的三种来源

| 来源 | 存储 | 可否编辑 |
|------|------|----------|
| `ui` | `data/keys.json` | ✅ 后台随意增删改 |
| `config` | `config.json` 的 `apiKey` | ❌ 只读，可在后台「导入」为 `ui` |
| `env` | `CC_API_KEY` 环境变量 | ❌ 只读，同上 |

三者合并成**同一个轮询池**。同一串 Key 不会在两种来源里重复出现（`ui` 优先）。

**轮询策略**（后台可切换，或设置 `strategy`）：

- `round_robin`：按顺序依次使用（默认）
- `random`：随机挑选，并**避让连续重复**（纯随机会把一个号打穿；连续 8 次后不再避让以打破死锁）
- `fill`：优先压满第一个可用 Key，再切下一个

**失败切换与冷却**：上游返回 `401/402/403/429/5xx` 时自动换 Key 重试，单请求最多 `min(Key 数, 3)` 个。
被判定为 Key 相关失败的会进入冷却，后续请求自动避开：

| 失败性质 | 冷却时长 |
|---|---|
| 额度用尽（`USAGE_EXCEEDED`）| 10 分钟 |
| Key 失效（`UNAUTHORIZED`）| 30 分钟 |
| 网络异常 / 超时 | 5 分钟 |
| 其它上游错误 | 不冷却，只计数 |
| **模型不在套餐内**（`MODEL_NOT_IN_PLAN`）| **不冷却** —— 这是模型维度的结论，不该把 Key 罚下场 |

> 冷却是**我们自己的启发式**，不是上游的权威判定。因此当所有 Key 都在冷却时，代理不会拒绝服务，
> 而是退化为「按冷却结束时间最早」优先选择 —— 因为启发式而拒绝服务等于自造故障。

### 用量统计

「📈 用量」页按 **Key** 维度记账，Token 的**输入按缓存拆成三桶**：

| 指标 | 含义 |
|---|---|
| **输入 · 缓存命中**（缓存读取）| 前缀缓存命中的部分，最便宜；这个比例直接反映缓存有没有生效 |
| 输入 · 写缓存 | 首次建立缓存的部分（计费口径通常又与命中不同）|
| 输入 · 未命中 | 既未命中也没写入，真正的"新"输入 |
| 输出 | 模型生成的 token |

三桶之和**恒等于输入总数**（上游没给明细时全部算未命中 —— 宁可算作未命中，也不凭空造出命中）。
页面上直接给出**命中率**（命中 / 输入总数），仪表盘的 Token 卡片也会显示。

> 统计口径来自上游回报的用量，不是本地估算。`data/keys.json` 里同时记录「今日」与「累计」，
> 跨天自动清零「今日」。

### 模型目录与模型测试

模型列表来自 Command Code 上游 `GET /provider/v1/models`（默认 5 分钟缓存），
并保留上游给出的 `context_length` 与 `supported_endpoints`。
上游不可达时回退到内置静态列表，此时后台会明确显示为 `static` 来源（`fromUpstream: false`），
不会假装已同步。

**模型测试**用指定 Key 对指定模型发一次真实最小请求，按上游错误码归类：

| 分类 | 判据 | 含义 |
|---|---|---|
| `ok` | 正常返回 | 链路通 |
| `unauthorized` | `UNAUTHORIZED` | Key 无效 |
| `quota` | `USAGE_EXCEEDED` | 额度用尽 |
| `not_in_plan` | `MODEL_NOT_IN_PLAN` | **Key 有效，但该模型不在套餐内** |
| `network` | 连接失败 / 超时 | 网络问题 |
| `error` | 其它 | 上游错误 |

> 参考项目 Cline-proxy 的「付费模型验证」用的是**余额差值探测**（跑一次模型前后各查一次账户余额，
> 掉余额即收费模型）。这套机制在 Command Code 上**无法照搬**：实测 `/provider/v1/usage`、
> `/provider/v1/balance`、`/api/v1/users/me` 全部 404，CC 不暴露任何余额/用量接口。
> 因此改为上面的就地判定 —— 能不能跑通、因为什么跑不通，由上游错误码直接回答。

#### 模型管理

「模型」页顶部有 **🔄 同步上游模型**，点一下重新拉取目录并告诉你变化了多少
（`共 82 个模型，新增 2，移除 1`）。目录默认每 5 分钟自动同步一次。

**启用 / 禁用**支持三种粒度：

| 操作 | 位置 |
|------|------|
| 单条切换 | 每行的「已启用 / 已禁用」按钮 |
| 多选批量 | 勾选若干行 → **✅ 启用所选** / **🚫 禁用所选** |
| 全选批量 | 表头的全选框（支持半选态）→ 同上按钮 |

**禁用是真的禁用**，两处同时生效 —— 否则就只是个摆设：

| 位置 | 行为 |
|------|------|
| `GET /v1/models` | 被禁用的模型**不再返回**，下游客户端发现不到它 |
| 指名调用 | `/v1/chat/completions`、`/v1/messages`、`/v1/responses` 一律返回 **400** 并说明已被禁用 |
| 目录里没有的模型 | **照旧透传** —— 目录可能过期，不能因为「列表里没有」就把本来能用的请求拦下来 |

禁用状态落在 `data/models.json`，**存成稀疏集合**（只记被禁用的 id）：

- 上游新增模型默认就是**可用**的，不需要为每个新模型补一条记录；
- 上游临时少返回几个模型不会冲掉你的启用列表；
- 上游若重新提供某个曾被禁用的模型，禁用状态仍然生效（这是有意的，避免"悄悄恢复"）。

若禁用掉的正是当前默认模型，后台会提示并自动改用第一个启用的模型；
批量测试在未指定模型时也**只测启用的模型**。

> 已不在上游目录里的禁用记录会在页面上提示条数（`staleDisabled`），但不会自动清理 ——
> 自动清理会让"上游抖动一下"变成"禁用设置被清空"。

#### 测试消息

连通性测试、模型测试、Key 测试发的是**同一条提示词**，默认值与参考项目一致：

```
你是谁，出来干活了
```

- 输入框在「仪表盘 → 上游连通性测试」「模型」「Key 管理 → 轮询策略」三处都能改，
  三处共享同一个值（切页面不会丢），旁边有 `↺ 恢复默认`。
- 留空即回落默认值，不会发出一个空提示词。
- 上限 4000 字符；非字符串或超长会返回 400 并说明原因。
- 测试结果里会回显**实际发送的内容**（`prompt`），排查「到底发出去的是什么」时很有用。
- 默认值只在后端定义一处，前端通过 `GET /admin/api/config` 的 `defaultTestMessage` 预填 ——
  两边各写一遍迟早会不一致。

### 热加载

后台的所有改动都作用于**运行中的进程**，无需重启：

| 改动 | 生效方式 |
|------|----------|
| 增删改 Key、启停 | 下一个请求立即生效（`keys.json` 立即落盘）|
| 轮询策略 / 默认模型 / ZDR / 日志级别 | 立即生效，写入 `data/settings.json` |
| 上游 HTTP 代理 | 立即重建隧道（后续请求走新地址）|
| `proxyKey` | 立即生效 |
| 端口 / 监听地址 | **需重启**（后台会提示）|

设置改动写进 **`data/settings.json`**，而**不是** `config.json`。原因是 Docker 里
`config.json` 是**单文件挂载**（且是 `:ro`），而原子写用「临时文件 + rename」——
单文件挂载点上 `rename` 会直接 `EBUSY`，改动只会进内存、宿主文件纹丝不动，容器重建即丢失。
`data/` 是目录挂载，rename 正常，所以可变状态一律放那里（参考项目也是这个架构）。
`config.json` 因此可以安全地保持只读，它同时放着 `proxyKey` 等敏感字段。

**配置分层优先级**：`环境变量` > `data/settings.json`（后台写入）> `config.json` > 内置默认值。
后台只写**被改动的字段**（稀疏覆盖），没碰过的字段仍然听 `config.json` 的。
`GET /admin/api/config` 会返回每个字段的来源（`settingSources`），后台改动若与
`config.json` 冲突，保存时会明确提示是后台设置优先。

手工编辑 `config.json` 也会热加载（每 3 秒轮询 mtime，不依赖 `fs.watch` 的跨平台可靠性）。
被环境变量锁定的字段后台改不动（既不落盘也不改内存），提交时会明确列出是哪些字段。

### 数据文件

| 文件 | 内容 | 权限 |
|------|------|------|
| `data/keys.json` | **上游 Key**（Command Code 账号凭证，**明文**）| 600 |
| `data/api-keys.json` | **2API Key**（签发给下游客户端的凭证，**明文**）| 600 |
| `data/settings.json` | 后台改过的设置（稀疏覆盖）| 600 |
| `data/.admin-auth.json` | **后台密码**的 scrypt 哈希 | 600 |
| `data/models.json` | 被禁用的模型 id（稀疏集合）| 600 |
| `data/model-tests.json` | 最近一次批量模型测试结果 | 600 |

> 三个不同的「密码/Key」别搞混：`data/keys.json` 是**上游账号**凭证、
> `data/api-keys.json` 是**下游调用**凭证、`data/.admin-auth.json` 是**打开面板**的口令。

用 `CC_DATA_DIR` 可改目录。**Docker 部署必须把这个目录挂出来**，否则容器重建后后台配置全部丢失。

### 本地开发前端

前端是 Vite + Vue 3，源码在 `web/`：

```bash
npm run build:web     # 构建到 web/dist（后端直接托管）
npm run dev:web       # 带热更新的开发服务器
```

未构建时访问 `/admin/` 会得到一页明确的「前端尚未构建」提示（数据面接口不受影响）。
Docker 构建会自动完成前端构建，无需手工执行。

## API 接口

### `POST /v1/chat/completions`

OpenAI Chat Completions 兼容。支持流式和非流式、工具调用、多模态图片输入、推理强度。

**请求体参数：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `model` | 是 | 模型 ID（见模型列表） |
| `messages` | 是 | 对话消息，支持 `system/user/assistant/tool` 角色 |
| `max_tokens` | 否 | 最大生成 token（默认 64000） |
| `stream` | 否 | 是否 SSE 流式（默认 false） |
| `temperature` | 否 | 采样温度（0-2）|
| `reasoning_effort` | 否 | 推理强度 `low`/`medium`/`high`/`max` |
| `tools` | 否 | 工具定义（OpenAI function calling 格式）|
| `tool_choice` | 否 | 工具选择策略 |
| `parallel_tool_calls` | 否 | 是否允许并行工具调用 |

**简单请求：**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

**多模态图片输入（需 vision 模型）：**
```json
{
  "model": "xiaomi/mimo-v2.5",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "描述这张图片" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
  }]
}
```

**工具调用：**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [...],
  "tools": [{
    "type": "function",
    "function": { "name": "get_weather", "description": "...", "parameters": {...} }
  }],
  "tool_choice": "auto"
}
```

**流式响应（SSE）：**
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"思考过程"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":8}}}

data: [DONE]
```

**非流式响应（含缓存命中）：**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "deepseek/deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello!",
      "reasoning_content": "The user said hello, I should respond."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 7558,
    "completion_tokens": 42,
    "total_tokens": 7600,
    "prompt_tokens_details": { "cached_tokens": 7552 }
  }
}
```

### `POST /v1/messages`

Anthropic Messages API 兼容端点。支持流式和非流式、工具调用。

**请求体：**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "你是一个有用的助手。",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

**Anthropic 协议差异（自动转换）：**

| 概念 | Anthropic 原始格式 | 转换说明 |
|------|-------------------|----------|
| System prompt | 顶层 `system` 字段 | 自动转为 OpenAI `system` message |
| 消息内容 | `content` 数组（text/tool_use/tool_result） | 自动映射为对应角色 |
| 工具结果 | `user` 消息中的 `tool_result` 块 | 自动转为 `role: "tool"` |
| 工具定义 | `input_schema` | 自动映射为 `parameters` |
| `tool_choice` | `{type:"auto"/"any"/"tool"}` | `any`→`required`，`tool`→function 对象 |
| 推理强度 | `thinking.budget_tokens` | 自动映射为 `reasoning_effort`（≥10000→high, ≥5000→medium, ≥2000→low） |
| 停止原因 | `end_turn`/`max_tokens`/`tool_use` | 自动映射为 `stop`/`length`/`tool_calls` |
| Token 用量 | `input_tokens`/`output_tokens` + 缓存 | 透传，缓存字段映射为 Anthropic 格式 |

**流式响应（SSE，Anthropic 格式）：**
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":[],"model":"...","usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10,"cache_read_input_tokens":0,"input_tokens":100}}

event: message_stop
data: {"type":"message_stop"}
```

**非流式响应：**
```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "model": "deepseek/deepseek-v4-flash",
  "content": [{ "type": "text", "text": "Hello!" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 7558,
    "output_tokens": 42,
    "cache_read_input_tokens": 7552,
    "cache_creation_input_tokens": null
  }
}
```

### `POST /v1/responses`

OpenAI **Responses API**（Codex、以及新版 OpenAI SDK 用的那套）。

请求侧做转译：`input`（消息数组，item 可省略 `type`）、`instructions`、`max_output_tokens`、`temperature`、`top_p`、`reasoning`、`tools`、`tool_choice` 都会映射进 CC 信封；响应按 Responses 形状返回（`object: "response"`、`output` 数组、`usage`、`status`）。流式为 SSE：
`response.created` / `response.in_progress` / `response.output_item.added|done` / `response.content_part.added|done` / `response.output_text.delta|done` / `response.reasoning_summary_text.delta|done` / `response.function_call_arguments.delta|done`，收尾是 `response.completed`（被 `max_output_tokens` 截断时为 `response.incomplete`，出错为 `response.failed`）。

- **无状态**：`previous_response_id` 不支持，传了直接 `400` —— 每轮把完整 `input` 发过来即可（代理不存会话历史）。
- 错误体是 Responses 风格：`{"error":{"message":...,"type":...}}`。
- 与 `/v1/chat/completions` 共用同一套上游调用、缓存断点与空闲看门狗。

```bash
curl http://127.0.0.1:3050/v1/responses \
  -H "Authorization: Bearer user_xxxxxxxxx" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}]}'
```

### `GET /v1/models`

返回可用模型列表。优先从 Provider API 动态拉取（5min 缓存），失败回退硬编码列表。

### `GET /health`

健康检查。返回 `OK`。

## 错误码

代理自己产生的：

| HTTP | 场景 |
|------|------|
| `400` | 请求体不是合法 JSON、`input` 为空、用了不支持的 `previous_response_id` |
| `401` | 缺 API Key / 格式不对（Key 必须以 `user_` 开头；通过 `Authorization: Bearer` 或 `x-api-key` 传入）|
| `404` | 路径不存在 |
| `413` | 请求体超过 `CC_MAX_BODY_MB`（连接保持可排空，不会直接 reset）|
| `429` | 零输出 token、流空闲超时（30s 流式 / 90s 非流式）、或上游限流映射 —— 都带 `Retry-After`，SDK 自动退避重试；连续 3 次超时后提示压缩上下文 |
| `502` | CC 上游错误（`fetch failed` 这类连接层失败也走这里）|
| `503` | 开了 `CC_MAX_INFLIGHT` 且超过在途上限（`type: server_busy`）|

上游 CC 状态码的映射（`CC_STATUS_MAP`，未列出的按 `502 upstream_error`）：

| 上游 | 下游 |
|------|------|
| `400` → `400 invalid_request_error` | `401` → `401 authentication_error` |
| `402` → `429 rate_limit_error`（付费失败按限流处理）| `403` → `401 authentication_error` |
| `404` → `404 not_found` | `422` → `400 invalid_request_error` |
| `429` → `429 rate_limit_error`（带 `retry_after: 30`）| `500` / `502` → `502 upstream_error` |
| `503` → `503 temporarily_unavailable` | 其它 → `502 upstream_error` |

上游错误体里的机器可读分类（`error.code`，如 `BAD_REQUEST` / `USAGE_EXCEEDED`）会透传到下游错误体的 `error.code`。

## 模型列表

代理访问 `GET /v1/models` 会返回实时模型列表。以下为常见模型参考，完整列表以实际接口返回为准——各模型套餐可参考 [Command Code Pricing](https://commandcode.ai/docs/resources/pricing-limits)。

### 常用模型

| 模型 ID | 提供商 |
|---------|--------|
| `claude-sonnet-4-6` / `claude-opus-4-8` / `claude-opus-4-7` / `claude-haiku-4-5-20251001` | Anthropic |
| `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex` | OpenAI |
| `deepseek/deepseek-v4-pro` / `deepseek/deepseek-v4-flash` | DeepSeek |
| `moonshotai/Kimi-K2.6` / `moonshotai/Kimi-K2.5` | Kimi |
| `zai-org/GLM-5.1` / `zai-org/GLM-5` | GLM |
| `MiniMaxAI/MiniMax-M3` / `MiniMaxAI/MiniMax-M2.7` / `MiniMaxAI/MiniMax-M2.5` | MiniMax |
| `Qwen/Qwen3.7-Max` / `Qwen/Qwen3.6-Max-Preview` / `Qwen/Qwen3.6-Plus` | Qwen |
| `stepfun/Step-3.7-Flash` / `stepfun/Step-3.5-Flash` | Step |
| `xiaomi/mimo-v2.5-pro` / `xiaomi/mimo-v2.5` | Xiaomi（**支持图片输入**） |
| `google/gemini-3.5-flash` / `google/gemini-3.1-flash-lite` | Gemini |

> ⚠️ 部分模型（如 `deepseek-v4-flash`、`claude-sonnet-4-6`）不支持图片输入。如需多模态请用 `xiaomi/mimo-v2.5`、`Kimi-K2.5` 等 vision 模型。

## 接入示例

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050/v1",
)

response = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### cURL
```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
```

### Cursor
在 Cursor 设置中添加 Custom Provider：
- **API Base URL**: `http://127.0.0.1:3050/v1`
- **API Key**: `user_xxxxxxxxx`
- **Model**: 从模型列表中选择

### Anthropic (Python SDK)
```python
import anthropic

client = anthropic.Anthropic(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050",
)
message = client.messages.create(
    model="deepseek/deepseek-v4-flash",
    max_tokens=1000,
    system="You are helpful.",
    messages=[{"role": "user", "content": "hello"}],
)
print(message.content[0].text)
```

Anthropic SDK 通过 `x-api-key` 头鉴权——代理已原生支持（无需 `Authorization` 头）。

### OpenCode
```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3050/v1",
  "apiKey": "user_xxxxxxxxx"
}
```

## 反检测

基于对官方 CLI 网络流量的分析（版本号从 npm registry 动态拉取），实现了以下兼容适配：

| 机制 | 实现 |
|------|------|
| **设备指纹** | 每个 Key 首次请求前发送 `POST /alpha/fingerprint/record`；信号值（Windows MachineGuid 形状、真实形状的 MAC、`DESKTOP-xxxxxx` 主机名）由 API key **确定性派生**，并按 CLI 的算法哈希 —— 同一个 key 永远报告同一台设备：重启、内存回收、多实例都一致（用 `CC_FINGERPRINT_SALT` 成批换身份）|
| **生命周期声明** | Key 初始化时与指纹并行发送 `POST /alpha/lifecycle-events`（`cli_session_exists`，metadata `{sessionId, cliVersion, mode, os}`）|
| **按 Key 分 Session** | 每个 API Key 独立 session，12h 过期 + 1h 随机抖动 |
| **协议版本号** | `x-command-code-version` 报**实际实现的协议版本**（当前 `1.53.1`）；npm 上有新版本只打**漂移告警**，不会静默改版本号 |
| **CLI 信封格式** | 9 键：`config / memory / taste / skills / permissionMode / threadId / mode / promptCache / params` |
| **OpenTelemetry** | `traceparent` (W3C Trace Context) |
| **环境标识** | `x-cli-environment: production`、`x-taste-learning: "false"`、`User-Agent: cli` |
| **Project Slug** | `x-project-slug` = `slugify(DEVICE_PROFILE.projectDir)`，与 `config.workingDir` 同源（默认 `C:\Users\dev\projects\app`，用 `CC_DEVICE_PROJECT_DIR` 改）|
| **设备档案单一真源** | 指纹 / `config.environment` / `config.workingDir` / `x-project-slug` / lifecycle 的 `os` 共用同一份 `DEVICE_PROFILE`（`win32` / `x64`）—— 既不会自相矛盾（"指纹说 win32、环境说 linux"），也不把宿主真实平台、Node 版本、cwd 交给上游 |
| **思考强度** | `reasoning_effort` 透传 (low/medium/high/max) |
| **API Key 格式验证** | 对 `Authorization: Bearer` 或 `x-api-key` 用正则 `user_[a-zA-Z0-9_-]+` 提取，自动清理多余路径/前缀，`sk-xxx` 等非 `user_` 格式拒 |
| **流式超时保护** | 流式 30s、非流式 90s → 429 + SDK 自动重试 |
| **连续超时阈值** | 连续 3 次超时后才提示压缩上下文 |
| **零输出防护** | outputTokens=0 → 429 `rate_limit_error`（SDK 自动重试，反异常计费） |
| **上游中止** | 客户端断连 + 全部错误路径 `AbortController` 打断 CC |
| **隐私保护日志** | 日志不含 API Key 片段、错误 body、stack trace |

## 协议细节

### CC API 请求体结构

```json
{
  "config": {
    "workingDir": "C:\\project",
    "date": "2026-06-07",
    "environment": "win32",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": null,
  "taste": null,
  "skills": null,
  "permissionMode": "standard",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [...],
    "max_tokens": 64000,
    "stream": true,
    "reasoning_effort": "max"
  }
}
```

`config.environment` / `config.workingDir` 都取自 `DEVICE_PROFILE`（不是宿主真实值），`skills` 发 `null`（不是空串）。

条件字段：`system`（从 system 消息提取）、`temperature`、`reasoning_effort`、`tools`（映射为 CC `input_schema` 格式）、`tool_choice`、`parallel_tool_calls`。给了 `prompt_cache_key`（或客户端自带 `cache_control` 断点）时，断点会落在 system 的最后一块上 —— 缓存按前缀计，system 正是最前那段前缀。

### CC API 图片消息格式

CLI 发送图片的格式：

```json
{
  "role": "user",
  "content": [
    { "type": "image", "image": "data:image/jpeg;base64,..." },
    { "type": "text", "text": "图里写了什么" }
  ]
}
```

代理收到 OpenAI `image_url` 格式后自动转为上述 CC 格式透传。

## Docker 部署

### 从 GHCR 拉取

推送到 `master` / `main` / `release` 分支或打 `v*` tag 时，GitHub Actions 会构建并推送多架构镜像（`linux/amd64` + `linux/arm64`）到 GitHub Container Registry：

```bash
cp config.json.example config.json
docker pull ghcr.io/qingdeng888/commandcode-proxy:latest
docker run -d --name cc-proxy -p 3050:3050 -e PORT=3050 \
  -v "$PWD/config.json:/app/config.json:ro" \
  ghcr.io/qingdeng888/commandcode-proxy:latest
```

推送到 `master` / `main` 会更新 `latest` 标签，`v*` tag 额外生成版本标签。

> ℹ️ **GHCR 包默认为私有**，拉取前需登录：
>
> ```bash
> docker login ghcr.io -u <你的 GitHub 用户名>
> ```
>
> 密码填入具有 `read:packages` 权限的 PAT（本机已登录 `gh` 时可直接用 `gh auth token`）。
> 希望匿名拉取，可在包的 **Settings → Danger Zone → Change visibility** 中改为 Public。

升级后请确认 digest 真的变了（`docker inspect --format '{{index .RepoDigests 0}}'`），别假设本地缓存就是新版本。

### 快速启动 (docker compose)

默认编排 `docker-compose.yml` 直接拉取上一步的预构建镜像，无需本地构建：

```bash
docker compose up -d
```

代理将在宿主机 `http://0.0.0.0:3050` 监听（映射到容器内固定端口 `3050`）。通过 `PROXY_PORT` 自定义主机端口：

```bash
PROXY_PORT=13050 docker compose up -d
```

### 配置文件挂载

**镜像内不包含 `config.json`** —— `proxyKey`、`apiKey`（多 Key）等配置必须通过挂载注入，否则容器会回退到内置默认值（**无访问保护、无上游 Key**）：

```yaml
volumes:
  - ./config.json:/app/config.json:ro
```

首次部署**必须**先复制模板 —— 否则 Docker 会把不存在的宿主路径创建成同名目录：

```bash
cp config.json.example config.json
```

`docker compose` 已默认挂载该文件；裸 `docker run` 需自行加 `-v`。

> ⚠️ **宿主机的 `config.json` 必须已存在**。若不存在，Docker 会把它创建成一个**同名目录**，容器内 `readFileSync` 报 `EISDIR`，配置加载失败并回退到默认值（日志中会有 `[config] Failed to parse config.json` 提示）。
>
> ⚠️ **容器内端口恒为 `3050`**：`Dockerfile` 与 `docker-compose.yml` 都设置了 `PORT=3050` 环境变量，而环境变量的优先级**高于** `config.json` 的 `port` 字段。因此挂载配置文件里的 `port` 字段不会改变容器内监听端口 —— 对外端口由 `PROXY_PORT`（主机侧映射）决定。

### 数据目录挂载（后台配置持久化）

后台添加的 Key、后台密码、模型测试结论都写在 `/app/data`。**不挂卷的话，容器重建后这些全部丢失**：

```yaml
volumes:
  - ./data:/app/data
```

`docker-compose.yml` 已默认挂载（目录不存在时 Docker 会自动创建，与 `config.json` 那种「文件被创建成目录」的坑不同）。
镜像内该目录已声明为 `VOLUME`，用裸 `docker run` 时需要显式 `-v "$PWD/data:/app/data"`。

> 💡 只想用配置文件管 Key 也可以：把 Key 写进 `config.json` 的 `apiKey` 或 `CC_API_KEY` 环境变量，
> 它们会以**只读**条目出现在后台，不依赖 `data/` 卷。后台的增删改才会写 `data/`。

### 管理后台密码（Docker）

```bash
# 方式一：compose 同目录放 .env（compose 会自动读取并注入）
echo 'ADMIN_PASSWORD=你的管理密码' > .env

# 方式二：直接传环境变量
ADMIN_PASSWORD=你的管理密码 docker compose up -d
```

未设置时后台整体拒绝访问（不是「无密码可进」），启动日志会给出明确警告。

### 从源码构建（本地开发）

需要基于当前源码构建时，改用 `docker-compose.local.yml` —— 它与默认编排的唯一区别是把 `image:` 换成 `build: .`，端口映射、配置挂载、健康检查保持一致：

```bash
docker compose -f docker-compose.local.yml up -d --build
```

产物镜像标记为 `commandcode-proxy:local`，与从 GHCR 拉取的 `latest` 相互隔离、互不覆盖，两套编排可以并存。

也可以只用 CLI 构建：

```bash
docker build -t commandcode-proxy:latest .
docker run -d -p 3050:3050 -e PORT=3050 \
  -v "$PWD/config.json:/app/config.json:ro" \
  commandcode-proxy:latest
```

### 多架构构建

```bash
npm run docker:build:multi
```

### 环境变量

容器相关的只有这几个，其余全部见上面的[环境变量](#环境变量)总表：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3050` | 容器内监听端口（优先级高于 `config.json` 的 `port`） |
| `PROXY_PORT` | `3050` | 主机映射端口（仅 compose） |
| `ADMIN_PASSWORD` | 空 | 管理后台密码；未设置时 `/admin/` 拒绝访问 |
| `CC_DATA_DIR` | `/app/data` | 运行时数据目录（镜像内已设，配合卷挂载） |

## 在途请求上限（可选）

**默认关闭**（`CC_MAX_INFLIGHT` 未设置 = 不限制并发），既有行为不变。

本项目定位是**纯反代层**，并发控制属于下游 —— 按 IP / 按 key 的限流请用反向代理（见[内存与部署](#内存与部署)里的 `limit_conn`）。
本项**不是**那套方案的替代品，只为「不挂反代裸跑」（Dockerfile 与 `npm start` 都支持这种用法）提供一个**进程内、仅全局**的兜底：

```bash
CC_MAX_INFLIGHT=32 npm start    # 最多同时处理 32 个请求
```

超限时快速返回 `503` + `Retry-After: 5` + `type: server_busy` —— OpenAI / Anthropic 官方 SDK 认得这个组合会自动退避重试，而不是拿到连接被重置。`/health` 与 `/` 不计入、也不受限制，避免探活与编排器因业务繁忙收到 503。

**为什么需要它**：内存 = `在途数 × (0.13MB + 5.5 × body_MB)`。`CC_MAX_BODY_MB` 只管住**单请求**量级，乘数无人管 —— 默认 100MB 时 N 个并发最坏可达 N × 550MB。

> ⚠️ 开启本项**不等于**内存安全：32 × 550MB 仍远超小机器容量。要拿到硬性上界，需**同时**下调 `CC_MAX_BODY_MB`。

## 上游空闲超时

两个上游读空闲看门狗，超时后返回 `429`（带 `retry_after`）让 SDK 自动重试：

| 环境变量 | 默认 | 作用于 |
|---|---|---|
| `CC_STREAM_IDLE_MS` | `30000` | 流式请求 |
| `CC_NONSTREAM_IDLE_MS` | `90000` | 非流式请求 |

**语义**：只计「`reader.read()` 的等待时间」，每收到一个 chunk 就重置 —— **不是整个请求的总时长**。
只要上游在持续吐流就不会触发，哪怕单个请求已经跑了几十分钟。

**默认值与官方 CLI 不一致，这是已知取舍**（[#19](https://github.com/MAXeaglet/commandcode-proxy/issues/19)）：
官方 CLI 对上游**没有任何** idle timeout —— 反编译 `command-code@1.50.0` 可见所有 `createApiClient({ baseUrl })` 调用点都未传 `timeout`，实测 700+ 秒的停顿可正常完成。
本代理保留 30s 是为了兜住真正死掉的连接；代价是**推理模型的长思考停顿可能被误杀**。

若遇到「`429 Response timeout`」「`zero output tokens`」且日志里 `elapsedMs ≈ 30000`、`bytesReceived = 0`，
说明是看门狗误杀了 prefill / 首 token 阶段的正常停顿 —— 调大即可：

```bash
CC_STREAM_IDLE_MS=300000 npm start      # 5 分钟
```

> ⚠️ 误杀的成本不止一次失败：被 abort 后返回 `429 + retry_after`，SDK 会自动重试，
> 而重试等于**完整重发整个上下文**，长会话下每次误杀都要重付一次全量 prefill。

## 内存与部署

> 数据来自 [issue #20](https://github.com/MAXeaglet/commandcode-proxy/issues/20) 的实测复现（Node v24，loopback mock 上游）。

单请求内存开销的经验公式：

```
RSS ≈ 70 MB + 在途请求数 × (0.13 MB + 5.5 × body_MB)
```

### 流式响应已做背压

`res.write()` 返回 `false`（socket 写缓冲超过 `highWaterMark`）时会暂停读取上游，响应不再在内存中无界堆积：

| 场景（200MB 上游流，客户端发完请求即停止读取） | 峰值 RSS 增量 |
|---|---|
| 修复前 | **+586 MB**（66 → 652 MB）|
| 修复后 | **+4 MB**（背压一路传回上游，上游只吐出 ~8MB 即停住）|

这不只是恶意客户端问题 —— 弱网/移动端、客户端卡在工具执行、客户端已放弃但 TCP 还没发 RST，都会触发。

### 请求体放大 ~5.5×

body 在转发到上游前同时存在多份副本：`chunks[]` / `Buffer.concat` / utf8 字符串 / `JSON.parse` 对象树 / `buildCcRequest` 重建对象树 / `JSON.stringify` 序列化体。

| body | 上限 | 峰值增量 | 结果 |
|---|---|---|---|
| 7 MB | 100 MB | +52 MB（7.4×）| 200 |
| 20 MB | 100 MB | +116 MB（5.8×）| 200 |
| 20 MB | 8 MB | +21 MB（1.05×）| **413** |

启动时若隐含最坏峰值 ≥ 500MB，日志会输出 `warn` 提示。上限是**按请求**的，proxy 自身没有在途限流 —— 公网部署必须在反向代理层补上。

### nginx 反代建议

`client_max_body_size` 在 nginx 拒绝时，body 根本不会进入 Node 进程：

```nginx
map $http_authorization $cc_key { default $http_authorization; "" $http_x_api_key; }
map "" $cc_global_key { default "global"; }

limit_conn_zone $binary_remote_addr zone=cc_ip:10m;
limit_conn_zone $cc_key             zone=cc_key:10m;
limit_conn_zone $cc_global_key      zone=cc_global:10m;

location /v1/ {
    client_max_body_size 4m;   # 需 <= CC_MAX_BODY_MB
    limit_conn cc_ip     8;
    limit_conn cc_key    4;
    limit_conn cc_global 32;   # 这一项就是内存天花板
    limit_conn_status 429;
    proxy_pass http://127.0.0.1:3050;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 300s;   # 需大于 30s 的流空闲超时
}
```

> ⚠️ **keep-alive 时序**：上面 `proxy_set_header Connection ""` 让 nginx 与后端保持长连接，此时反代侧的
> `upstream { keepalive_timeout ...; }` 必须**小于**后端的 `CC_KEEPALIVE_TIMEOUT_MS`（默认 65s）。反了的话，
> 反代会复用一条后端已经 FIN 掉的连接去写 POST 请求体，吃 `EPIPE`（nginx 日志里是 `sendfile() failed (32: Broken pipe)`）；
> 而 POST 非幂等、nginx 默认不重试 —— 客户端直接拿到 502。

### 僵死连接（既不读也不断开）

背压生效后，客户端**既不读也不断开**时该请求会连带上游连接一直挂着。实测残留在途成本：

| 僵死连接数 | RSS 增量 | 上游连接持有 |
|---|---|---|
| 1 | +5 MB | 1 |
| 10 | +45 MB | 10 |
| 50 | +248 MB | 50（**永久持有**）|

特性是**有界、不泄漏、客户端断开即回收**（RSS 曲线完全持平），但**连接数本身无上限**。

默认**不处理**，因为僵死客户端与「卡在工具执行的合法客户端」在协议层无法区分；且官方 CLI 对上游没有任何 idle timeout（见 [#19](https://github.com/MAXeaglet/commandcode-proxy/issues/19)），贸然加超时会重蹈「误杀健康请求」。

需要封顶时启用（opt-in）：

```bash
# 下游持续阻塞超过 60s 才断开，正常客户端只要在推进 drain 就不会触发
CC_CLIENT_DRAIN_TIMEOUT_MS=60000 npm start
```

启用后实测（50 个僵死连接）：上游连接持有数由 **50（永久）→ 0**，且丢弃后**不会**继续抽干上游。

更稳妥的封顶仍在反向代理层（`limit_conn`），因为只有它知道该部署能承受多少并发。

### 其它注意事项

- **`logFile` 是同步写**（`appendFileSync`），公网负载下会阻塞事件循环 —— 建议保持留空，从 stdout 收集。
- **systemd 兜底**：配 `MemoryMax=` 与 `NODE_OPTIONS=--max-old-space-size=`，让超限杀掉 proxy 而不是 `sshd`/`nginx`。
- **多账号 + 多实例**：`sessionStore` / `keyStateStore` 是进程内 `Map`。同一个 API key 打到两个实例会得到两个不同 session 与**两个不同设备指纹**，上游会看到「一个账号在多台机器上」。横向扩展请按 API key 做一致性哈希（`hash $cc_key consistent`），不要轮询。

## 免责声明

本项目仅供**学习和研究**使用。

- **非官方**：本项目与 Command Code 无任何关联，非官方产品。
- **个人使用**：使用者应自行承担所有责任。请遵守 [Command Code 服务条款](https://commandcode.ai/tos)。
- **API Key**：本项目不会收集、上传或泄露你的 API Key。Key 通过每次请求的 `Authorization: Bearer <key>` 或 `x-api-key` 头传入，日志中不记录；`config.json` 中的可选 `apiKey` 字段仅作本地兜底，不会离开你的机器。
- **合规性**：协议基于对本地 CLI 网络流量的被动观察，未对服务端进行任何未授权访问、破解或篡改。
- **账号风险**：建议和正常 CLI 使用频率保持一致，超高并发调用可能触发风控。

---

[Linux.do](https://linux.do)

## 开发

```bash
# 带 watch 模式启动（文件修改自动重启）
npm run dev
```
