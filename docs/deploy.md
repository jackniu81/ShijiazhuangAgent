# 部署与运维(deploy)

> 现势文档 · 对应 issue #36。镜像层见 `Dockerfile`,编排见 `docker-compose.yml`(CI 流水线见下文第 5 节说明)。
> LLM 相关环境变量与选型见 [llm-providers.md](./llm-providers.md),质量回归见 [eval.md](./eval.md)。

## 1. 部署形态:一个容器就够

本项目是**单源托管**架构:NestJS 启动时托管 `client/dist`(SPA + 静态资源),REST 走 `/api`,WebSocket 走同一端口的 `/agent` namespace(path `/ws`)。

- 镜像内含 server + client,**没有独立前端容器,也不需要 nginx 反代**
- 语料 `data/` 已打进镜像,同时支持只读卷覆盖(换语料不必重建)
- RAG 索引在进程内存构建(启动日志 `RAG 索引就绪:N 个切块`),向量/会话持久化尚未落地(#29),因此**重启即重建,无需数据卷**

## 2. 三种起法

### 2.1 本地开发(不用 Docker)

```powershell
npm ci
npm run dev          # server(watch) + client(vite) 并起,前端 5173 代理到 3000
```

### 2.2 单镜像

```powershell
docker build -t shijiazhuang-agent .
docker run --rm -p 3000:3000 -e LLM_PROVIDER=mock shijiazhuang-agent
# 接真实模型:加 -e LLM_PROVIDER=siliconflow -e SILICONFLOW_API_KEY=sk-xxx
curl http://localhost:3000/api/version   # 验收
```

### 2.3 Compose(推荐)

```powershell
copy .env.docker.example .env.docker     # 按需填 Key
docker compose --env-file .env.docker up -d --build
docker compose ps ; docker compose logs -f app
```

可选组件用 profile 开关,不启用时不占资源:

| 命令 | 作用 |
|------|------|
| `--profile llm-local` | 追加本地 Ollama;首次需 `docker compose exec ollama ollama pull qwen2.5:7b` 与 `... pull bge-m3` |
| `--profile db` | 追加 pgvector(postgres);**代码尚未接入**,为 #29 预留网络/卷/健康检查 |

配置注入只走一条通道:`--env-file` 的值经 compose 插值进各服务 `environment`。文件里刻意不使用 `env_file:` 指令——compose 语义下 `environment` 优先级更高,同名时用户填的 Key 会被文件默认值顶掉。

## 3. 关键环境变量

完整清单与注释见 `.env.docker.example`,常用:

| 变量 | 默认 | 说明 |
|------|------|------|
| `LLM_PROVIDER` | `mock` | `mock`/`siliconflow`/`ollama`;缺 Key 时自动回退 mock 并打 warn |
| `LLM_TIMEOUT_MS` | `180000` | 免费池慢模型首 token 可达分钟级,勿轻易调小 |
| `SILICONFLOW_CHAT_MODEL` | `Qwen/Qwen2.5-7B-Instruct` | 实测最快 `THUDM/GLM-4-9B-0414`(见 llm-providers.md 基准表) |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | 容器内服务名;连宿主机 Ollama 改 `http://host.docker.internal:11434` |
| `DATA_DIR` | 镜像内 `/app/data` | 语料目录,compose 已用只读卷覆盖 |
| `APP_PORT` | `3000` | 宿主映射端口 |
| `WS_TOKEN` | 空(不鉴权) | Socket.IO 连接鉴权静态 token(issue #61),见下文第 3.1 节 |

### 3.1 连接鉴权(issue #61,R1)

`/agent` namespace 握手段校验静态 Bearer token:server 读 `WS_TOKEN`,client 连接时经 `client.auth.token` 携带(构建期 `VITE_WS_TOKEN` 注入)。两者必须一致,否则握手被拒、界面显示"未授权"。

- **留空 = 不鉴权**:开发默认,启动日志会打 warn 提醒;公网部署必须设置为随机字符串(`openssl rand -hex 24` 之类)
- **Docker 是构建期烘焙**:compose 已把 `WS_TOKEN` 同时传给 build arg(client)与容器 environment(server),改 token 后需 `up -d --build` 重建镜像才生效
- **本地开发**:server 用 `server/.env` 的 `WS_TOKEN`,client 复制 `client/.env.example` 为 `client/.env.local` 填同名值(两侧都重启/重跑 vite)
- **定位**:浏览器端 token 必然可见,这层只防"任何人连上来刷 LLM 额度",不是访问控制;真正的用户体系(JWT)待用户系统再议(见 issue #61)

## 4. 运维动作

```powershell
docker inspect --format '{{.State.Health.Status}}' shijiazhuang-agent-app   # 健康状态(healthcheck 探活请求打在 /api/version)
docker compose logs --tail=200 app
docker compose up -d --build            # 升级:重建并热替换
docker compose down                     # 停容器,保留命名卷
```

回滚:compose 本身没有 rollback 概念,做法是用旧镜像 tag 重新 `up`(因此建议 CI 推 registry 并固定 tag,不只用 latest)。

- 日志:json-file 驱动,`max-size 10m / max-file 5`,不会撑爆磁盘
- 进程:容器以非 root `node` 用户运行,`restart: unless-stopped`
- 健康检查在 `Dockerfile` 声明(compose/K8s 复用),容器 unhealthy 时优先看 `logs` 里的 RAG 索引与 LLM provider 启动行

## 5. 上线前必须补的口子(尚未实现)

issue #36 范围里的会话上限、对话日志看板,以及 MS-005 的剩余 blocker 还没做:

- **CI 流水线**:`build-test` + `docker` 两个 job 的配置已写好,但推送被 GitHub 拒绝——当前 Personal Access Token 缺少 `workflow` scope,不允许创建/更新 `.github/workflows/*`。给 token 补权限后单独 PR 入库
- #29 pgvector 持久化(启用后把 compose 的 postgres 转为 app 默认依赖)
- 对话日志采集与效果看板

已落地的上线项:
- ✅ #61 Socket.IO 连接鉴权——`WS_TOKEN` 配置见第 3.1 节(公网部署务必设置)
- ✅ #62 WebSocket 请求限流——阈值 `WS_MAX_CONCURRENT_PER_SESSION` / `WS_RATE_LIMIT_PER_WINDOW`,默认宽松
- ✅ #59 plan JSON 校验加固——模型输出先过 zod schema,不合法带错误原因回炉重试 1 次,仍失败只发可读 `LLM_ERROR`;格式漂移计数看日志行 `plan 输出格式校验未通过`

**在 `WS_TOKEN` 未设置之前,当前编排仍只适合内网/演示,不建议直接公网暴露。**

## 6. 质量回归与容器的配合

镜像内 `socket.io-client` 属 devDependency(运行镜像已剔除),所以金标评估在**宿主机**跑,指向容器:

```powershell
docker compose up -d                       # 被测系统
npm run build -w server                    # 产出 server/dist/eval
node server\dist\eval\eval.main.js --url http://localhost:3000/agent
```

详见 [eval.md](./eval.md)。

## 7. 本套编排的验证状态

- ✅ `docker compose config`(含两个 profile)语法校验通过
- ✅ `--profile db up -d postgres` 实跑到 `healthy`(踩过 pg18+ 挂载点约定变更:需挂 `/var/lib/postgresql`,已在 compose 注释留痕)
- ⏳ app 镜像构建与容器冒烟:**本机无法访问 Docker Hub**(`node:24-alpine` 拉取超时),交由 GitHub Actions 的 `Docker image smoke` job 首跑验证
- ⏳ `--profile llm-local` 的 Ollama 容器同理待网络可用环境验证;本地非容器 Ollama 的全链路实测数据见 llm-providers.md
