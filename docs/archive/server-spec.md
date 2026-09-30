# 石家庄旅游助手 — Server 设计规格

> 本 session 聚焦 Server。本文件是 **task #2(server implement)** 的设计蓝图,覆盖 require.md 6-11 的五点要求,并与 [api-spec.md](../api-spec.md) 的事件契约严格对齐。当前 `agent.service.ts` 为 mock,本文档定义其真实实现形态。
>
> 📦 **已归档**（2026-09-26）:本文档为 task #2 当时的设计快照,所述“真实实现形态”已全部落地(mock/siliconflow/ollama 三 Provider、BM25+向量混合检索、会话历史均已完成);当前状态以代码为准,进度与剩余工作见 [docs/todo.md](../todo.md)。

## 1. 目标与范围

对应 require.md:

| 要求 | 本规格的落点 |
|---|---|
| LangGraph | §3 编排图设计 |
| read memory RAG (local files) | §4 本地文件检索 |
| give travel plan based on inputs | §5.1 行程生成 |
| answer questions | §5.2 问答 |
| LLM: SiliconFlow or Ollama | §6 Provider 抽象 |

范围:仅 server 侧逻辑与依赖;UI 见 task #3。对外接口不变(仍是 api-spec.md 的 WebSocket 事件)。

## 2. 总体架构

```
AgentGateway (ws, 已有)
   │  emit / isCancelled
   ▼
AgentService (编排入口,替换 mock)
   │
   ▼
LangGraph App  ── 状态图:retrieve → plan/generate → refine
   │        │           │
   ▼        ▼           ▼
 RAG      LLM        Prompt
Store    Provider    模板
(本地文件) (SiliconFlow/Ollama)
```

分层原则:
- **Gateway**:只管收发事件、requestId 路由、取消信号,不含业务。
- **AgentService**:构造图、注入依赖、把图执行翻译为 `plan:progress` 等事件。
- **能力模块**:`rag/`、`llm/`、`graph/`、`prompts/` 各自独立、可测、可替换。

## 3. LangGraph 编排

用 `@langchain/langgraph`(JS)。两条独立子图,共享 RAG + LLM 组件。

### 3.1 状态 Schema
```ts
// 行程图
interface PlanState {
  input: PlanCreatePayload['input'];   // days/budget/interests/...
  docs: RetrievedDoc[];                 // RAG 命中
  draftPlan?: TravelPlan;               // plan 节点产出
  plan?: TravelPlan;                    // refine 后终稿
  error?: AppErrorEvent;
}

// 问答图
interface ChatState {
  question: string;
  sessionId: string;
  history: Msg[];        // 多轮上下文(见 §7)
  docs: RetrievedDoc[];
  answer: string;
}
```

### 3.2 图结构

**行程图**(`plan:create`)
```
retrieve ──▶ plan ──▶ refine ──▶ END
   │                     │
   └──────── error ◀─────┘
```
- `retrieve`:query=interests+偏好,取 topK 景点/美食文档
- `plan`:LLM 依据 docs+input 产出 `draftPlan`(结构化 JSON)
- `refine`:校验天数连续性、动线合理性,LLM 或规则修正 → `plan`

**问答图**(`chat:ask`)
```
retrieve ──▶ generate ──▶ END
```
- `generate`:把 docs 作为上下文,LLM **流式** 输出(→ `chat:token`)

### 3.3 与事件的映射(契约不变)
- 每个节点 **进入前** 发 `plan:progress{node,status:'start',message}`,**完成后** 发 `status:'finish'`
- 图节点名与 api-spec 的 `node` 枚举一一对应:`retrieve | plan | refine | done`
- 流式 token 在 `generate` 节点内逐个 emit
- 任一节点抛错 → 捕获转 `app:error`(code 见 §8)

### 3.4 取消与检查点
- 每个节点边界检查 `isCancelled()`;为真则走 `CANCELLED` 终止
- LangGraph checkpointer 预留 thread 级断点(可选,便于恢复),MVP 可先不启用

## 4. RAG(本地文件 / read memory)

### 4.1 数据源
```
data/
  attractions/*.md     # 景点:正定古城、苍岩山、西柏坡...
  food/*.md            # 美食:牛肉板面、正定八大碗...
  routes/*.md          # 现成线路参考
```
每篇 md 头部带 front-matter:`title / tags / region`,供过滤。

### 4.2 索引与检索
- **构建**:启动时(或 `npm run index` 脚本)把 md 切块(chunk ~500 字,重叠 50)→ embedding → **内存向量索引(纯 TS 余弦相似度,已选方案,无需持久化)**;语料变大或冷启动变慢再平滑迁移 sqlite-vss / LanceDB,`search()` 接口不变
- **检索接口**:
  ```ts
  rag.search(query: string, k = 5): RetrievedDoc[]
  // RetrievedDoc = { text, source, score, meta }
  ```
- `source` 回填到 `chat:done.sources`、用于行程 tips 出处
- embedding 走 §6 Provider 的 `embed()`

### 4.3 无重排序的 MVP
先向量 topK 直出;后续可加 BM25 混合 + rerank,不改对外契约。

## 5. 能力实现

### 5.1 行程生成(输入 → TravelPlan)
- 输入:`PlanCreatePayload.input`(days/startDate/travelers/budget/interests/preferences)
- prompt 约束 LLM **只输出符合 `TravelPlan` schema 的 JSON**(用 function/JSON mode)
- 校验:`days.length === input.days`,item 字段合法,否则 refine 修复或报 `INVALID_INPUT`
- 结果 → `plan:result`

