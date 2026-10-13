# 石家庄旅游助手 — Chat Graph 工具调度设计规格

> 本文件是 **chat.graph 工具化改造** 的设计蓝图,定义在现有"retrieve → generate"线性问答图之上引入 **analyze + 工具循环调度** 的目标形态。落地前以本文档为准,落地后以代码为准并归档。对外 WebSocket 契约([api-spec.md](./api-spec.md))尽量保持不变,新增事件见 §7。

## 1. 目标与范围

在当前问答图上增加工具的**执行与调度**能力,支持两个工具:

| 工具 | 触发条件 | 数据来源 |
|---|---|---|
| `weather` 天气查询 | 问题含明确日期且距今 ≤ 5 天,且回答需要天气信息 | 外部天气 API(经 deps 注入,可 mock) |
| `rag_attraction` 景点补充检索 | 追问/新话题中出现的景点未被 baseline RAG 覆盖 | 复用现有 `deps.retrieve` |

范围:仅 server 侧 `agent/graph/` 与相关 prompt/types 改动。行程图(plan.graph)不在本次范围。

非目标:不引入通用 function-calling 框架;工具集固定为上述两个,后续扩展另议。

## 2. 现状与问题

当前 `chat.graph.ts` 为固定线性流程:

```
START → retrieve → generate → END
```

- `retrieve`:改写 query(见 `rewriteRetrieveQuery`)后一次性检索,产出 `docs`。
- `generate`:基于 `docs` + history 流式生成回答。

问题:
1. 无法按需查询天气等外部动态数据。
2. 追问新景点时,baseline 检索的通用 query 可能命不中,导致"资料未提及"。
3. 检索策略是"一刀切",缺乏根据问题意图的动态调度。

## 3. 目标流程

保留 baseline retrieve 作为 analyze 的决策依据,新增 analyze 节点与工具循环:

```
START
  │
  ▼
retrieve (baseline,必执行,轻量:改写 query + 混合检索)
  │
  ▼
analyze (LLM 判断:question + baseline docs + history + 已有 toolResults)
  │
  ├── toolCalls 为空 ─────────────────────────┐
  │                                            │
  ├── weather ─────────► weather_tool ──► analyze  (循环,MAX_TOOL_ROUNDS 上限)
  │                                            │
  └── rag_attraction ──► rag_tool ─────► analyze  (循环)
                                               │
                                               ▼
                                            generate (合并 baseline docs + toolResults)
                                               │
                                               ▼
                                              END
```

设计要点:
- **串行调度**:analyze 每轮只路由一个工具,执行后回到 analyze 重新判断,避免并行状态合并复杂度。
- **循环保护**:`MAX_TOOL_ROUNDS`(建议 3)达到上限后强制 `toolCalls=[]`,进入 generate。
- **analyze 需 baseline context**:无 baseline docs 时 analyze 属"盲判",易误调/漏调工具;retrieve 为本地毫秒级检索,不构成瓶颈,故保留。

## 4. 状态 Schema 调整

`ChatAnnotation` / `ChatState` 新增字段(区分 baseline 与工具产出):

```ts
interface ChatState {
  question: string;
  sessionId: string;
  history: Msg[];
  docs: RetrievedDoc[];          // baseline retrieve 结果(不变)
  answer?: string;
  filteredEmpty?: boolean;       // 现有阈值全过滤标记(不变)
  // ── 新增 ──
  toolCalls: ToolCall[];         // analyze 产出的本轮待执行工具
  toolResults: ToolResult[];     // 各工具累计执行结果
}

interface ToolCall {
  name: 'weather' | 'rag_attraction';
  params: Record<string, unknown>;   // weather: { date, city? }; rag: { attraction }
}

interface ToolResult {
  name: ToolCall['name'];
  params: Record<string, unknown>;
  output: string;                    // 供 generate 拼入 prompt 的文本
  docs?: RetrievedDoc[];             // rag_attraction 命中切块(用于 sources 回填与去重)
}
```

