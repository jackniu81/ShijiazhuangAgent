# Web 查询 Tool — 真实数据源实现规格

> 本文是 [chat-tools-spec.md](./chat-tools-spec.md) 中 `web_search` 工具(P5)的落地实现规格:把原先注入的 mock 占位数据源替换为**真实 DuckDuckGo 联网检索**,不改动 analyze/工具循环调度架构。对外 WebSocket 契约保持不变。最近更新 2026-10-15。

## 1. 背景与定位

`chat-tools-spec.md` 已落地 chat 图的 `retrieve → analyze → 工具循环 → generate` 调度框架,`web_search` 是其中一条工具:

- `analyze` 依据问题意图与 `config.chat.webSearchEnabled` 灰度开关决定是否路由 `web_search`;
- `webTool` 节点调用 `deps.webSearch(query)` 取回**纯文本**,作为 `ToolResult` 累计;
- `generate` 把 `toolResults` 拼入 prompt 的"工具查询结果"段。

此前 `deps.webSearch` 注入的是 [mock.web.ts](../server/src/agent/web/mock.web.ts) 占位文案,注释标注"后续可替换为真实搜索 API"。**本次即完成该替换**:接入 DuckDuckGo 真实检索,保留 mock 作为可选/回退引擎。

## 2. 选型

### 2.1 集成方式:复用 tool 框架的 `deps.webSearch`(选定)

不新增第二条检索路径(如 baseline `retrieve` 内置增强),而是把真实搜索实现为 `deps.webSearch` 的具体数据源。理由:

- 单一 web 查询入口,调度/开关/去重/轮次上限由既有 analyze 框架统一管理;
- 与上游架构一致,避免双路径重复检索与延迟叠加;
- 工具产出为文本经 generate 注入,天然融入"工具查询结果",无需扩展 `sources`。

### 2.2 后端:DuckDuckGo HTML(选定)

| 后端 | Key | 成本 | 返回形态 | 稳定性 |
|------|-----|------|----------|--------|
| DuckDuckGo HTML(选定) | 免 | 零 | 标题+URL+摘要 | 依赖页面结构,可能限流 |
| Tavily | 需 | 1000/月免费 | 摘要+正文 | 高 |
| Bing/Serper/Brave | 需 | 有免费层 | 原始网页列表 | 高 |

选定 DuckDuckGo HTML 版:免 Key 零成本;Node 内置 fetch + 正则解析,**不新增依赖**。不可达或结构变更时按降级契约返回"未找到"文案,不影响回答。`WebSearchProvider` 预留后续切 Tavily 的空间(仅需新增一个引擎实现 + 工厂分支)。

## 3. 架构与数据流

```
chat.graph: retrieve → analyze ─(webSearchEnabled 且命中实时意图)→ web_tool → analyze → ... → generate
                                                     │
                                   deps.webSearch(query, signal)
                                                     │
                       createWebSearch(config.web) 按 provider 分发
                              ┌──────────────────────┴──────────────────────┐
                        provider=mock                                provider=duckduckgo
                     mockWebSearch(query)                  duckduckgoWebSearch(query, {topK,timeoutMs,signal})
                                                                  fetch → parse → 文本块
                                                     │
                                     ToolResult{ name:'web_search', output } → generate 注入 prompt
```

- 是否调用:`config.chat.webSearchEnabled`(灰度总开关,默认 false)经 analyze 路由控制;
- 用哪个引擎:`config.web.provider`(`mock` | `duckduckgo`);
- `signal`:webTool 传 `deps.signal`,`duckduckgoWebSearch` 内部再 `AbortSignal.any([signal, timeout])` 联动取消与自身超时。

## 4. 实现

### 4.1 真实数据源:`server/src/agent/web/duckduckgo.web.ts`

```ts
export interface WebSearchOptions { topK: number; timeoutMs: number; signal?: AbortSignal }
export interface WebSearchResult { title: string; url: string; snippet: string }

// 契约与 deps.webSearch 对齐:返回拼入 prompt 的纯文本;异常内部消化降级为"未找到"文案,不抛
export async function duckduckgoWebSearch(query: string, opts: WebSearchOptions): Promise<string>;
// 纯函数,便于单测
export function parseDuckDuckGoHtml(html: string): WebSearchResult[];
```

