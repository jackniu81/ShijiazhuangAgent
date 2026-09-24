# 石家庄旅游助手 AI Agent

基于 LangGraph + RAG + LLM 的石家庄旅游智能助手,支持行程规划和旅游问答。

## 架构

```
┌──────────────────┐   WebSocket (Socket.IO)    ┌───────────────────────────┐
│  Client (React)  │ ◄────────────────────────► │  Server (NestJS)          │
│  chat window     │   /agent namespace /ws     │  AgentGateway             │
└──────────────────┘                            │  AgentService + 会话历史   |
                                                │  LangGraph(chat/plan 图)  │
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

# 启动 server (http://localhost:3000)
npm run dev:server
  
# 启动 client (http://localhost:5173)
npm run dev:client
 
# 运行 server 单元测试
npm run test -w server
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
├── server/          # NestJS + LangGraph 后端(含 jest 单元测试)
├── client/          # React + Vite 前端
├── data/            # RAG 知识库语料
├── docs/            # 规范文档
└── package.json     # npm workspaces 根配置
```

**技术栈**:NestJS 12 · @langchain/langgraph · Socket.IO · React 19 · Vite · Tailwind CSS 4

## 任务进度

- [x] Task #1: API 规范 (docs/api-spec.md)
- [x] Task #2: Server 实现(问答/行程规划/混合检索/多轮上下文/真实 LLM Provider)
- [ ] Task #3: Client UI 实现(消息渲染组件已落地,联调进行中)