对应 `Annotation` reducer:
- `toolCalls`:每轮覆盖(reducer 取 next),工具执行后清空。
- `toolResults`:**追加式**(reducer `[...prev, ...next]`),跨轮累积。

## 5. 节点设计

所有节点沿用现有工厂闭包风格(`nodes.xxx(deps)` 返回 LangGraph 兼容节点),复用 `tracked` / `guardCancel` / `emitProgress` 包装。

### 5.1 `retrieve`(基本不变)
保持现有实现;仅确保产出 `docs` 与 `filteredEmpty`。

### 5.2 `analyze`(新增)
- 输入:`question` + `docs`(baseline)+ `history` + `toolResults`(已执行)。
- 逻辑:
  1. 轮次守卫:`toolResults.length >= MAX_TOOL_ROUNDS` → 直接返回 `{ toolCalls: [] }`。
  2. 用轻量 LLM 调用(`deps.llm.chat`,`temperature:0`,`jsonMode:true`)判断需要哪个工具。
  3. 解析 JSON → `ToolCall[]`(最多 1 个,便于串行);解析失败降级为 `[]`(直接生成)。
- 输出:`{ toolCalls }`。
- mock provider 场景:analyze 走规则短路(见 §6),不依赖 LLM JSON 输出。

analyze 决策规则(prompt 内约束):
- **weather**:问题含可解析日期且 `0 ≤ date - today ≤ 5 天`,且语义与出行/天气相关 → `{ name:'weather', params:{ date } }`。日期超范围或无日期 → 不调用。
- **rag_attraction**:从当前问题识别景点实体,若该景点未出现在 `docs` 的 `meta.title` 集合中 → `{ name:'rag_attraction', params:{ attraction } }`。已覆盖 → 不调用。
- 两者皆不需要 → `[]`。

### 5.3 `weather_tool`(新增)
- 取 `toolCalls` 中 `name==='weather'` 的调用。
- 再次校验日期在 5 天内(防御性,防 analyze 误判)。
- 调用 `deps.weather(date)`;失败/超范围时 output 记为"暂不支持该日期天气查询"。
- 输出:`{ toolResults: [result], toolCalls: [] }`。

### 5.4 `rag_tool`(新增)
- 取 `toolCalls` 中 `name==='rag_attraction'` 的调用。
- 以 `attraction` 为 query 调 `deps.retrieve(attraction, k)`(k 可小于 baseline,建议 3)。
- output = 格式化命中文本;docs = 命中切块(供合并去重与 sources)。
- 输出:`{ toolResults: [result], toolCalls: [] }`。

### 5.5 `generate`(调整)
- 合并 context:`mergeDocs(state.docs, ragToolDocs)` 按 `source` 去重。
- 将非 rag 类 toolResults(如 weather 文本)作为额外 context 段拼入 prompt。
- `sources` 回填需包含 rag_tool 命中的来源。
- 其余流式 emit / token 用量日志 / `filteredEmpty` 注记逻辑保持不变。

合并去重:
```ts
function mergeDocs(baseline: RetrievedDoc[], extra: RetrievedDoc[]): RetrievedDoc[] {
  const seen = new Set(baseline.map(d => d.source));
  return [...baseline, ...extra.filter(d => !seen.has(d.source))];
}
```

## 6. Graph 构建

```ts
function buildChatGraph(deps: GraphDeps) {
  return new StateGraph(ChatAnnotation)
    .addNode('retrieve',     nodes.retrieve(deps, { emitProgress: false }) as never)
    .addNode('analyze',      nodes.analyze(deps) as never)
    .addNode('weather_tool', nodes.weatherTool(deps) as never)
    .addNode('rag_tool',     nodes.ragTool(deps) as never)
    .addNode('generate',     nodes.generate(deps) as never)
    .addEdge(START, 'retrieve')
    .addEdge('retrieve', 'analyze')
    .addConditionalEdges('analyze', routeTools, {
      weather: 'weather_tool',
      rag:     'rag_tool',
      none:    'generate',
    })
    .addEdge('weather_tool', 'analyze')
    .addEdge('rag_tool',     'analyze')
    .addEdge('generate', END)
    .compile();
}

function routeTools(state: ChatState): 'weather' | 'rag' | 'none' {
  const call = state.toolCalls?.[0];
  if (!call) return 'none';
  return call.name === 'weather' ? 'weather'
       : call.name === 'rag_attraction' ? 'rag'
       : 'none';
}
```

