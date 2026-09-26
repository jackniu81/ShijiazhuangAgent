# 石家庄旅游助手 — 实现 Review & 增强路线图

> 本文档是 MVP 交付后的系统性 review，列出已实现清单、代码质量观察、按优先级排序的增强建议。
> 评估日期：2026-09-25（main @ 5bc0ed3）

---

## 一、已实现清单（MVP 完成度）

### Server（NestJS 12 + LangGraph + Socket.IO）

| 模块 | 文件 | 状态 |
|------|------|:----:|
| WebSocket 网关 | agent.gateway.ts（/agent namespace + /ws path） | ✅ |
| 核心编排 | agent.service.ts（plan / chat / cancel 三条路径） | ✅ |
| Plan 图 | plan.graph.ts（retrieve → plan → refine → done） | ✅ |
| Chat 图 | chat.graph.ts（retrieve → generate） | ✅ |
| 节点实现 | nodes.ts（进度上报、取消守卫、plan:day 流式） | ✅ |
| Prompt 模板 | plan.prompt.ts / chat.prompt.ts + util.ts | ✅ |
| RAG 混合检索 | bm25 + 向量 + RRF fusion + tag/region rerank | ✅ |
| LLM Provider | mock / siliconflow / ollama + factory | ✅ |
| 会话存储 | session.store.ts（内存 + TTL 自动清理） | ✅ |
| 配置 | configuration.ts + .env.example 全套 | ✅ |
| **单元测试** | 8 个 spec 文件（nodes / rag 4 / prompts 2 / config） | ✅ |

### Client（React 19 + Vite 8 + Tailwind CSS 4）

| 模块 | 文件 | 状态 |
|------|------|:----:|
| 主容器 | ChatWindow.tsx（useReducer + socket 编排 + 17 种 action） | ✅ |
| 布局 | Layout.tsx（Header/Main + footer slot） | ✅ |
| 状态指示 | ConnectionStatus.tsx | ✅ |
| 消息列表 | MessageList.tsx + auto-scroll | ✅ |
| 消息项 | MessageItem.tsx（user / assistant-text / assistant-plan / system） | ✅ |
| 行程卡片 | PlanCard.tsx（流式占位 skeleton + 完整渲染） | ✅ |
| 打字机 | StreamingText.tsx + 闪烁光标 | ✅ |
| 规划表单 | PlanningForm.tsx（days/interests 校验） | ✅ |
| 错误 toast | 内联在 ChatWindow（可恢复 + 一键重试） | ✅ |
| Socket 封装 | socket.ts（单例 + 重连 + emit 方法） | ✅ |
| API 类型 | lib/types.ts（与 server/agent.types.ts 镜像） | ✅ |
| **单元测试** | 6 个 test 文件，21 tests 全绿 | ✅ |

### API 契约（docs/api-spec.md）

| 事件 | Server emit | Client 监听 | 状态 |
|------|:-----------:|:-----------:|:----:|
| plan:create | — | ✅ | ✅ |
| chat:ask | — | ✅ | ✅ |
| task:cancel | — | ✅ | ✅ |
| plan:progress | ✅ | ✅ | ✅ |
| **plan:day** | ✅ | ✅ | ✅ **新增** |
| plan:result | ✅ | ✅ | ✅ |
| chat:token | ✅ | ✅ | ✅ |
| chat:done | ✅ | ✅ | ✅ |
| app:error | ✅ | ✅ | ✅ |

### RAG 知识库（data/）

| 目录 | 篇数 | 状态 |
|------|:----:|:----:|
| attractions/ | 10 | ✅ |
| food/ | 5 | ✅ |
| routes/ | 2 | ✅ |
| hotel/ | 1 | ✅ **新增** |
| transport/ | 1 | ✅ **新增** |
| specialties/ | 2 | ✅ **新增** |
| **合计** | **21** | ✅ |

---

## 二、代码质量观察

### ✅ 做得好的

1. **零 TODO/FIXME/TS 忽略注释** — 全库 grep 干净，无技术债标记
2. **类型严格对齐** — client/types.ts 与 server/agent.types.ts 镜像复制，字段名一致
3. **取消语义完整** — LangGraph 图 + LLM stream + Socket.IO 三层都实现了 AbortController / CancelledSignal
4. **MockProvider 可演示** — streamDelayMs 默认 150ms，plan 逐天 300ms 间隔，足以端到端展示
5. **测试覆盖核心逻辑** — server 侧 8 个 spec 覆盖纯函数（nodes、bm25、fusion、indexer、store、prompts、config），client 侧 21 tests 覆盖组件渲染
6. **错误收敛为 app:error** — 五种错误码统一，server 侧 nodes / service / gateway 都 guard 了

### ⚠️ 可改进（不 blocker）

