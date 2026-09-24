# 石家庄旅游助手 AI Agent

基于 LangGraph + RAG + LLM 的石家庄旅游智能助手,支持行程规划和旅游问答。

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

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量(可选,默认 LLM_PROVIDER=mock 无需任何 key)
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

本地 markdown 语料,启动时自动构建索引(向量 + BM25 双路,RRF 融合 + tag/region rerank):

```
data/
├── attractions/   # 景点(6 篇)
├── food/          # 美食(3 篇)
└── routes/        # 推荐线路(2 篇)
```

## 文档

| 文件 | 说明 |
|------|------|
| [docs/api-spec.md](docs/api-spec.md) | WebSocket API 规范(Server / Client 契约) |
| [docs/server-spec.md](docs/server-spec.md) | Server 实现规范 |
| [docs/ui-spec.md](docs/ui-spec.md) | Client UI 实现规范 |
| [require.md](require.md) | 原始需求 |

## 项目结构

```
├── server/          # NestJS + LangGraph 后端(agent/graph 图、prompts/ 模板、rag/、llm/)
├── client/          # React + Vite 前端(ChatWindow + socket 层,含 vitest 测试)
├── data/            # RAG 知识库语料
├── docs/            # 规范文档
└── package.json     # npm workspaces 根配置
```

**技术栈**:NestJS 12 · @langchain/langgraph · Socket.IO · React 19 · Vite · Tailwind CSS 4

## 任务进度

**MS-001 智能问答与行程规划(已完成)**

- [x] Server:LangGraph 双图 + RAG 混合检索 + 会话历史 + SiliconFlow/Ollama Provider
- [x] Client:ChatWindow 容器、输入表单、消息/行程卡片渲染
- [x] 集成联调:取消链路 / 错误提示 / 生产构建修复(issue #24)

**待办**

- [ ] #27 真实 LLM 端到端验收与环境变量文档
- [ ] #28 RAG 语料扩充 → #29 向量检索持久化
- [ ] #30~#36 二期:行程导出 / 实时数据 / 地图等