## 7. 依赖与契约扩展

### 7.1 `GraphDeps` 扩展
```ts
interface GraphDeps {
  // ...现有字段
  /** 天气查询函数,由 AgentService 注入;缺省时 weather 工具返回"不可用" */
  weather?: (date: string, city?: string) => Promise<string>;
}
```
- `AgentService.buildDeps` 注入 weather 实现(初期可 mock 或对接免费天气 API)。
- 天气 API 的具体选型/密钥配置见 [llm-providers.md](./llm-providers.md) 同级新增配置项,列入 todo。

### 7.2 配置项(`configuration.ts`)
- `chat.maxToolRounds`(默认 3)
- `chat.weatherEnabled`(默认 false,灰度开关)
- `chat.ragToolTopK`(默认 3)

### 7.3 事件契约(api-spec.md)
- `plan:progress` 的 `node` 联合类型当前为 `'retrieve'|'plan'|'refine'|'done'`,**不含 chat 节点**;chat 图现用 `emitProgress:false`。本次维持:analyze/tool 节点默认不 emit progress,避免扩展 PlanNode 类型。
- 若需前端展示"正在查询天气…",另议新增 `chat:progress` 事件(不在本次范围)。
- `chat:done.sources` 语义扩展:包含 rag_tool 命中来源(类型不变)。

## 8. 测试策略

遵循 co-located `.spec.ts` 约定与"测试用例精简"原则:

| 测试点 | 用例 |
|---|---|
| `routeTools` 纯函数 | toolCalls 空→none;weather→weather;rag→rag |
| `analyze`(mock provider) | 含 5 天内日期→weather;含未覆盖景点→rag;普通问题→[] |
| `analyze` 循环上限 | toolResults 达 MAX_TOOL_ROUNDS→强制 [] |
| `weather_tool` | 日期超 5 天→"暂不支持";deps.weather 抛错→降级 output |
| `rag_tool` | 命中→output 非空且 docs 回填;未命中→空结果不报错 |
| `mergeDocs` | source 重复→去重;无重复→合并 |
| `generate` | toolResults 注入 prompt;sources 含 rag_tool 来源 |
| 取消/超时 | 工具循环中 `isCancelled()`→抛 `CancelledSignal` |

live 集成测试沿用 env gate 约定(见现有 `*.spec.ts` LIVE 模式)。

## 9. 分期落地建议

1. **P1 骨架**:ChatState/ToolCall/ToolResult 类型 + 空工具节点 + graph 布线 + `routeTools`,analyze 用规则短路(mock 可跑通),工具先返回占位。
2. **P2 rag_tool**:接 `deps.retrieve`,generate 合并去重 + sources 回填。此期即可显著提升追问体验。
3. **P3 weather_tool**:注入 `deps.weather`(先 mock),日期解析与 5 天校验。
4. **P4 analyze LLM 化**:规则短路替换/兜底为 LLM JSON 判断,配置开关灰度。
5. **P5 真实天气 API**:选型、密钥、配置、live 测试。

## 10. 风险与开放问题

- **日期解析**:中文相对日期("后天""下周六")→ 绝对日期的解析归属(analyze prompt 内让 LLM 输出 ISO 日期,还是 server 侧解析)。建议由 analyze LLM 直接输出 `YYYY-MM-DD`,server 侧仅做范围校验。
- **延迟叠加**:analyze 若走真实 LLM,每次问答多 1~N 次调用。P1~P3 用规则短路可零额外延迟;P4 需评估是否仅在有工具信号时才调 LLM。
- **天气数据源**:免费 API 稳定性/配额,需降级文案。
- **mock provider 一致性**:mock 下 analyze 必须走规则,否则 JSON 解析恒失败。
