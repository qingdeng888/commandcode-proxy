# ── 阶段一：构建前端（Vite + Vue）─────────────────────
# 前端只在构建期需要 node_modules，运行期一点也不需要 ——
# 所以放在独立阶段，最终镜像里不含前端依赖树。
FROM node:22-alpine AS web-builder

WORKDIR /build/web
COPY web/package.json web/package-lock.json* ./
# 有 lockfile 就用 ci（可复现）；没有则退回 install，避免首次构建直接失败
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

COPY web/ ./
RUN npm run build

# ── 阶段二：运行镜像 ──────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# 服务端零运行时依赖：只需要源码，不需要 npm install
COPY package.json proxy.mjs ./
COPY lib/ ./lib/
# 后台前端产物由上一阶段提供
COPY --from=web-builder /build/web/dist ./web/dist

# 容器内端口固定 3050，与下方 EXPOSE / HEALTHCHECK 一致。
# 该环境变量优先级高于挂载进来的 config.json（见 loadConfig 的覆写顺序）
ENV PORT=3050
# 数据目录：Key 池（keys.json）、后台密码哈希（.admin-auth.json）、模型测试结论。
# 必须挂卷，否则容器重建后后台配置全丢。
ENV CC_DATA_DIR=/app/data
VOLUME ["/app/data"]

EXPOSE 3050

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --spider http://127.0.0.1:3050/health || exit 1

CMD ["node", "proxy.mjs"]
