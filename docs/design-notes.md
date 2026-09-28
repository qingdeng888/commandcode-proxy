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
