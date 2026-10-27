# 设计约定

本文件记录本项目的**既定取舍**。改动代码前先读一遍 —— 这些不是"待优化项"，
而是有意为之的决定，改动前请先确认动机是否仍然成立。

## 1. 不要求 TLS

**与参考项目 Cline-proxy 一致，本项目不要求、也不内置 TLS。** 局域网内自用直接
`http://<主机>:<端口>/admin/` 即可，无需反向代理、无需证书、无需任何额外处理。

- 数据面 `/v1/*` 与后台 `/admin/*` 都按"可直接在局域网使用"设计。
- 后台会话 Cookie 默认**不带** `Secure`（带上会导致 http:// 下浏览器不回传 Cookie，
  直接把后台登不进去）。`ADMIN_COOKIE_SECURE=1` 仅为"用户自己套了 HTTPS"这一情形提供，
  属于可选开关，不是推荐步骤。
- 文档中不得把 TLS 写成部署前置条件。要提醒的只是事实：口令是明文提交的 ——
  仅当用户**自己**决定暴露到公网时，才需要自己加一层 HTTPS。

## 2. 服务端零运行时依赖

`lib/` 下所有模块只用 Node 内置能力（`node:http`、`node:crypto`、`node:fs`…），
`package.json` 没有 `dependencies`。

- **数据面必须留在 `node:http`**。`proxy.mjs` 里的 keep-alive/`headersTimeout` 时序、
  流空闲超时、下游背压熔断、断连中止上游，都是踩真实线上故障调出来的，并有测试锁定。
  换成 express/hono 在这条路径上不解决任何问题，只会把 socket 行为藏到框架后面。
- 后台管理面同样不引入框架：路由/中间件/Cookie 解析加起来不到 100 行。
- 明确不引入：`express`、`hono`（无收益）、`bcrypt`（内置 `scrypt` 更强且免依赖）、
  `better-sqlite3`（原生编译，部署变脆）。
- 前端（`web/`）**可以**有构建期依赖（Vite + Vue），它不进入运行时镜像。

## 3. 可变状态一律放数据目录

所有会被程序改写的东西都在 `data/`（`CC_DATA_DIR` 可改）：

| 文件 | 内容 |
|------|------|
| `data/keys.json` | 后台管理的上游 Key（明文） |
| `data/settings.json` | 后台改过的设置（稀疏覆盖） |
| `data/.admin-auth.json` | 后台密码的 scrypt 哈希 |
| `data/model-tests.json` | 最近一次批量模型测试结果 |

**`config.json` 只作为部署期输入，永不被程序改写。** 原因是 Docker 里它通常是
**单文件 bind mount**（且 `:ro`），而原子写是"临时文件 + rename" —— 单文件挂载点上
`rename()` 会直接 `EBUSY`，改动只进内存、宿主文件纹丝不动，容器重建即丢失。
`data/` 是目录挂载，rename 正常。

这条约定的实际收益：`config.json` 里放着 `proxyKey` 等敏感字段，保持只读是真实的
安全属性；同时所有需要持久化的东西集中在一个可挂卷的目录里。

## 4. 配置分层优先级

```
环境变量  >  data/settings.json（后台写入）  >  config.json  >  内置默认值
```

- 后台只写**真正发生变化**的字段（服务端算差值），所以前端整份表单提交也不会让
  `settings.json` 变成一份完整配置快照，后台没碰过的字段仍然听 `config.json`。
- 被环境变量锁定的字段，后台**改不动**：既不落盘，也不改内存。
- `GET /admin/api/config` 返回 `settingSources`（每个字段当前来自哪一层）与
  `envLocked`，保存时的 `message` 会说明落盘结果、冲突与环境变量锁定情况。
- 手工编辑 `config.json` 也会热加载（每 3 秒轮询 mtime，不依赖 `fs.watch` 的跨平台可靠性）。

## 5. 跟上游的关系

本仓库是 `MAXeaglet/commandcode-proxy` 的 fork，`upstream` 远程常备。
同步上游时，上述 1–4 条是本 fork 的差异所在，冲突解决时优先保留本 fork 的行为。

