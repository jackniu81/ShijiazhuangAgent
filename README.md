# 石家庄旅游助手 AI Agent

一个把「LLM 只是表达层」落到实处的工作：**LangGraph 双图编排 + 混合检索 RAG + 可替换 Provider 抽象 + 端到端流式契约**，覆盖行程规划与自由问答两条业务链路。

不是「调一次大模型 API 的 demo」——这个仓库里能看到的是工程化处理：结构化输出的容错与回炉、检索的降级与阈值、契约的单一来源、以及 193 + 43 个单测把这些行为都钉住。

## 一览

| 指标 | 数值 |
|------|------|
| 业务代码 | ~4.8k 行 TS（server + client + shared，不含测试） |
| 单元测试 | server **20 suites / 193 tests**（jest）· client **7 files / 43 tests**（vitest） |
| 测试文件 | 21 个，与源码**同目录** colocate（`*.spec.ts`） |
| 领域语料 | 6 分类 21 篇 markdown，启动时自动建索引 |
| LLM 后端 | 3 个可互换 Provider（mock / siliconflow / ollama），一个 env 切换 |
| 向量后端 | 2 个可互换实现（内存 / pgvector），由契约测试锁定可替换性 |
| 部署 | 单镜像（server 同端口托管 client 静态资源，WS 同源）+ Docker Compose 可选 Ollama/postgres |

## 核心能力

按**业务能力**（非代码包/技术组件）划分，每项都有独立业务入口与边界：

| # | 能力 | 业务入口 | 为什么是独立能力 |
|---|------|---------|-----------------|
| 1 | **行程规划** | WS `plan:create` → `plan:progress` / `plan:day` / `plan:result` | 填天数、兴趣即得**逐日流式**行程；专属状态图（retrieve → planStep → refine → done，结构校验与回炉在 plan 节点内）与专属表单/卡片 |
| 2 | **自由问答** | WS `chat:ask` → `chat:token` / `chat:done` | 多轮咨询，独立状态图（retrieve → generate），带历史上下文与追问 query 改写 |
| 3 | **任务管控** | WS `task:cancel` + 统一错误事件 `app:error` | 流式生成按 `requestId` 可中断（透传到 LLM HTTP 层），异常统一收敛为错误契约并支撑前端一键重试 |
| 4 | **会话服务** | 连接建立 + `sessionId` 契约 | 会话创建/恢复、历史携带、TTL 清扫、IP+会话双维度限流（#62）、连接鉴权（#61） |
| 5 | **旅游知识库** | `data/` 语料 + front-matter，启动自动索引 | 独立运营的内容资产（景点/美食/酒店/交通/线路/特产），支撑所有链路的领域知识 |
| 6 | **运维支持** | HTTP `GET /version` + 连接状态契约 | 版本探测与部署运维，独立 Controller，与对话业务正交 |

**技术支撑层**（不计为业务功能）：React 客户端（交互层）、`packages/shared`（WS 契约类型）、RAG 检索引擎（为 #1/#2/#5 服务）、LLM Provider 抽象（模型接入）、LangGraph（图编排）。

## 实现亮点

以下每一条都能在代码里指到具体位置，也都有对应单测。

### 1. 结构化输出：先「容错规整」，再「带原因回炉」（#59 / #87）

真实 LLM 的 JSON 会漂移：被 ```` ```json ```` 包裹、字段为 `null`、`day` 写成 `"1"`、多塞字段。做法是分清**该拦的**和**该修的**：

- `graph/plan.schema.ts` — zod 校验层，`optStr`（缺失/null → 交给 refine 补默认）、`coercedNum`（数字字符串统一收编）。原则写在文件头注释：**类型错必须拦、可规整的小漂移放行**。
- `prompts/plan.prompt.ts#buildPlanRepairMessages` — 校验失败时把**校验器的具体 reasons + 上次输出**回喂给模型做定点修复，而不是重新发挥一次。
- 非流式 `format:'json'` / `response_format` 强约束（#87），流式路径**故意不注入**（会破坏增量返回），spec 里锁死了这个差异。

### 2. 混合检索：避开「两路得分不可比」的坑（#9）

BM25 分数与向量余弦不是同一量纲，加权求和会互相污染。所以用 **RRF（Reciprocal Rank Fusion）**——只看名次不看分值：`Σ 1/(RRF_K + rank + 1)`，`RRF_K = 60`（`rag/fusion.ts`）。再叠一层规则 rerank：query 命中 `tags` 加 `0.015`、命中 `region` 加 `0.01`，让「带老人爬山」「正定有什么」这类带明确标签意图的查询置顶对应语料。

### 3. 向量后端可替换，用契约测试而不是靠约定（#29）

