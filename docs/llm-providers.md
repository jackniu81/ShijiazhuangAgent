# LLM Provider 配置与端到端验收

> 现势文档（issue #27 交付）。环境变量完整清单以 [server/.env.example](../server/.env.example) 为准，本文补充：切换方法、回退/降级策略、实测记录。

## 1. 5 分钟切换 Provider（新人指南）

```powershell
# ① 复制模板(仅首次)
Copy-Item server\.env.example server\.env
# ② 编辑 server\.env:选 provider、填 Key
#    LLM_PROVIDER=mock | siliconflow | ollama
# ③ 启动并验证
npm install        # 首次
npm run build -w server
npm run start -w server
```

启动日志会打印生效的 provider（`LLMFactory` 一行）。三态说明：

| Provider | 依赖 | 配置要点 |
|----------|------|----------|
| `mock`（默认） | 无 | 无需任何配置，离线可跑通全链路 |
| `siliconflow` | 外网 + 免费 API Key | `SILICONFLOW_API_KEY` 必填（[控制台创建](https://cloud.siliconflow.cn)）；模型默认 `Qwen/Qwen2.5-7B-Instruct` + `BAAI/bge-m3` |
| `ollama` | 本机 `ollama serve` | 需先拉模型：`ollama pull qwen2.5:7b` `ollama pull bge-m3`（embedding 模型缺失会导致启动建索引失败） |

## 2. 回退与降级策略

**启动级（issue #27 已实现，`llm.factory.ts`）：**

| 场景 | 行为 |
|------|------|
| `LLM_PROVIDER` 取值非法 | warn 日志 + 自动回退 `mock`，正常启动 |
| `siliconflow` 但 `SILICONFLOW_API_KEY` 为空 | warn 日志 + 自动回退 `mock`，正常启动 |
| `ollama` 但本机服务未启动 | **不**在启动期探测；首次请求失败后按降级链改投备选（#60），`LLM_FALLBACK=0` 时才以 `app:error(LLM_ERROR)` 报出 |

**请求级（issue #8 已实现，`http.ts` + providers）：**

- 连接失败 / HTTP 5xx：自动重试 1 次（指数退避）
- 流式已产出 token 后失败：**不重试**（避免前端内容重复），直接报错
- 超时：`LLM_TIMEOUT_MS`（默认 180s，issue #27 实测后从 60s 上调），流式全程受控
- 失败最终形态：客户端收到 `app:error{ code: 'LLM_ERROR' }`，前端 toast 可重试

**运行期跨 Provider 降级链（issue #60 已实现，`fallback.provider.ts`）：**

- 启动时按 `siliconflow → ollama → mock` 组链，只有"配了就能用"的厂商入链（缺 Key 跳过），链尾恒为 `mock`；选型即 mock 时不组链
- 同一厂商连续失败 `LLM_CIRCUIT_FAILURES`（默认 3）次进入 `LLM_CIRCUIT_COOLDOWN_MS`（默认 60s）熔断，期内请求跳过它，到期放行一次探测
- 流式已吐 token 后失败**不换人**（避免前端内容重复），错误原样抛出
- `embed` 恒走链首，不跨厂商降级：向量维度不一致会污染 `rag_chunks`；检索期失败由 RAG 自身降级为无本地资料
- 换人承接时，问答末尾追加 `(注:主模型 X 暂不可用，本次由 Y 兜底回答。)`，行程写进 `tips`；落到 mock 的行程请求回放模板 JSON，不会吐无法解析的行程
- `LLM_FALLBACK=0` 关闭，退回单厂商模式

## 3. 端到端验收记录

验收脚本：`.qoder-e2e.mjs`（临时冒烟，已随验收完成后删除；可参照本文档 §1 手工复现）

### Run 1 · mock（含"缺 Key 自动回退"验证）— 2026-09-27

`LLM_PROVIDER=siliconflow` + 空 Key 启动 → 日志出现
`WARN [LLMFactory] ...已自动回退 mock` ✅，随后全链路：

| 阶段 | 结果 | 耗时 |
|------|------|------|
| chat:ask | 17 tokens / 151 字，sources 含 RAG 命中 5 篇（正定古城/缸炉烧饼/牛肉板面等） | ~2.7s（含 mock 固定 emit 间隔） |
| plan:create(2 天) | `plan:day`×2（3 项/天）→ `plan:result`，progress 8 节点完整 | ~0.35s（与 chat 并行起点计） |

**结论：无 Key 环境下全链路可用，验收标准 2 ✅。**

### Run 2 · siliconflow（真实 Key）— 2026-09-27

模型：`Qwen/Qwen3.5-4B` + `BAAI/bge-m3`，`LLM_TIMEOUT_MS=180000`（原默认 60s 不够，已据此上调，见下）：

| 指标 | 值 |
|------|------|
| 启动 | 正常，日志 `LLM provider=siliconflow`；RAG 索引就绪 21 切块 <1s（向量惰性嵌入，未命中降级纯 BM25 路径时仍可用） |
| chat 首 token | **45～81s**（两次实测，免费池排队所致） |
| chat 总耗时 | 47.7s / 85.3s，回答质量正常，sources 命中 5 篇语料 |
| plan(2 天) 全程 | ~163s（大头是 plan 节点单次大 JSON 调用），day 事件逐个到达，结果结构完整 |
| 失败降级实测 | 首轮默认 60s 超时下 plan 报错 `app:error{LLM_ERROR:"响应超时"}`→前端可重试，符合预期（因此代码默认值已上调为 180s） |

**结论：chat + plan 全链路真实 LLM 验收 PASS ✅**。慢是免费池队列特性；代码默认超时已按此实测上调为 `LLM_TIMEOUT_MS=180000`，根治靠付费额度/更快模型，或 #60 运行期跨 Provider 降级。

### Ollama（qwen3:1.7b，本机实测 2026-09-27）

`LLM_PROVIDER=ollama` + `OLLAMA_CHAT_MODEL=qwen3:1.7b`，全链路 E2E 两轮 PASS：

| 指标 | 冷启动首轮 | 热态第二轮 |
|------|-----------|-----------|
| chat 首 token | 37.4s（含模型载入内存） | **2.2s** |
| chat 总耗时 | 38.0s | 2.8s |
| plan(2 天) 全程 | ~8.6s | ~8.3s |

**限制**：本机无 embedding 模型（qwen3:1.7b 试作 embed 返回 500/501），启动时 RAG 索引构建失败→**优雅降级为无检索模式**（已实测降级路径工作正常：回答不带 sources，链路不断）。要解锁完整 RAG 需 `ollama pull bge-m3`；首次请求的 35s 冷启动载入可考虑生产环境预热或常驻。

### Run 3 · 降级链（`LLM_PROVIDER=siliconflow` + 无效 Key）— 2026-09-27

启动日志：`LLM 降级链:siliconflow → ollama → mock(连续 3 次失败即熔断 60000ms)`；本机 ollama 在跑但缺 `qwen2.5:7b`，形成"两家都不可用"的真实场景。

| 阶段 | 结果 |
|------|------|
| 启动 | RAG 索引构建失败（embed 401 `Token is invalid`）→ 降级为无检索模式，服务照常起 |
| chat:ask | `chat:done`（167 字），尾部依次注明"本地资料检索暂不可用"与"主模型 siliconflow 暂不可用，本次由 mock 兜底回答" |
| plan:create(2 天) | `plan:result`，2 天 / 每天 2 项，`tips` 末条为同一段兜底说明 |
| 链路日志 | `siliconflow 调用失败(401)` → `ollama 调用失败(model not found)` → `已降级承接:siliconflow → ollama → mock` |

**结论：主 key 失效时服务自动降级且用户可感知，#60 验收标准 1 ✅**（冒烟脚本 `.qoder-smoke60.mjs`，验证后删除）。

### 附：SiliconFlow 候选模型速度基准（2026-09-27，两轮采样）

同一问题（正定美食，限 100 字，流式）串行实测 TTFT/总耗时：

| 模型 | TTFT (s) | 总耗时 (s) | 评价 |
|------|----------|-----------|------|
| **THUDM/GLM-4-9B-0414** | **0.2 ~ 0.8** | 1.3 ~ 1.7 | 最快，推荐默认 chat 模型 |
| Qwen/Qwen3-8B | 9.5 ~ 10.6 | 11.6 ~ 12.1 | 稳定可用 |
| THUDM/GLM-Z1-9B-0414 | 5.9 ~ 9.7 | 6.9 ~ 10.7 | 推理模型，思考链计入延迟 |
| Qwen/Qwen3.5-4B | 152.9 ~ 162.5 | 154.7 ~ 164.0 | 最慢（默认思考模式+免费池拥堵），不建议 |

> 此前 Run 2 用 Qwen3.5-4B 的 45~163s 尾延即此因；换 GLM-4-9B 后整体链路可降至秒级，`LLM_TIMEOUT_MS=180000` 仅作兼容慢池的保险值。本地 Ollama qwen3:1.7b 热态表现见上节，速度介于两者之间且免网免密。

## 4. 已知限制

- mock provider 的 emit 间隔 300ms 硬编码（roadmap 已记录，待配置化）
- SiliconFlow 免费额度限 QPM，压测场景需换付费 Key
- `ollama` 启动期不做健康检查，首次请求才暴露（有降级链时表现为静默改投 mock）；启动探测仍是改进候选