已确认无法照搬上游/参考项目的地方，都在代码注释里写明了原因，例如：

- **模型测试不能用"余额差值探测"**：CC 没有任何余额/用量接口
  （`/provider/v1/usage`、`/provider/v1/balance`、`/api/v1/users/me` 全部 404），
  故改为按上游错误码就地分类。
- **Cline 的账号刷新令牌机制不适用**：CC 用的是静态 `user_` Key。

### 5.1 从上游 PR 里挑着合并（2026-10-27）

上游 `master` 本身停在 `972828a`（2026-10-09），本 fork 早已包含它；那之后上游的动静全在
**开放 PR** 与 `test*` 分支里。逐个体检后合了四个 PR，另外几个明确不合：

| 来源 | 结论 | 理由 |
|---|---|---|
| PR #64 | 合 | 纯文档：修掉「session 过期 12h 换机器」的过时描述（该 store 已随 #29 移除） |
| PR #59 | 合 | 纯文档：补上流内 `error` 事件的 `statusCode` 会被采纳并映射的说明 |
| PR #68 | 合 | 真实拒绝：取消/部分响应的轮次没有 reasoning，严格上游报 `Missing required parameter` |
| PR #53 | 合（改接） | 按套餐过滤模型列表；原 PR 自带一套 `loadConfig()` + 目录缓存，与本 fork 的 `lib/config.mjs` + `lib/models.mjs` 冲突，只保留算法部分 |
| PR #46 | 合（改接） | 服务端 `web_search`；同样去掉它自带的 `loadConfig()`，并把 `webSearch` 接进配置分层 |
| #44 / #35 / #5 | 不合 | 内容已在 HEAD：Content-Length 预检、cpuCount=threads、cache_control 保留 |
| #12 / #27 | 不合 | 与既有实现重复或冲突：#12 的额度归一化已有更细的分类，#27 的 console 与本 fork 的 `lib/` + `web/` 是两套 |
| `test` / `test-pr5*` 分支 | 不合 | 是上游的实验分支，最终形态已通过 `master` 与 PR 表达 |

合并 PR #68 时有一个**语义交叉**必须处理：该 PR 早先的版本在「历史缺 reasoning」时会
**扣下 `reasoning_effort`**（等于牺牲当前轮推理），最终版改成回填非空占位符。本 fork 采用
最终版 —— 占位符是诚实的标记文本（`[reasoning unavailable: previous turn was interrupted]`），
真实值一律原样保留。

合并 PR #46 时另有一处**与既有优化的直接冲突**：issue #20 曾在 `buildCcRequest` 之后
把 `openaiReq` 置空以尽早回收那棵 20MB 级对象树，而搜索循环要往它的 `messages` / `tools`
上追加历史并重建 `ccBody`。取舍是保留 `openaiReq`（搜索循环需要），只断开 `anthropicReq`。

## 6. 协议保真（wire fidelity）

协议约定的唯一来源是官方 npm 包 `command-code` 的 `dist/cli.mjs`（压缩但未混淆）。
当前对齐版本是 **1.88.0**，写在 `proxy.mjs` 的 `CC_PROTOCOL_VERSION` 里，
**报的是「已实现的协议版本」而不是「npm 上的最新版本」** —— npm 上更新只打漂移告警。
理由：真机发出去的永远是「形状 + 版本号」自洽的组合；版本号跟着 npm 跑而形状没变，
等于自称最新版却说旧方言，比版本号过期更容易被行为分析挑出来。

1.87.1 复核后，影响本代理的差异只有四处，均已落实并有测试锁定
（`test/protocol-1.87.test.mjs`）：

| 差异 | 本代理的做法 |
|------|--------------|
| 头部表新增 `x-cli-surface` / `x-oss-primary-provider` / `x-cmd-provider-deepseek-internal` | **一个都不发**。三者分别只在 acp/rpc 入口、BYOK、内部账号时出现，普通会话不发；代理自称普通会话就必须一致 |
| 事件集新增 `cache-write-tokens` | 收下，但只在 `totalUsage.inputTokenDetails.cacheWriteTokens` 缺失时补齐 —— 两处相加会重复计账 |
| 事件集新增 `tool-result` / `server_tool_result` | 静默忽略。那是 providerExecuted 的服务端工具结果，代理不执行工具；但**绝不能**落到 `Unknown CC event type`（四条路径的静默表都已补） |
| `finishReason` 新增 `refusal` 一族（`refusal` / `content_filter` / `content-filter`） | 归一成内部值 `refusal`，出口按协议落地：OpenAI → `content_filter`，Anthropic → `refusal`，Responses → `status: incomplete` + `incomplete_details.reason: content_filter`。折成 `stop` 是谎报完成 |