`InMemoryVectorStore`（零依赖、开发默认可跑）与 `PgVectorStore`（`ORDER BY embedding <=> $1::vector`，cosine 距离下推 SQL）实现同一组接口。关键是 `rag/store.contract.spec.ts`：它**固化接口的两半形状**（消费侧 `VectorStore` / 可写侧 `WritableVectorStore`），并用一个只有 `size + searchByText` 的 fake 证明「pgvector 形态的后端确实能被检索流程使用」。这个测试的存在目的是**防止后续 PR 悄悄破坏可替换性**。

BM25 一路刻意留在 TS 内存里算——语料是百篇级，不是瓶颈；只把向量路和 metadata 过滤下沉到 SQL。改动边界收敛在 store 层。

### 4. RAG 不可用时不 500，降级成「无检索模式」（#27）

embedding 模型缺失是本机最常见的状态（`ollama pull bge-m3` 没跑就是没跑）。这种情况**不阻断服务**：`RagService.isDegraded` 置位 → 图节点收到 `deps.ragDegraded` → 回答照常产出、不带 `sources`，并追加明确提示 `(注:本地资料检索暂不可用,以上回答基于模型常识)`（`graph/nodes.ts`）。

同一个分支逻辑还区分了另一种「无资料」：检索阈值把低分文档全部过滤掉（#89）时提示 `(注:未检索到本地资料,...)`——**同样是空结果，原因不同就必须在文案上分开**，否则运营无法判断是语料不够还是阈值调坏了。

### 5. Provider 抽象 + 启动级自愈（#8 / #27）

`mock / siliconflow / ollama` 三家共用 `LLMProvider` 接口，一个 `LLM_PROVIDER` 切换。工程上的价值在两处：

- **mock 是测试与 demo 的基石**——不需要任何 key、不联网就能跑通全链路端到端，193 个 server 单测全部基于它；
- **选错配置不炸启动**（#27）：`LLM_PROVIDER=siliconflow` 但缺 `SILICONFLOW_API_KEY`、或填了非法取值 → 打 warn 并自动回退 mock。开箱即用的成本比「让新手对着 stack trace 猜」低得多。

（运行期的真实故障降级链在途，见 PR #83。）

### 6. 端到端流式取消与错误契约（#26 / #62）

`agent.gateway.ts` 维护 `requestId -> { cancelled, AbortController }`：`task:cancel` 按 id 精确取消，signal 一路透传到 LLM HTTP 请求（`http.ts#composeSignal` 组合「超时 + 外部取消」并能区分两者），请求结束回收登记避免集合泄漏。前端侧 `chat.reducer.ts` 把 13 种 `ChatAction` 抽成纯函数状态机，异常统一收敛为 `app:error` 并支持一键重试——toast、重试、重连都有独立单测。

### 7. 防幻觉做在 prompt 层，并配可回归的证据（#90 / #91 / #88）

- **约束写法**：票价/开放时间/班次**只能引用参考资料明确给出的内容**，未覆盖时必须回答「资料未提及,建议出行前核实」；system prompt 的措辞由 spec 逐字锚定（回归锚点），防止被后续 PR 顺手改软。
- **上下文截断按语义边界**（#91）：`prompts/util.ts#truncateAtBoundary` 优先落在句末标点、退化到逗号级、最后才硬截并加 `…` 标记；`fitDocsToBudget` 逐条装预算，剩余不足最小占比就整条舍弃，避免最后一条被腰斩成残句。
- **追问检索改写**（#88）：只取最近一轮 user 消息拼接改写 query——再多会稀释检索主题，代码里写明了这个取舍。
- **金标评估集**（#58，进行中）：`server/src/eval/dataset/questions.json` 已落 46 例（42 chat + 4 plan，覆盖票价/开放时间/交通/行程约束/抗幻觉等 8 类），断言**要点命中 + 禁止词 + 期望来源**三元组（例如某题禁止出现别的景点票价 `65 元`），杜绝「看起来对」的自评。

### 8. WS 契约单一来源（#48）

`packages/shared/src/agent.types.ts`（115 行）是 server 与 client **唯一**的契约定义，事件名常量 + payload 类型都在里面。此前两侧各维护一份镜像类型、改一处漏一处的做法被彻底移除；`docs/api-spec.md` 明确写了「与代码不一致时以 shared 包为准」。

## 架构

```
┌──────────────────┐   WebSocket (Socket.IO)    ┌────────────────────────────────┐
│  Client (React)  │ ◄────────────────────────► │  Server (NestJS 12)            │
│  ChatWindow      │   /agent namespace /ws     │  AgentGateway  取消/限流/鉴权   │
│  chat.reducer    │                            │  AgentService  会话历史 + 编排  │
│  PlanCard 流式   │                            │  LangGraph     chat / plan 图   │
└──────────────────┘                            │  prompts/      模板 + 截断工具  │
                                                │  RAG           BM25 + 向量 RRF  │
       data/ 21 篇 markdown ──启动建索引──►      │                内存 / pgvector  │
                                                │  llm/          mock|siliconflow │
                                GET /version ◄──│                /ollama 抽象     │
                                                └────────────────────────────────┘
```

