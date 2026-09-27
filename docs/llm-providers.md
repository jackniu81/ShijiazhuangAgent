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
| `ollama` 但本机服务未启动 | **不**在启动期探测，第一次请求时以 `app:error(LLM_ERROR)` 报出 |

**请求级（issue #8 已实现，`http.ts` + providers）：**

- 连接失败 / HTTP 5xx：自动重试 1 次（指数退避）
- 流式已产出 token 后失败：**不重试**（避免前端内容重复），直接报错
- 超时：`LLM_TIMEOUT_MS`（默认 180s，issue #27 实测后从 60s 上调），流式全程受控
- 失败最终形态：客户端收到 `app:error{ code: 'LLM_ERROR' }`，前端 toast 可重试

**运行期跨 Provider 降级链（siliconflow→ollama→mock）**：未实现，立项于 MS-005 #59。

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

**结论：chat + plan 全链路真实 LLM 验收 PASS ✅**。慢是免费池队列特性；代码默认超时已按此实测上调为 `LLM_TIMEOUT_MS=180000`，根治靠付费额度/更快模型，或 #59 运行期跨 Provider 降级。

### Ollama

本轮未实测（本机仅有 qwen3 系列、无 embedding 模型）。按第 1 节命令 pull 模型后即可用 `LLM_PROVIDER=ollama` 复测。

### 附：SiliconFlow 候选模型速度基准（2026-09-27，两轮采样）

同一问题（正定美食，限 100 字，流式）串行实测 TTFT/总耗时：

| 模型 | TTFT (s) | 总耗时 (s) | 评价 |
|------|----------|-----------|------|
| **THUDM/GLM-4-9B-0414** | **0.2 ~ 0.8** | 1.3 ~ 1.7 | 最快，推荐默认 chat 模型 |
| Qwen/Qwen3-8B | 9.5 ~ 10.6 | 11.6 ~ 12.1 | 稳定可用 |
| THUDM/GLM-Z1-9B-0414 | 5.9 ~ 9.7 | 6.9 ~ 10.7 | 推理模型，思考链计入延迟 |
| Qwen/Qwen3.5-4B | 152.9 ~ 162.5 | 154.7 ~ 164.0 | 最慢（默认思考模式+免费池拥堵），不建议 |

> 此前 Run 2 用 Qwen3.5-4B 的 45~163s 尾延即此因；换 GLM-4-9B 后整体链路可降至秒级，`LLM_TIMEOUT_MS=180000` 仅作兼容慢池的保险值。

## 4. 已知限制

- mock provider 的 emit 间隔 300ms 硬编码（roadmap 已记录，待配置化）
- SiliconFlow 免费额度限 QPM，压测场景需换付费 Key
- `ollama` 启动期不做健康检查，报错延迟到首次请求（改进候选：#59 启动探测）