另外三条与版本无关、但同属「出网必须干净」的约定：

- **孤立代理项在唯一的序列化点清掉。** `JSON.stringify` 会把半个 emoji 写成 `"\ud83d"`
  而不报错，严格的上游解码器会直接 400。用 replacer 挂在 `forwardToCC` 里的
  `JSON.stringify(body, sanitizeReplacer)` 上，三种协议、所有字段一次覆盖。
  前置判断用**非全局**正则（全局正则的 `lastIndex` 会让 `test()` 抖动），
  成对代理项（真实 emoji）原样保留 —— 朴素的范围过滤会删掉所有 emoji。
- **额度类错误是账号维度，必须换 Key。** 「与 Key 无关」的名单只留模型维度的
  `MODEL_NOT_IN_PLAN`（匹配时把下划线归一成空格、并转小写，因为 JSON 写
  `MODEL_NOT_IN_PLAN`、正文写 `model not in plan`）。额度类若也进去，多 Key 部署会
  因为第一个没钱的账号整池失败。
- **输出上限拒绝按上游写明的数字降档重发一次。** 只解析 `max_tokens: X > Y` 这种
  比较式；只报 `invalid max_tokens` 而不给数字时不猜（猜出来的值与真实上限在后续
  请求里无从区分）。学到的值进 `learnedOutputCeilings`（进程级、只收紧），
  与目录公布的 `max_output_tokens`、网关硬上限 200000 一起在 `buildCcRequest` 里取小。

### 6.1 后续跟进（1.88.0，纯请求头同步）

1.88.0 的比对结论是**运行时契约零变化**：端点集合 25 个双向零增零减；透传的六个自定义头
出现次数逐个相同；`toWireMessages` / `toWireTools` / `toWireSystem` / `toWireToolOutput` /
`toWirePermissionMode` / `toWireThreadId` / `consumedStopReason` 逐字相同；`consumeStream`
只有标识符改名（抹掉标识符后逐字相同，事件词汇表零变化）；指纹盐仍是
`command-code:device-fingerprint:v1`（只是压缩后的变量名换了）。因此这次只改了
`CC_PROTOCOL_VERSION`，没有任何形状调整 —— **版本号只随「确实实现的协议」前进**，
不因为 npm 上出现了新版本就跟着报。

### 6.2 从参考实现移植的两处（与协议版本无关）

- **超时提示按会话隔离。** 原实现是全进程一个 `consecutiveTimeouts` 计数器，于是
  A 会话卡住两次之后，毫不相干的 B 会话第一次超时就收到「请压缩上下文」。现在按
  session id 建 streak（无 session 的请求落到同一个全局槽位，否则阈值永远不会触发），
  并对条目数做 LRU 上限淘汰。`test/timeout-scope.test.mjs` 锁定：不同会话互不影响、
  同一会话第三次才升级、成功请求重置、无 session 仍能累积。
- **同一请求的多次尝试共用一份序列化结果。** 换 Key、闪断重试、输出上限降档都会
  重新走到序列化点，而带图长会话的 body 实测 28.4MB，重新 `JSON.stringify` 一次约
  150ms 的**同步**时间 —— 期间进程内所有在途请求都被卡住。现在按 `params` 对象身份
  缓存（WeakMap，随 body 一起回收），有效性判据是 `max_tokens`：降档重发会改它，
  改了必须重新序列化。`test/serialize-reuse.test.mjs` 用变异测试确认这条判据是必需的
  （去掉后第二次仍发旧预算，降档等于没做）。

