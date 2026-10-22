# Our Free Model — Docker 容器化（独立本地服务）

把 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 的
**独立本地服务**（standalone）封装成 Docker 容器，并让镜像随上游仓库自动更新。

- 上游仓库：<https://github.com/Ebony-Vinyl/dsh-our-free-model>
- 本仓库（fork）：<https://github.com/urarattas/docker-our-free-model>
- 镜像：`ghcr.io/urarattas/docker-our-free-model`

本容器**只**运行独立服务（`packages/standalone`），不依赖 DSH 内核、Cordis
或任何宿主凭据库。DSH 插件那一半（`index.js` / `client.js` / `adapter/`）不
进镜像。

---

## 1. 快速开始

```bash
docker run -d --name ofm \
  -v ofm-data:/data \
  -p 18901:18901 \
  ghcr.io/urarattas/docker-our-free-model:latest
```

或用 compose：

```bash
cd docker
docker compose up -d
docker compose logs -f
```

首次启动后取密钥：

```bash
docker compose exec ofm cat /data/settings.json
```

里面的 `forwardKey` 是**本机 API Key**，`standaloneLanKey` 是 **LAN 推理中继
的 Key**。容器外部的推理客户端用后者。

```bash
# 列出模型
curl -H "Authorization: Bearer $LAN_KEY" http://192.168.1.10:18901/v1/models

# 对话
curl -H "Authorization: Bearer $LAN_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"你好"}]}' \
     http://192.168.1.10:18901/v1/chat/completions
```

---

## 2. 端口与可达性（重要）

独立服务的设计是**只监听回环地址**：管理页面、账号凭据、API Key 都属于本机。
容器把这个回环监听器放进了容器网络，所以对外的可达性分两档：

| 端口 | 绑定 | 容器外可达 | 内容 |
| --- | --- | --- | --- |
| `18900` | `127.0.0.1`（容器内回环） | ❌ | 本机管理端口：管理页面、`/api/management/*`、本机 API（`forwardKey`） |
| `18901` | `0.0.0.0` | ✅ | **LAN 推理中继**：只放行 5 条 `/v1/*` 推理路径 |

LAN 中继的边界（已实测）：

- 放行 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`、
  `POST /v1/messages`、`POST /v1/messages/count_tokens`（含无 `/v1` 前缀写法）；
- **不放行** `/`、`/health`、页面资源、任何管理路径——未鉴权的存活探针等于
  向整个子网宣告"这台机器正在代理"；
- 使用**独立的** `standaloneLanKey`，与本机 `forwardKey` 互不通用：本机 Key
  泄露只需轮换本机那一把，LAN Key 泄露只需轮换 LAN 那一把；
- `/health` 在本机端口上是免鉴权的，在 LAN 中继上不是。

**管理页面在容器外打不开，这是上游明确记录为"未实现"的部分**（issue #216
"standalone 容器化支持"仍是 open 状态），不是本镜像的缺陷。上游原文：

> issue #216 的 Docker / FPK / NAS 远程管理部署仍未实现：管理监听器和 Host
> 信任围栏仍限 loopback，不支持 `--host`、`OFM_ALLOW_NON_LOOPBACK` 或
> `OFM_TRUSTED_HOSTS` 放宽管理访问。容器映射中继端口可供已配置的推理客户
> 端连接，但不能据此从 LAN 打开管理页。

想在容器外使用管理页面，两条路：

1. **端口转发到容器回环**（适合临时操作）：
   ```bash
   docker run -d -p 127.0.0.1:18900:18900 -v ofm-data:/data <image>
   # 启动日志里会打印一次性管理登录链接
   docker compose logs ofm | grep 管理页面
   ```
2. **`docker exec` 进容器**：管理页面与 API 在容器内始终可用。

---

## 3. 镜像里有什么

镜像只装独立服务真正会读的文件，由
[`scripts/collect-standalone-runtime.mjs`](scripts/collect-standalone-runtime.mjs)
**从源码算出来**，而不是手写清单：

- `packages/standalone/` —— 服务本体、`web/` 前端构建产物、渠道 worker；
- `src/` —— 共享核心（模型清单、转发、流解析、路由、Token 压缩…）；
- `vendor/channel-pack/` —— 账号渠道包（含 WASM 与许可文件）；
- `LICENSE`。

**没有**构建步骤，也**没有** npm 依赖：独立服务是纯 Node 程序，零第三方依赖。

为什么用脚本算而不是手写清单：手写清单会在上游新增一个模块时静默失效——
镜像少带一个文件，构建照样成功，服务在运行时才报模块找不到。脚本每次构建
都从源码重新算闭包，缺文件会**让构建失败**，而不是留到运行时。

> 附带的 vendor/channel-pack 是一份 2.7 MB 的**生成产物**，其注释里保留了
> 原始 TypeScript 的 JSDoc 类型标注。那些标注里的 `import('./client.js')` 是
> 类型引用，不是真���导入。收集脚本因此在扫描前先剥掉注释，并把匹配锚定在
> 语句起始处——否则一条跨字符串的贪婪匹配会把错误消息的尾巴当成依赖名。

镜像约 8 MB 的应用文件 + Node 24 运行时。

---

## 4. 上游更新 → 镜像更新

这是本仓库的核心机制。答案是**两条独立的自动化链路**：

```
                    ┌──────────────────────────────────────────┐