| # | 观察 | 位置 | 严重度 |
|---|------|------|:------:|
| C1 | **types.ts 双份维护** — client/lib/types.ts 镜像 server/agent.types.ts，改一处忘另一处会类型漂移 | 两个 types.ts | ⚠️ 中 |
| C2 | **nodes.spec.ts 未测 plan:day** — 新增的 emitPlanDays 函数无单测 | nodes.spec.ts | ⚠️ 中 |
| C3 | **ChatWindow 单文件 570+ 行** — reducer 200 行 + socket 监听 + 渲染逻辑全在一个文件 | ChatWindow.tsx | ⚠️ 低 |
| C4 | **无 Gateway 层单测** — agent.gateway.ts 的 requestId 校验、emit 注入逻辑无 spec | gateway.ts | ⚠️ 低 |
| C5 | **SessionStore 仅内存** — 重启丢失会话历史；sweeper setInterval 进程被杀就停 | session.store.ts | ⚠️ 中 |
| C6 | **server 端 sleep 300ms 硬编码** — nodes.ts emitPlanDays 的间隔不可配置 | nodes.ts:81 | ⚠️ 低 |
| C7 | **PlanCard.streaming true 时 tips 隐藏** — 流式阶段 summary 也只在第一天 emit，完整后才全量；逻辑分散在 reducer + PlanCard 两处 | 跨文件 | ⚠️ 低 |

### 🐛 潜在风险

| # | 风险 | 位置 | 严重性 | 说明 |
|---|------|------|:------:|------|
| R1 | **无请求鉴权** — Socket.IO namespace 无 auth middleware，任意 WS 客户端可 emit plan:create | gateway.ts | 🔴 高（生产前必加） |
| R2 | **无并发/速率限制** — 无 per-IP 或 per-session 限流，恶意客户端可刷爆 LLM 额度 | gateway.ts | 🔴 高 |
| R3 | **client requestId 不加密** — client 自己生成 uuid，理论上可伪造；server 侧未校验 origin/browser 限制 | 双端 | 🟡 中（内网/小环境可接受） |
| R4 | **plan:day 取消窗口** — emitPlanDays 里 300ms sleep 间隔中取消，guardCancel 会在下一轮才触发 | nodes.ts | 🟡 中 |
| R5 | **LLM 流式无回压** — siliconflow/ollama 的 stream token 回调在 server 快速 emit 给 client，但 node gateway 未检查 client 缓冲区，极端慢 client 可能丢事件 | gateway.ts | 🟢 低 |

---

## 三、增强路线图

按**收益/成本比** + **依赖关系**排序。分三档：立即可做、等真实需求、二期大功能。

### 🔥 立即可做（单 PR 搞定，无外部依赖）

#### 1. 抽出 shared/types 包 — 解决 C1 类型漂移问题
**成本**：0.5d | **收益**：彻底消除 client/types.ts 与 server/agent.types.ts 漂移风险

```
packages/shared/            # npm workspace
├── tsconfig.json
└── src/
    └── agent.types.ts      # 从 server/src/agent/ 抽出
```

client 和 server 各自 `import { AgentEvents, PlanDayEvent } from '@shijiazhuang-agent/shared'`。

> 替代方案（更轻）：在 package.json 里用 `file:` 路径让 client 直接引用 server/src/agent/agent.types.ts，避免新建 workspace。

#### 2. ChatWindow reducer 抽成 hook — 解决 C3 单文件膨胀
**成本**：0.5d | **收益**：测试粒度细化

```typescript
// useChatReducer.ts
export function useChatReducer(initialState: ChatState) { ... }
```

ChatWindow 只负责 socket 监听 + 渲染，状态逻辑独立可测。

#### 3. nodes.spec.ts 补 plan:day 测试 — 解决 C2
**成本**：0.2d | **收益**：覆盖新增加的 emitPlanDays 路径

需要测：
- ✅ 逐天 emit N 次（plan.days.length === 3 时收到 3 个 PLAN_DAY 事件）
- ✅ 每个事件 day 字段正确、totalDays 正确
- ✅ 仅首个事件带 summary
- ✅ emit 中间被 CancelledSignal 打断

#### 4. RAG 重排规则显式化 — 给现有 rerank 写文档 + 测试
**成本**：0.3d | **收益**：语料加了 region/tags 但 rerank 规则是什么目前散在代码里

当前 fusion.ts 有 RRF 融合逻辑，但 tag/region rerank 权重在哪？查 fusion.ts + rag.service.ts 确认后写进 docs/。

### 🟡 等真实需求触发

#### 5. 请求鉴权（R1 风险修复）
**成本**：1d | **收益**：生产可部署

Socket.IO namespace middleware 加 auth：
- 最简单：`Authorization: Bearer <static-token>` 环境变量
- 进阶：JWT + session 绑定（但需要先有用户系统）

#### 6. 速率限制（R2 风险修复）
**成本**：0.5d | **收益**：防刷

