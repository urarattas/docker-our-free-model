#!/bin/sh
# Our Free Model — 独立本地服务容器入口
#
# 独立服务本身只监听回环地址（这是上游的设计：管理页面与凭据只属于本机）。
# 容器把这个回环监听器放在容器网络里，对外有两扇门：
#
#   1) LAN 推理中继（服务自带的 --lan）：单独监听 0.0.0.0，只放行 5 条
#      /v1/* 推理路径，使用一把与本机 API Key 不同的 LAN Key。
#   2) 管理转发（docker/management-relay.mjs）：本镜像提供，转发到本机
#      回环端口，把管理页面送到局域网。
#
# 也就是说：
#   - 18900：本机端口。容器内可达；宿主机请用 docker exec 或端口转发访问。
#   - 18901：LAN 推理中继。容器外可达，推理客户端连这里。
#   - 18902：管理转发。容器外可达，浏览器连这里（需要 OFM_RELAY_KEY）。
#
# 管理页面不直接暴露服务的回环端口：独立服务拒绝非回环 Host（上游 issue
# #216 明确记录为"未实现"的部分），relay 在容器内部改写请求头绕过它。

set -eu

DATA_DIR="${OFM_HOME:-/data}"
PORT="${OFM_PORT:-18900}"
RELAY_PORT="${OFM_RELAY_PORT:-18902}"
RELAY_KEY="${OFM_RELAY_KEY:-}"
# 镜像内的固定布局。这两个变量只为"在容器外直接跑这个脚本"时能覆盖
# （本地验证、自定义布局），容器里用默认值即可。
APP_DIR="${OFM_APP_DIR:-/app}"
RELAY_SCRIPT="${OFM_RELAY_SCRIPT:-/usr/local/lib/ofm/management-relay.mjs}"

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

# ── 管理转发 ───────────────────────────────────────────────────────────────
# 没有密钥就不启动：relay 会把整个管理台（轮换 API Key、导入账号凭据、
# 改出口）交给任何能访问该端口的人。宁可没有管理页面，也不裸奔。
if [ -n "$RELAY_KEY" ]; then
  echo "启动管理转发：0.0.0.0:${RELAY_PORT} → 127.0.0.1:${PORT}"
  OFM_RELAY_KEY="$RELAY_KEY" OFM_RELAY_PORT="$RELAY_PORT" OFM_RELAY_TARGET="$PORT" \
    node "$RELAY_SCRIPT" --port "$RELAY_PORT" --target "$PORT" --data-dir "$DATA_DIR" &
  RELAY_PID=$!
else
  echo "OFM_RELAY_KEY 未设置：不启动管理转发。管理页面只能在容器内访问" >&2
  echo "（用 docker exec 进入容器，或把 18900 转发到本机回环）。" >&2
  RELAY_PID=""
fi

# ── 独立服务 ───────────────────────────────────────────────────────────────
# 服务只接受 --port / --data-dir / --no-refresh / --probe / --lan /
# --no-lan / --lan-port。这里补上默认的端口与数据目录，其余参数原样透传，
# 用户仍然可以用 `docker run ... <image> --no-lan` 覆盖。
node "$APP_DIR/packages/standalone/cli.mjs" --port "$PORT" --data-dir "$DATA_DIR" "$@" &
SERVICE_PID=$!

# 任何一个进程退出，容器就退出：让编排器（compose / k8s）去重启它，
# 而不是留下一个只剩一半功能的容器在跑。
# 服务是主角，relay 只是它的附属；relay 挂了就重启整个容器，而不是
# 让一个没有管理页面的容器继续跑着。
cleanup() {
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null || true
  kill "$SERVICE_PID" 2>/dev/null || true
}
trap cleanup INT TERM

if [ -n "$RELAY_PID" ]; then
  # 等两个进程里先退出的那个。
  #
  # 不用 `wait -n`：那是 bash 扩展，而容器里的 /bin/sh 是 dash，不支持
  # （"wait: Illegal option -n"）。用一个轮询循环代替：每次 sleep 后检查
  # 两个 PID 是否还活着。容器里没有事件通知机制可依赖，轮询足够——两个
  # 进程的存活状态由 kill -0 判断，间隔 1 秒对容器编排来说足够快。
  while kill -0 "$SERVICE_PID" 2>/dev/null && kill -0 "$RELAY_PID" 2>/dev/null; do
    sleep 1
  done
else
  wait "$SERVICE_PID"
fi
cleanup