上游 main 有新提交  │                                          │
   │                │  ① sync-upstream.yml（每天 03:43 UTC）    │
   │                │     main   ← 快进到 upstream/main         │
   ▼                │     docker ← rebase 到新的 main 之上      │
upstream/main       │                        │                  │
   │                │                        │ dispatch         │
   │                │                        │ （仅当上游确有    │
   │                │                        │  新提交时）      │
   │                │                        ▼                  │
   │                │  ② build-image.yml（每天 03:17 UTC）       │
   │                │     检出 upstream/main（最新上游源码）      │
   │                │     + 叠加本仓库 docker/（容器化文件）      │
   │                │     → 构建 amd64 + arm64 → 推 GHCR         │
   │                │                        │                  │
   │                │                        ▼                  │
   │                │     ghcr.io/urarattas/docker-our-free-model │
   │                │        :latest / :2.5.8 / :upstream-<sha> │
   └────────────────┴──────────────────────────────────────────┘
```

> **当前状态**：本仓库的改动**只做本地提交**，不推送到 GitHub，所以这两条
> 工作流目前不会自动运行。它们的逻辑与
> [`scripts/sync-upstream-local.sh`](scripts/sync-upstream-local.sh) 一致，
> 而那个脚本是本地跑的——见第 6 节。工作流文件保留在仓库里，是为了将来
> 决定推送时可以直接用。

### 为什么要两个分支

| 分支 | 内容 | 作用 |
| --- | --- | --- |
| `main` | **纯上游内容**，我们一个字节都不改 | 保持与上游完全一致，`git diff main upstream/main` 永远为空；GitHub 上的 "behind N commits" 提示消失；出问题时能直接对照上游 |
| `docker` | 上游内容 **+** 我们的容器化文件 | 实际工作的分支，镜像与工作流都从这里运行 |

`docker` 分支是本仓库的**默认分支**，这样工作流文件才在默认分支上、定时
任务才会跑（GitHub 只在默认分支上执行 `schedule`）。

### 镜像构建为什么要单独检出上游

`build-image.yml` **不使用**本仓库的任何分支作为源码，而是：

```yaml
- uses: actions/checkout@v4
  with:
    repository: Ebony-Vinyl/dsh-our-free-model   # ← 上游
    ref: main
    path: upstream