Socket.IO `@socket.io/rate-limit-adapter` 或 `express-rate-limit` 包装 emit handler。

#### 7. SessionStore 持久化 + sweep 生命周期修复（C5）
**成本**：1d | **收益**：进程重启不丢会话

- 简单：写 SQLite / lowdb（单文件，无外部服务）
- 中等：Redis / Upstash（需要外部依赖，但 #29 向量持久化如果做 Redis 就一起了）
- 顺手修复 sweeper 的 `node --exit` 钩子

#### 8. plan:day emit 间隔可配置（C6）
**成本**：0.1d | **收益**：mock/真 LLM 场景都能调

在 configuration.ts 加 `PLAN_DAY_STREAM_INTERVAL_MS`，emitPlanDays 读配置。

### 🔵 二期大功能（需要 spec 升级 / 外部依赖）

#### 9. 向量检索持久化（#29）
**前置**：先确定 embedding 模型（决定维度和供应商）

- 选项 A：Chroma（Python，server 需跨进程调用）
- 选项 B：pgvector（Postgres，需要外部 DB）
- 选项 C：Upstash Vector / Weaviate / Pinecone（SaaS）

> 当前 InMemoryVectorStore 在开发场景没问题，真实 LLM 验收 (#27) 前不需要动。

#### 10. 真实 LLM 验收（#27）
**前置**：有 SiliconFlow 或 Ollama API key

当前 mock 已经覆盖了完整协议，但真实 LLM 会暴露：
- prompt 效果（行程生成 JSON 格式命中率）
- 流式 token 延迟体验
- RAG 检索命中率
- Cancel 中断精度

#### 11. Client 单元测试覆盖 gap
**当前已覆盖**：Layout、MessageItem、MessageList、PlanCard、StreamingText、PlanningForm（渲染层面）
**未覆盖**：
- ❌ **ChatWindow reducer** — 17 种 action 没有一条测试，`PLAN_DAY` 的占位 → 填充 → 替换逻辑是高风险区
- ❌ **socket.ts 事件桥接**（需要 vi.mock io）
- ❌ **PlanCard streaming=true 的 skeleton UI**（animate-pulse + 占位天数）

#### 12. 其他二期（#30-#36）

| Issue | 说明 | 依赖 |
|-------|------|------|
| #30 行程编辑 + PDF | 前端拖拽重排 + jsPDF / react-pdf | plan:result 后用户可修改 |
| #31 实时数据 | 天气/景点开放时间 API 接入 | 外部 API 选型 |
| #32 地图集成 | Leaflet / 高德地图 SDK | 需要地图 key |
| #33 跨 session 长期记忆 | embedding 用户画像 + 个性化推荐 | 向量持久化 #29 |
| #35 多语言 + 语音 | i18next + Web Speech API | 轻量，可独立开 |
| #36 Docker 部署 | Dockerfile + docker-compose + health check | — |

### 🧪 架构级增强（可选方向）

| 方向 | 说明 | 何时考虑 |
|------|------|---------|
| **LangGraph 可观测性** | LangSmith / Langfuse 接入，追踪 retrieve → plan → refine 全链路 token 用量和耗时 | 真实 LLM 跑通后 |
| **Prompt 版本管理** | prompt 模板版本号 + 效果回归 | 迭代 prompt 时 |
| **评估脚本** | 固定 question list → 自动跑 → 检查 answer 包含期望关键词 | RAG 调优时 |
| **API 自动生成 TS 类型** | 用 `wsdl` / protobuf / 手写 codegen 从 api-spec.md 生成 shared/types | 如果 C1 升级后还想进一步自动化 |
| **Server 热重载开发体验** | nest start --watch + client vite dev 都有，已具备 | — |

---

## 四、优先级推荐

### 如果今天只开一个

> **ChatWindow reducer 抽 hook + 补 PLAN_DAY 测试**（#2 + #3），一个 PR 搞定，同时消除 C2 和 C3。

### 如果要上线前必做

> **R1 鉴权 + R2 限流 + 日志埋点**，三个都是生产 blocker。

### 如果要长期演进

> **先跑通 #27 真实 LLM 验收**（有 SiliconFlow 或 Ollama key 的 2h 工作量），再决定 #29 向量持久化走哪条路。

---

## 五、总结

```
MVP 完成度: ████████████████████ 100% (核心链路全通)
代码质量:   ███████████████████░░  90% (零技术债标记, 类型有漂移风险)
测试覆盖:   ████████░░░░░░░░░░░░  40% (组件渲染全过, reducer 逻辑零 UT)
生产可用:   ██████░░░░░░░░░░░░░░  30% (缺鉴权、限流、日志、持久化会话)
```

> 一句话：**MVP 交付达标，可以 demo；但如果要上线或让别人用，先补鉴权/限流 + 给 ChatWindow reducer 写两条测试**。