## 技术栈

| 层次 | 选型 |
|------|------|
| 语言 | TypeScript 5.7 / 5.8（strict） |
| 后端 | NestJS 12 · Express 5 · Socket.IO 4.8 |
| Agent 编排 | `@langchain/langgraph` 1.4（`StateGraph` + Annotation channels） |
| 校验 | zod 4（plan 输出结构校验与漂移规整） |
| 检索 | 自研：BM25 + 余弦向量 + RRF 融合 + 规则 rerank；pg 侧 `pgvector` 余弦距离 |
| 持久化 | PostgreSQL + pgvector（`pg` 8.23，可切回内存实现） |
| 前端 | React 19 · Vite 8 · Tailwind CSS 4 · socket.io-client |
| 测试 | server jest 30 + ts-jest（colocated spec）· client vitest 5 + Testing Library |
| 部署 | 多阶段 Dockerfile（单镜像托管 server + client 静态资源）· Docker Compose |
| 工程 | npm workspaces（`packages/shared` / `server` / `client`） |

## 快速开始

```bash
npm install

# 默认 LLM_PROVIDER=mock,无需任何 key、离线可跑通全链路
cp server/.env.example server/.env

npm run dev                 # server :3000 / client :5173 并行
npm run test -w server      # 20 suites / 193 tests
npm run test -w client      # 7 files / 43 tests
```

接真实模型：`LLM_PROVIDER=siliconflow` + `SILICONFLOW_API_KEY`，或本地 `ollama serve` + `ollama pull qwen2.5:7b`（embedding 缺模型会自动走无检索降级模式）。

## 项目结构

```
packages/shared/              # WS 契约类型唯一来源 (#48)
server/                       # NestJS 12 + LangGraph 后端(jest 20 suites)
├── src/agent/
│   ├── agent.gateway.ts      # WS 网关:requestId 取消 + 限流 + 鉴权
│   ├── agent.service.ts      # 编排 chat/plan 双图
│   ├── graph/                # 两张图 + nodes + plan.schema(zod 校验/回炉)
│   ├── prompts/              # chat/plan 模板 + util(边界截断、预算装载)
│   ├── rag/                  # bm25 / fusion(RRF+rerank) / store / pg-vector.store / indexer
│   ├── chat/                 # session.store(内存 + TTL)
│   ├── llm/                  # http(重试/超时/取消/流式解析) + 三 Provider + factory
│   └── eval/                 # 金标评估集与类型(#58)
└── src/config/               # configuration.ts:集中默认值 + env 转换 + 非法值兜底
client/                       # React 19 + Vite + Tailwind 4(vitest 43 tests)
└── src/{components,lib,test} # ChatWindow / chat.reducer(13 action 状态机) / PlanCard / socket
data/                         # 知识库语料(6 分类 21 篇 markdown + front-matter)
docs/                         # 见下
```

## 文档

**现势文档**（持续维护）

| 文件 | 说明 |
|------|------|
| [docs/todo.md](docs/todo.md) | **项目进度、剩余任务、优先级与依赖关系**（按代码实测逐条核对） |
| [docs/api-spec.md](docs/api-spec.md) | WebSocket API 规范（Server / Client 契约） |
| [docs/llm-providers.md](docs/llm-providers.md) | Provider 切换 / 环境变量 / 回退降级策略 / 端到端验收记录 |
| [docs/deploy.md](docs/deploy.md) | 部署与运维：镜像 / Compose / 环境变量 / 上线待补清单 |

**📦 已归档**（`docs/archive/`，历史快照，仅供追溯，当前状态以代码与 todo.md 为准）

| 文件 | 说明 |
|------|------|
| [archive/roadmap.md](docs/archive/roadmap.md) | 2026-09-26 发展规划快照（pgvector 选型论证、差异化命题仍有参考价值；里程碑状态已迁至 todo.md） |
| [archive/server-spec.md](docs/archive/server-spec.md) | Server 设计蓝图（Task #2 时期） |
| [archive/ui-spec.md](docs/archive/ui-spec.md) | Client UI 规范（Task #3 时期，实现已超出） |
| [archive/code-review.md](docs/archive/code-review.md) | MVP 代码 Review 快照（2026-09-25） |

## 里程碑与剩余工作

**不在 README 里维护进度。** 已完成范围（MS-001~004 问答与行程双链路、工程化与单测、鉴权限流）见下方一句话概览；**当前进度、剩余任务、优先级、依赖关系与待决策事项，统一在 [docs/todo.md](docs/todo.md)**。

一句话概览：核心链路（plan/chat 双图 + 混合检索 + 三 Provider + 逐日流式）、客户端（编排、断线重连、错误重试）、工程化（shared 契约包、236 个单测、21 篇语料）已落地；MS-005 上线基线与 MS-006 差异化闭环仍有未完成项——具体哪些「看起来完成但实际只完成一半」的坑，todo.md 第一节有核对表。