### 5.2 问答
- 输入:`ChatAskPayload`(question, sessionId)
- 组装:`system(人设) + history + RAG docs + question`
- 输出:流式 `chat:token`,收尾 `chat:done{answer, sources}`
- 空/超长问题 → `INVALID_INPUT`

## 6. LLM Provider 抽象(SiliconFlow / Ollama)

统一接口,env 切换,业务层不感知具体厂商。

```ts
interface LLMProvider {
  chat(msgs: Msg[], opt?): Promise<string>;          // 非流式
  stream(msgs: Msg[], onToken: (t)=>void, opt?): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;         // RAG 用
}
```

| 实现 | 协议 | 说明 |
|---|---|---|
| `MockProvider` ✅先行 | 无外部依赖 | **本迭代首选**;`chat/stream` 回放固定文案(可配置延时模拟流式),`embed` 返回确定性向量。用于跑通图/RAG/UI 联调 |
| `SiliconFlowProvider` | OpenAI 兼容 HTTP(`api.siliconflow.cn/v1`) | 云端,需 `API_KEY`;chat+embed 全覆盖(后续接入) |
| `OllamaProvider` | 本地 `http://localhost:11434` | 免网免密;chat 用 `chat/stream`,embed 用 `embeddings` 接口(后续接入) |

- 选型由 `LLM_PROVIDER=mock|siliconflow|ollama` 决定(默认 `mock`),工厂 `createLLM()` 返回实例;新增厂商只加一个实现类,业务层零改动
- 两者都用成熟的 OpenAI/Ollama SDK 或直接 fetch;流式统一转成 `onToken` 回调对接 `chat:token`
- **模型名可配**:`SILICONFLOW_CHAT_MODEL` / `OLLAMA_MODEL` 等(§7)

## 7. 配置(.env,server 读取)

```
LLM_PROVIDER=mock             # mock(默认) | siliconflow | ollama
# --- SiliconFlow ---
SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_CHAT_MODEL=Qwen/Qwen2.5-7B-Instruct
SILICONFLOW_EMBED_MODEL=BAAI/bge-m3
# --- Ollama ---
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_CHAT_MODEL=qwen2.5:7b
OLLAMA_EMBED_MODEL=bge-m3
# --- RAG ---
DATA_DIR=./data
RAG_TOPK=5
# --- 会话/限制 ---
CHAT_HISTORY_TURNS=6
LLM_TIMEOUT_MS=60000
```
用 `@nestjs/config` 加载;缺 key 时启动即报清晰错误(而非运行期才失败)。

## 8. 错误映射与健壮性

| 场景 | code | 处理 |
|---|---|---|
| 入参非法 | `INVALID_INPUT` | Gateway/service 前置校验 |
| LLM 超时/不可达 | `LLM_ERROR` | 超时 + 1 次重试;返回可读中文 |
| RAG 未就绪/读文件失败 | `RAG_ERROR` | 索引失败降级为无检索并在 answer 注明 |
| 用户取消 | `CANCELLED` | 节点边界检查,停流 |
| 其它 | `INTERNAL` | 记日志栈,对外泛化文案 |

- 并发:每 socket 可多 requestId 并行;取消集合需随请求结束**回收**(修正现有 `cancelled` Set 只增不清的泄漏)
- 单请求超时兜底 `LLM_TIMEOUT_MS`

## 9. 目标目录结构

```
server/src/agent/
  agent.gateway.ts        # 已有
  agent.service.ts        # 改为编排入口(去 mock)
  agent.types.ts          # 已有,契约类型
  graph/
    plan.graph.ts         # 行程 LangGraph
    chat.graph.ts         # 问答 LangGraph
    nodes.ts              # retrieve/plan/refine/generate 节点
  rag/
    indexer.ts            # 读 data/,切块+embed+建索引
    store.ts              # search(query,k)
  llm/
    provider.ts           # LLMProvider 接口 + 工厂
    siliconflow.provider.ts
    ollama.provider.ts
  prompts/
    plan.prompt.ts
    chat.prompt.ts
data/                     # 本地知识库 md
```

## 10. 从 mock 迁移的替换点

1. `agent.service.generatePlan` → 驱动 `plan.graph`,节点起止 emit `plan:progress`(替换现有 `step()` 假延时)
2. `agent.service.answerQuestion` → 驱动 `chat.graph`,`onToken` 直连 `chat:token`
3. 删除 `SPOTS` 池与 `buildMockPlan/buildMockAnswer`
4. `sources` 由 RAG 真实命中文件回填
5. 契约/事件名/DTO **全部不变**,UI 无需改动

## 11. 已定决策(本迭代锁定)

1. **Provider**:先只做 `MockProvider`,跑通全链路;SiliconFlow/Ollama 作为后续可插拔增强(§6 工厂已预留)。
2. **向量方案**:内存索引 + 纯 TS 余弦相似度,启动时构建,无持久化。
3. **编排**:采用 LangGraph(`@langchain/langgraph`),按 §3 双图实现。
4. **data/ 知识内容**:由 server-spec 落地时生成一批石家庄景点/美食示例 md(正定古城、苍岩山、西柏坡、河北博物院、牛肉板面、正定八大碗 等)。

---
决策已定,可据此进入 task #2 编码(先接 MockProvider + 内存 RAG + LangGraph + 示例 data/)。


