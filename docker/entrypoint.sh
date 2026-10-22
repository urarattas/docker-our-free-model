#!/bin/sh
# Our Free Model — 独立本地服务容器入口
#
# 独立服务本身只监听回环地址（这是上游的设计：管理页面与凭据只属于本机）。
# 容器把这个回环监听器放在容器网络里，容器外部要访问推理端点，靠的是
# 服务自带的 LAN 中继（--lan）：它单独监听 0.0.0.0，只放行 5 条 /v1/* 推理
# 路径，并且使用一把与本机 API Key 不同的 LAN Key。
#
# 也就是说：
#   - 18900：本机端口。容器内可达；宿主机请用 docker exec 或端口转发访问。
#   - 18901：LAN 推理中继。容器外可达，推理客户端连这里。
#
# 管理页面（/ 与 /api/management/*）在两种情况下都不在容器外可达，这是
# 上游 issue #216 明确记录为"未实现"的部分，不是本镜像的缺陷。

set -eu

DATA_DIR="${OFM_HOME:-/data}"
PORT="${OFM_PORT:-18900}"

if [ ! -d "$DATA_DIR" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true
fi

# 服务会以 0600 写 settings.json（里面是 API Key）、账号凭据与用量统计。
# 目录不可写时这些配置每次重启都会丢，而且服务只在日志里留一行。
if [ ! -w "$DATA_DIR" ]; then
  echo "OFM_HOME ($DATA_DIR) 不可写：独立服务需要在这里写入 settings.json（API Key）、账号凭据与用量统计。" >&2
  echo "请把该目录挂载为卷并保证容器用户（uid $(id -u)）可写。" >&2
  echo "具名卷（-v ofm-data:/data）会继承镜像里的属主，通常无需处理；" >&2
  echo "bind mount（-v \$PWD/data:/data）需要自行 chown。" >&2
  exit 1
fi

# 服务只接受 --port / --data-dir / --no-refresh / --probe / --lan /
# --no-lan / --lan-port。这里补上默认的端口与数据目录，其余参数原样透传，
# 用户仍然可以用 `docker run ... <image> --no-lan` 覆盖。
exec node /app/packages/standalone/cli.mjs --port "$PORT" --data-dir "$DATA_DIR" "$@"