```

然后把本仓库的 `docker/` 复制进去再构建。好处是**两条链路互不依赖**：

- 即使 `docker` 分支还没同步完，镜像已经是上游的最新代码；
- 不需要在本仓库里做合并，也不会产生合并冲突。

> **注意**：`build-push-action` 的 `context` 必须是路径（`upstream`），不能
> 用默认的 Git 上下文。BuildKit 在 Git 上下文下会自己重新 clone 仓库，前一步
> 的复制结果会被完全忽略——这是这个模式最容易踩的坑。

### 标签规则

| 标签 | 含义 |
| --- | --- |
| `:latest` | 上游最新构建 |
| `:2.5.8` | 上游 `package.json` 的版本号 |
| `:upstream-3b78248` | 上游提交短 SHA |
| `:sha-3b78248...` | 上游提交完整 SHA |

版本号取自**上游根 `package.json`**（与上游 git tag 一致）。注意
`packages/standalone/package.json` 的版本号会滞后于根 `package.json`
（当前是 2.5.4 vs 2.5.8）——独立服务的版本号以根为准。

### 首次启用（一次性）

fork 里的**定时任务默认是关闭的**，GitHub 文档明确写了
"scheduled workflows are disabled by default" in a fork。所以必须手动开：

1. 打开仓库 → **Actions**；
2. 找到 `sync-upstream` 和 `build-image`，点 **Enable workflow**；
3. 第一次也可以直接点 **Run workflow** 手动跑一遍。

首次推送到 GHCR 后，镜像包默认是私有的，需要在
**Packages → docker-our-free-model → Package settings** 里改成 **Public**，
否则别人 `docker pull` 会 401。

### 手动触发

```bash
# 在 GitHub Actions 页面点 Run workflow
# 或者用 API：
gh workflow run build-image --repo urarattas/docker-our-free-model
gh workflow run sync-upstream --repo urarattas/docker-our-free-model
```

---

## 5. 客户端接入

把 base URL 指向 LAN 中继，用 `standaloneLanKey`：

**OpenAI SDK**
```python
from openai import OpenAI
client = OpenAI(base_url="http://192.168.1.10:18901/v1", api_key=os.environ["OFM_LAN_KEY"])
print(client.chat.completions.create(model="mimo-v2.6-flash-free",
      messages=[{"role": "user", "content": "你好"}]).choices[0].message.content)
```

**Claude Code**
```bash
export ANTHROPIC_BASE_URL=http://192.168.1.10:18901
export ANTHROPIC_API_KEY=$OFM_LAN_KEY
```

**Codex**
```toml
# ~/.codex/config.toml
model_provider = "ofm"
model = "mimo-v2.6-flash-free"

[model_providers.ofm]
name = "Our Free Model"
base_url = "http://192.168.1.10:18901/v1"
env_key = "OFM_LAN_KEY"
```

**curl**
```bash
curl http://192.168.1.10:18901/v1/chat/completions \
  -H "Authorization: Bearer $OFM_LAN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"你好"}]}'
```

---

## 6. 本地使用（本仓库当前的工作方式）

本仓库的改动目前**只做本地提交**，不推送到 GitHub：`origin` 的 push URL 被
置为 `DISABLED://local-only-no-push`，任何 `git push` 都会被拒绝。

同步上游用本地脚本，它与 `.github/workflows/sync-upstream.yml` 是同一套逻辑：

```bash
sh scripts/sync-upstream-local.sh
```

它做四件事：

1. `git fetch upstream main`；
2. 把 `main` 快进到 `upstream/main`（`main` 上只允许上游的提交）；
3. 把 `docker` 分支 rebase 到新的 `main` 之上（我们自己的提交只有一条，
   所以 rebase 几乎不会冲突）；
4. 重新计算容器运行时闭包，并打印构建镜像的命令。

**不推送**（默认）。要推送到自己的 fork：

```bash
sh scripts/sync-upstream-local.sh --push
```

> 需要先把 `origin` 的 push URL 恢复：
> `git remote set-url --push origin https://github.com/urarattas/docker-our-free-model.git`

