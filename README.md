# 石家庄旅游助手 AI Agent

基于 LangGraph + RAG + LLM 的石家庄旅游智能助手，支持**行程规划**和**自由问答**两种模式。

## 核心功能

按**业务能力**（非代码包/技术组件）划分，每项功能均有独立业务入口与业务边界：

| # | 功能 | 业务入口 | 一句话理由（独立入口 + 业务边界） |
|---|-----------|---------|--------------------------------|
| 1 | **行程规划** | WS `plan:create`，回推 `plan:progress` / `plan:day` / `plan:result` | 用户填天数、兴趣偏好即可单独获得逐日流式行程，有专属状态图(retrieve → planStep → refine → done)与专属表单/卡片组件，业务边界完整 |
| 2 | **自由问答** | WS `chat:ask`，回推 `chat:token` / `chat:done` | 多轮自然语言咨询可单独对外提供答疑能力，有独立的状态图(retrieve → generate)与历史上下文携带，与行程规划职责不同 |
| 3 | **任务管控** | WS `task:cancel` + 统一错误事件 `app:error` | 流式生成可随时中断(按 requestId 取消/abort)，异常统一收敛为错误契约并支撑前端一键重试，是跨两条业务链路的独立管控能力 |
| 4 | **会话服务** | 连接建立与 sessionId 契约(客户端 sessionStorage 持久化) | 独立管理多轮会话生命周期：会话创建/恢复、历史上下文携带、TTL 清理、IP+会话双维度限流(#62)与连接鉴权(#61)，去掉它多轮能力即失效 |
| 5 | **旅游知识库** | `data/` 6 分类 21 篇语料 + front-matter 元数据，启动时自动构建索引 | 景点/美食/酒店/交通/线路/特产是独立运营的业务数据资产，有专属内容结构与时效规范，单独支撑所有业务链路的领域知识供给 |
| 6 | **运维支持** | HTTP `GET /version` + 连接状态契约 | 向外部提供版本探测与部署运维能力，有独立 Controller，与对话业务完全正交 |

**技术支撑层（不计为业务功能）**：前端客户端(交互层)、`packages/shared`(WS 契约类型)、RAG 检索引擎(BM25+向量+RRF，为 #1/#2/#5 服务的算法实现)、LLM Provider 抽象(mock/siliconflow/ollama，模型接入实现)、LangGraph(图编排框架)。

## 架构

```
┌──────────────────┐   WebSocket (Socket.IO)    ┌───────────────────────────┐
│  Client (React)  │ ◄────────────────────────► │  Server (NestJS)          │
│  ChatWindow      │   /agent namespace /ws     │  AgentGateway             │
└──────────────────┘                            │  AgentService + 会话历史   │
                                                │  LangGraph(chat/plan 图)  │
                                                │  prompts/ 模板目录          │
                                                │  RAG(向量+BM25 混合检索)   │
                                                │  LLM(mock/siliconflow/    │
                                                │       ollama)             │
                                                └───────────────────────────┘
```

## 功能

- 📋 **行程规划**:填写天数、兴趣偏好 → 逐天流式生成行程卡片
- 💬 **自由问答**:多轮对话，支持历史上下文携带
- ⏹ **停止生成**:流式输出中可随时中断
- ⚠️ **错误提示 + 一键重试**:LLM/RAG 异常时自动 toast 提示，支持重试
- 🔄 **断线自动重连**:Socket.IO 内置重连机制
- 💾 **Session 持久化**:刷新页面保持对话会话（客户端 sessionStorage 存会话 ID；服务端会话历史当前为进程内内存 Map，服务重启后不保留，持久化归属 #29，一致性维护约定见 [#84](https://github.com/jackniu81/ShijiazhuangAgent/issues/84)）

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量(可选，默认 LLM_PROVIDER=mock 无需任何 key)
cp server/.env.example server/.env

# 前后端并行启动(server :3000 / client :5173)
npm run dev

# 或单独启动
npm run dev -w server
npm run dev -w client   # vite 代理 /ws 到 server

# 运行单元测试:server jest / client vitest
npm run test -w server
npm run test -w client
```

## 生产构建

```bash
npm run build             # 根脚本:依次构建 client + server
node server/dist/main.js  # server 同端口托管 client/dist,单源部署(WebSocket /ws 同源)
```

## 容器部署

```bash
docker compose up -d --build   # 一个镜像含 server + client,暴露 :3000
```

镜像分层、可选 Ollama/postgres profile 与上线待补清单见 [docs/deploy.md](docs/deploy.md)。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `LLM_PROVIDER` | `mock` | `mock` \| `siliconflow` \| `ollama` |
| `SILICONFLOW_API_KEY` | - | 选 siliconflow 时必填 |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | 本机 ollama serve |
| `RAG_HYBRID` | `1` | BM25+向量混合检索开关,`0` 退回纯向量 |
| `CHAT_HISTORY_TURNS` | `6` | 多轮对话携带的历史轮数 |

完整列表见 [server/.env.example](server/.env.example)。

## 知识库

本地 markdown 语料，启动时自动构建索引（向量 + BM25 双路，RRF 融合 + tag/region rerank）：

```
data/                          # 共 21 篇
├── attractions/   # 景点(10 篇) — 隆兴寺、正定古城、天桂山、驼梁…
├── food/          # 美食(5 篇) — 牛肉板面、正定八大碗、无极饸饹…
├── hotel/         # 酒店(1 篇) — 市区推荐分档
├── transport/     # 交通(1 篇) — 地铁 + 公交 + 旅游专线
├── routes/        # 推荐线路(2 篇)
└── specialties/   # 特产(2 篇) — 赞皇大枣、赵县雪花梨
```

所有文档统一 front-matter（title / tags / region），支持 rerank 按分类和地区过滤。

## 文档

**现势文档**（持续维护）

| 文件 | 说明 |
|------|------|
| [docs/api-spec.md](docs/api-spec.md) | WebSocket API 规范（Server / Client 契约） |
| [docs/llm-providers.md](docs/llm-providers.md) | LLM Provider 切换 / 环境变量 / 回退降级策略 / 端到端验收记录 |
| [docs/deploy.md](docs/deploy.md) | 部署与运维：镜像 / Docker Compose / 环境变量 / 上线待补清单 |
| [docs/roadmap.md](docs/roadmap.md) | **今后发展规划**：pgvector 选型 / 真实 LLM / 差异化策略 / 里程碑 MS-005、MS-006 |

**📦 已归档**（docs/archive/，历史设计/评审快照，仅供追溯，当前状态以代码为准）

| 文件 | 说明 |
|------|------|
| [archive/server-spec.md](docs/archive/server-spec.md) | Server 设计蓝图（Task #2 时期） |
| [archive/ui-spec.md](docs/archive/ui-spec.md) | Client UI 规范（Task #3 时期，实现已超出） |
| [archive/code-review.md](docs/archive/code-review.md) | MVP 代码 Review 快照（2026-09-25） |

## 项目结构

```
packages/shared/              # @shijiazhuang-agent/shared — WS 契约类型唯一来源 (#48)
server/                       # NestJS 12 + LangGraph 后端
├── src/agent/
│   ├── agent.gateway.ts      # WebSocket 网关 (/agent namespace /ws path) + 单测
│   ├── agent.service.ts      # 编排 chat/plan 两张 LangGraph 图 + 单测
│   ├── graph/                # chat.graph + plan.graph + nodes(含 plan:day 流式)
│   ├── prompts/              # chat.prompt + plan.prompt 模板
│   ├── rag/                  # BM25 + 向量混合检索,RRF 融合 + rerank
│   ├── chat/                 # session.store 会话历史（进程内内存 + TTL 自动清理，重启不保留，持久化属 #29）
│   └── llm/                  # Provider 抽象:mock / siliconflow / ollama
└── 单测: jest 17 suites / 140 tests
client/                       # React 19 + Vite + Tailwind CSS 4 前端
└── src/
    ├── components/
    │   ├── ChatWindow.tsx    # 主容器 — socket 监听 + 渲染
    │   ├── chat.reducer.ts   # 状态机(17 种 action)独立可测 (#49)
    │   ├── Layout.tsx        # sticky Header + Main + Footer(输入区 slot)
    │   ├── ConnectionStatus.tsx   # 连接状态指示器
    │   ├── MessageList.tsx   # 消息滚动列表
    │   ├── MessageItem.tsx   # user / assistant(text/plan) / system 渲染
    │   ├── PlanCard.tsx      # 行程卡片(逐日流式占位 → 完整渲染)
    │   ├── StreamingText.tsx # 打字机效果 + 闪烁光标
    │   └── PlanningForm.tsx  # 行程规划表单
    ├── lib/
    │   ├── socket.ts         # Socket.IO 单例(connect/on/emit + 重连)
    │   └── types.ts          # re-export shared 包 + Client 侧 UI 消息模型
    └── test/                 # Vitest + @testing-library/react (43 tests)
data/                         # RAG 知识库语料(21 篇 markdown,6 分类)
docs/                         # 现势: api-spec / roadmap;archive/: 已归档历史快照
```

**技术栈**: NestJS 12 · @langchain/langgraph · Socket.IO · React 19 · Vite 8 · Tailwind CSS 4 · Jest(server) · Vitest(client)

## 任务进度

**MS-001 问答系统 / MS-002 行程规划 / MS-003-004 工程收尾 — 已完成**

- [x] Server: LangGraph 双图 + RAG 混合检索 + 会话历史 + SiliconFlow/Ollama Provider + 逐天流式 plan:day
- [x] Client: ChatWindow + PlanningForm + 全组件 + 断线重连 + 错误 toast + 一键重试 + sessionId 持久化
- [x] 工程: @shijiazhuang-agent/shared 类型包 + server 140 / client 43 单测 + 21 篇分类语料

**进行中里程碑**（详情见 [docs/roadmap.md](docs/roadmap.md)）

- [**MS-005 上线基线**](https://github.com/jackniu81/ShijiazhuangAgent/milestone/5)：#27 真实 LLM 验收 · #29 pgvector 持久化 · #36 Docker · #58 金标评估集 · #59 JSON 校验 · #60 降级链 · #61 鉴权 · #62 限流
- [**MS-006 差异化闭环**](https://github.com/jackniu81/ShijiazhuangAgent/milestone/6)：#30 行程编辑导出 · #31 实时数据 · #32 地图 · #63 行程校验节点 · #64 语料时效 · #65 分享链接 · #66 对比评估报告
- **MS-999 观察项**：#33 长期记忆个性化 · #35 多语言语音