- 端点:`GET https://html.duckduckgo.com/html/?q=<encodeURIComponent(query)>`,带浏览器 `User-Agent`;
- 解析:结果锚点 `class="result__a"`(标题+重定向链接),摘要锚点 `class="result__snippet"`,按出现顺序配对;真实 URL 从重定向参数 `uddg` 经 `decodeURIComponent` 还原;文本剥离内嵌标签并反转义 `&amp; &lt; &gt; &quot; &#39; &nbsp; &hellip;`;
- 输出:`【网站查询】关于「query」的联网结果:\n- 标题 (url)\n  摘要 ...`;
- 降级:非 2xx / 网络异常 / 超时 / 解析 0 条 / 空 query → `未找到关于「query」的联网信息。`,并打 `warn` 日志。

### 4.2 引擎工厂:`server/src/agent/web/web-search.factory.ts`

```ts
export function createWebSearch(web: AppConfig['web']): (query, signal?) => Promise<string>;
// provider==='duckduckgo' → 委托 duckduckgoWebSearch(绑定 topK/timeoutMs,转发 signal)
// 其余(默认 'mock')     → mockWebSearch
```

### 4.3 接线:`agent.service.ts` `buildDeps`

`webSearch: mockWebSearch` → `webSearch: createWebSearch(this.config.web)`。`retrieve` 与图/节点不变。

### 4.4 契约微扩:`graph.types.ts` + `nodes.ts`

- `webSearch?: (query: string, signal?: AbortSignal) => Promise<string>`(新增可选第二参,向后兼容);
- `webTool`:`await deps.webSearch(query, deps.signal)`。

## 5. 配置项

`server/src/config/configuration.ts` → `AppConfig.web`(引擎细节;调用与否仍由 `chat.webSearchEnabled` 控制):

| 环境变量 | 含义 | 默认 |
|----------|------|------|
| `WEB_SEARCH_PROVIDER` | 数据源引擎 `mock` \| `duckduckgo`(非法回退 mock) | `mock` |
| `WEB_SEARCH_TOPK` | 在线结果最多条数 | 3 |
| `WEB_SEARCH_TIMEOUT_MS` | 单次 web 请求超时(毫秒) | 8000 |
| `WEB_SEARCH_LIVE_TEST` | 置 1 才跑真实网络冒烟测试 | 空(跳过) |

灰度启用真实联网需同时:`CHAT_WEB_SEARCH_ENABLED=true` + `WEB_SEARCH_PROVIDER=duckduckgo`,且服务器/容器可出外网。已同步 `server/.env.example`。

## 6. 观测

- 命中真实检索:结果文本经 generate 注入 prompt,回答中体现"工具查询结果";
- 失败/降级:`DuckDuckGoWebSearch` 打 `warn`,webTool 的 try/catch 兜底"网站查询服务暂不可用";
- `chat:done.sources` 语义不变(web_search 产文本不产 docs,不进 sources)。

## 7. 测试

| 文件 | 覆盖 |
|------|------|
| `web/duckduckgo.web.spec.ts` | HTML fixture 解析(标题/uddg 解码/摘要/实体);格式化与 topK 截断;非 2xx / fetch 抛错 / 0 结果 / 空 query 均降级"未找到";live 门控 |
| `web/web-search.factory.spec.ts` | provider=mock 走占位;provider=duckduckgo 委托真实引擎 |
| `config/configuration.spec.ts` | `web` 段默认值、`WEB_SEARCH_*` 覆盖、非法引擎回退 mock |

mock provider 端到端仍可跑通(默认 provider=mock,无外网依赖)。

## 8. 假设与限制

- 不新增 npm 依赖;需 Node 18+(全局 fetch、`AbortSignal.timeout/any`)。
- DuckDuckGo HTML 端点结构若变更,由降级契约兜底(返回"未找到",不报错);届时新增引擎实现并在工厂加分支即可,接口不变。
- 真实检索受目标站点限流影响,非高可用保证;生产可评估切换 Tavily。
