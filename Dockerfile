FROM node:22-alpine
WORKDIR /app
COPY package.json proxy.mjs ./
# 容器内端口固定 3050，与下方 EXPOSE / HEALTHCHECK 一致。
# 该环境变量优先级高于挂载进来的 config.json（见 loadConfig 的覆写顺序）
ENV PORT=3050
EXPOSE 3050
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --spider http://127.0.0.1:3050/health || exit 1
CMD ["node", "proxy.mjs"]
