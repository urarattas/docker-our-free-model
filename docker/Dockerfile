# syntax=docker/dockerfile:1.7
#
# Our Free Model — 独立本地服务（standalone）容器镜像
#
# 本镜像只封装 standalone 产品（packages/standalone），不依赖 DSH 内核、
# Cordis 或任何宿主凭据库。服务在容器内只监听回环地址，容器外部通过
# --lan 打开的 LAN 推理中继访问 /v1/* 推理端点。
#
# 构建上下文是仓库根目录（因为要取 src/、vendor/、packages/standalone/）：
#   docker build -f docker/Dockerfile -t our-free-model:local .
#
# 上游同步：本文件位于 docker 分支。main 分支跟随上游仓库更新，
# 镜像由 GitHub Actions 从上游 main 直接构建（见 .github/workflows/）。

# ── 构建阶段：裁剪出 standalone 真正需要的运行时文件 ──────────────────────
FROM node:24-bookworm-slim AS build

WORKDIR /build

# 只复制 standalone 的运行时闭包，源码、脚本、测试与文档都不进镜像。
# 运行时闭包由 scripts/collect-standalone-runtime.mjs 计算，与
# packages/standalone/README.md 记录的发布文件清单一致。
COPY scripts/collect-standalone-runtime.mjs ./scripts/collect-standalone-runtime.mjs
COPY packages/standalone ./packages/standalone
COPY src ./src
COPY vendor ./vendor
COPY LICENSE ./LICENSE

RUN node scripts/collect-standalone-runtime.mjs /build/runtime \
 && echo "--- runtime files ---" \
 && find /build/runtime -type f | wc -l

# ── 运行阶段 ───────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Our Free Model (standalone)" \
      org.opencontainers.image.description="Our Free Model 独立本地服务：OpenAI / Anthropic 兼容推理端点，容器化运行" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/urarattas/docker-our-free-model" \
      org.opencontainers.image.documentation="https://github.com/urarattas/docker-our-free-model/blob/docker/README-DOCKER.md"

# 独立服务的数据目录：账号凭据、渠道账本、用量统计、API Key 都落在这里。
# 挂载为卷即可在升级镜像后保留全部状态。
ENV OFM_HOME=/data \
    OFM_PORT=18900 \
    NODE_ENV=production

# curl 用于 HEALTHCHECK；ca-certificates 用于出网访问各上游。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /build/runtime /app

# entrypoint 必须在切换到非 root 用户之前就位并可执行。
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# 以非 root 运行。数据目录的属主在镜像里先建好：具名卷挂载后会继承这个
# 属主，bind mount 则由 entrypoint 提示使用者自行 chown。
RUN mkdir -p /data && chown -R node:node /app /data
USER node

VOLUME ["/data"]

# 本机管理端口（回环绑定，容器内可达；宿主机用 docker exec / port-forward 访问）
EXPOSE 18900
# LAN 推理中继端口（由 --lan 打开，只转发 /v1/* 推理路径）
EXPOSE 18901

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${OFM_PORT}/health" || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["--lan", "--lan-port", "18901"]