**刻意不照搬参考实现的地方**：`/provider/v1/messages` 上参考实现会打三个 cache 断点
（system / 最后一个 tool / 最后一条 user 消息），但那是**另一个传输**。
`/alpha/generate` 的缓存是隐式前缀机制（实测同一前缀重发时 cacheReadTokens 自然命中），
而显式 `cache_control` 在 Anthropic 系列模型上按写缓存计费。在我们无法实测收益的
这条路由上主动加断点是在增加成本，因此只保留「客户端表达了缓存意图（`prompt_cache_key`）
而自己没打点」时补一个前缀末端断点。

## 7. 出站代理池（从 opencode2api 移植）

参考项目 `qingdeng888/opencode2api` 的代理管理比本项目的单代理字段完整得多，本次整体移植。
Go 与 JS 的形态差异很大，移植的是**语义**而不是代码；下面记录几处刻意的取舍。

### 7.1 条目的身份是内容，不是序号

`id = sha256(条目原文) 前 16 位`（`lib/proxies.mjs` 的 `proxyFingerprint`）。理由与 Key 池一样：
后台给某个 Key 绑定的代理必须在重排、启停、跨重启之后仍然指向同一条。用数组下标做 id
会在用户删掉中间一条时把所有绑定悄悄挪位 —— 那是最难排查的一类「配置看起来还在但行为变了」。

代价是「改地址 = 换一条」：改完之后指向旧地址的绑定必须一起迁移（`update` 里显式做了），
否则会留下一个指向不存在 id 的绑定。

### 7.2 停用只读条目：为什么需要一个 disabled 集合

参考实现把 `config.json` 里的条目也允许停用，停用记录放在配置的 `disabled_proxies`。
本项目更进一步：`config.json` 是**部署期输入，后台永不改写**（见第 4 条），所以停用记录
只能落在 `data/proxies.json`。于是三件事同时成立：

- `config.json` 里写了什么，永远还在（用户手改配置不会「看起来没生效」）；
- 后台可以表达「这条我暂时不想用」；
- 代理文件里的条目同理。

### 7.3 只有路由层失败才算代理故障

判据是「错误发生在拿到 HTTP 响应之前」。上游答了 401/403/429/500 说明隧道与 TLS 都通了，
那是账号或模型维度的问题；把它记成代理故障会让一条好代理被误判下线，而且在多代理部署里
会把流量全部挤到剩下的代理上。这与第 6 条「额度类错误该换 Key」是同一层判断的两个方向。

### 7.4 换代理重试，而不是换 Key

一条代理连不上时，正确动作是**同一个 Key 换一条代理**。换 Key 解决不了「代理挂了」，
而且会把好账号一个个标成失败（`forwardWithKeyRetry` 里 `proxyAttempts` 与 Key 轮换计数
是两套独立的预算，就是为此）。

这里踩过一个真实的坑：第一版把「下一条代理」预先加进 `triedProxies`，结果下一次循环顶部的
`choose()` 因为两条都被排除而返回 `null` —— 于是「重试」悄悄退化成**直连**，
本该失败的请求被放行了。测试「所有代理都不可达时如实报错」就是为这个坑写的。

### 7.5 与既有单代理字段的关系

`upstreamProxy`（历史字段）没有废弃，而是作为 `legacy` 来源的一条加入池子。升级上来的部署
行为完全不变，只是现在多了一个可以管理它的界面。三个字段的优先级是：
本次尝试显式传入的代理 > `upstreamProxy` > 直连。

### 7.6 刻意不移植的部分

- **WARP（userspace WireGuard 出口）**：参考项目用它给免费模型换出口 IP。本项目没有免费
  模型通道，也没有 UDP 出口需求，引入它等于给一个零依赖项目塞进一个用户态网络栈。
- **匿名通道的 per-exit 冷却与断路器**：那是给「同一个公共凭证被按 IP 限流」设计的。
  本项目的凭证是账号制的 `user_` Key，限流维度是账号不是 IP，代理池只需承担出口轮换。
- **`ProxyMode` 的 `disabled` 位**：参考实现把「停用」也塞进 Key 的代理模式里；
  本项目把它留在代理条目上（`enabled`），因为「这条代理不可用」与「这个 Key 怎么选代理」
  是两个正交的问题。
