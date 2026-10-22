#!/bin/sh
# 把本地分支同步到上游仓库，并在需要时重建镜像。
#
# 这个脚本是 .github/workflows/sync-upstream.yml 的本地版本：同样的分支
# 策略、同样的快进与 rebase 逻辑、同样的"上游没变就不重建"的判断。
#
# 用法：
#   sh scripts/sync-upstream-local.sh              # 同步分支（不推送）
#   sh scripts/sync-upstream-local.sh --push       # 同步并推送到 origin
#   sh scripts/sync-upstream-local.sh --build-only # 只重建镜像，不动分支
#
# 本仓库默认只做本地提交：origin 的 push URL 已被置为 DISABLED，
# 所以不带 --push 时不会有任何东西离开这台机器。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

UPSTREAM_REPO="Ebony-Vinyl/dsh-our-free-model"
PUSH=0
BUILD_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    *) echo "未知参数：$arg" >&2; exit 1 ;;
  esac
done

log() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ── 取回上游 ───────────────────────────────────────────────────────────────
log "1/4 取回上游 ${UPSTREAM_REPO}"
if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "https://github.com/${UPSTREAM_REPO}.git"
fi
git fetch --no-tags upstream main
git fetch --no-tags origin "+refs/heads/*:refs/remotes/origin/*" 2>/dev/null || true

UPSTREAM_SHA=$(git rev-parse upstream/main)
MAIN_SHA=$(git rev-parse main)
echo "upstream/main = ${UPSTREAM_SHA}"
echo "main          = ${MAIN_SHA}"
echo "docker        = $(git rev-parse docker)"

if [ "$MAIN_SHA" = "$UPSTREAM_SHA" ]; then
  CHANGED=false
  echo "上游没有新提交。"
else
  CHANGED=true
  echo "上游有新提交：$(git rev-parse --short upstream/main)"
fi

# ── main 快进 ──────────────────────────────────────────────────────────────
if [ "$BUILD_ONLY" = "0" ]; then
  log "2/4 把 main 快进到 upstream/main"
  if ! git merge-base --is-ancestor main upstream/main; then
    echo "::error:: main 上有不属于上游的提交，无法快进：" >&2
    git log --oneline main ^upstream/main | head -20 >&2
    exit 1
  fi
  if [ "$MAIN_SHA" = "$UPSTREAM_SHA" ]; then
    echo "main 已经与 upstream/main 一致。"
  else
    git checkout main
    git merge --ff-only upstream/main
    if [ "$PUSH" = "1" ]; then
      git push origin main:main
      echo "已推送 main。"
    else
      echo "已快进 main（未推送）。"
    fi
  fi

  # ── docker 分支 rebase ───────────────────────────────────────────────────
  log "3/4 把 docker 分支搬到新的 main 之上"
  git checkout docker
  BASE=$(git merge-base docker main)
  if [ "$BASE" = "$(git rev-parse docker)" ]; then
    git merge --ff-only main
  else
    git rebase --onto main "$BASE" docker
  fi
  if [ "$PUSH" = "1" ]; then
    git push --force-with-lease=docker:"$(git rev-parse origin/docker 2>/dev/null || echo '')" origin docker:docker
    echo "已推送 docker。"
  else
    echo "已更新 docker（未推送）。"
  fi
  git checkout docker
else
  log "2-3/4 跳过分支同步（--build-only）"
fi

# ── 重建镜像 ───────────────────────────────────────────────────────────────
log "4/4 重建容器运行时闭包"
RUNTIME="${TMPDIR:-/tmp}/ofm-runtime"
node scripts/collect-standalone-runtime.mjs "$RUNTIME"
echo "运行时文件已收集到 $RUNTIME"
echo
echo "构建镜像："
echo "  docker build -f docker/Dockerfile -t our-free-model:local ."
echo "（构建上下文是仓库根目录，因为要取 src/、vendor/、packages/standalone/）"

if [ "$CHANGED" = "false" ]; then
  echo
  echo "上游无变化，不需要重新发布镜像。"
fi