只重建镜像、不动分支：

```bash
sh scripts/sync-upstream-local.sh --build-only
```

### 分支职责

| 分支 | 内容 | 规则 |
| --- | --- | --- |
| `main` | 纯上游内容 | 只接受快进，不接受我们自己的提交 |
| `docker` | 上游内容 + 容器化文件 | 每次同步后 rebase 到新的 `main` 之上 |

`docker` 分支上的我们自己的提交只有一条
（"Add Docker packaging for the standalone service"），所以同步时的 rebase
几乎不会产生冲突；真冲突了脚本会让 rebase 停在原地并报错，不会留下
带冲突标记的提交。

---

## 7. 从源码构建

```bash
git clone https://github.com/urarattas/docker-our-free-model.git
cd docker-our-free-model
git checkout docker
docker build -f docker/Dockerfile -t ofm:local .
```

构建上下文是**仓库根目录**（要取 `src/`、`vendor/`、`packages/standalone/`），
所以 `-f` 指向 `docker/Dockerfile`，但路径是 `.`。

本地验证闭包是否正确（不需要 Docker）：

```bash
node scripts/collect-standalone-runtime.mjs /tmp/ofm-runtime
node /tmp/ofm-runtime/packages/standalone/cli.mjs --port 18900 --data-dir /tmp/ofm-data
```

---

## 8. 数据与升级

数据卷 `/data` 里是全部状态：

| 文件 | 内容 |
| --- | --- |
| `settings.json` | API Key、LAN Key、服务设置（0600） |
| `channel-credentials.json` | 账号渠道凭据 |
| `channel-pack/` | 账号池、积分、账本 |
| `eac-user.json` | EAC 授权 |
| `stats.json` | 用量统计 |

升级镜像：

```bash
docker compose pull && docker compose up -d
```

数据卷不受影响，API Key、账号与统计都保留。反过来，**换机器**时把数据卷
带走即可（`docker run -v /旧路径:/data`）。

回滚：把标签钉回旧版本即可。

```bash
docker compose down
docker run -d --name ofm -v ofm-data:/data -p 18901:18901 \
  ghcr.io/urarattas/docker-our-free-model:2.5.7
```

---

## 9. 已知边界

- **管理页面在容器外不可达**——上游 issue #216 未实现，见第 2 节。
- **容器内账号 OAuth 登录需要浏览器**。上游 README 明确写着"没有提供容器内
  账号 OAuth 登录适配"：Gemini、Cline 等渠道的登录流程要在**本机**完成，
  然后把账号备份手动导入到容器里的独立服务（网页 → 免费账号渠道 → 供应商
  与备份）。匿名免费车道与 Kilo 免费池不需要登录，容器起来即可用。
- **登录终端取令牌不可用**。管理页的"本机打开终端取令牌"按钮依赖 Windows /
  macOS 的桌面程序，容器里没有；改用 `docker compose exec ofm cat
  /data/settings.json` 取 `forwardKey`。
- **同一数据目录只能跑一个实例**。服务用 `service.lock` 互斥，容器里挂了
  同一卷的第二个实例会直接报错退出。
- **免费额度按会话计**。上游按 session 统计速率，短时间打满会返回 429。
- **上游可用性不由本镜像保证**。免费车道的模型清单与额度由 OpenCode 与
  Kilo 的公共网关决定，随时可能变化。
- **本镜像不是上游的官方发布物**，也不复现上游的签名发布流程。上游的
  `feed/manifest.json` 由 Ed25519 私钥签名，私钥不在仓库里。

---

## 10. 许可

本仓库的容器化文件（`docker/`、`scripts/collect-standalone-runtime.mjs`、
`.github/workflows/`）随上游的 MIT 许可分发。上游项目：
<https://github.com/Ebony-Vinyl/dsh-our-free-model>（MIT）。
`vendor/channel-pack/` 的第三方许可见该目录下的 `LICENSE` 与 `NOTICE.md`。
