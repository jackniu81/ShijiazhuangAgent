# 石家庄旅游助手 AI Agent

基于 LangGraph + RAG + LLM 的石家庄旅游智能助手,支持行程规划和旅游问答。

## 架构

```
┌──────────────┐   WebSocket (Socket.IO)   ┌──────────────────────┐
│  Client (React) │ ◄──────────────────────► │  Server (NestJS)      │
│  chat window   │   /agent namespace        │  AgentGateway         │
└──────────────┘                             │  AgentService        │
                                             │  LangGraph + RAG     │
                                             │  LLM (SiliconFlow)   │
                                             └──────────────────────┘
```

## 快速开始

```bash
# 安装依赖
npm install

# 启动 server (http://localhost:3000)
npm run dev:server

# 启动 client (http://localhost:5173)
npm run dev:client
```

## 文档

| 文件 | 说明 |
|------|------|
| [docs/api-spec.md](docs/api-spec.md) | WebSocket API 规范(Server / Client 契约) |
| [docs/ui-spec.md](docs/ui-spec.md) | Client UI 实现规范 |
| [require.md](require.md) | 原始需求 |

## 项目结构

```
├── server/          # NestJS + LangGraph 后端
├── client/          # React + Vite 前端
├── docs/            # 规范文档
└── package.json     # 根 workspace 配置
```

## Client 开发

```bash
cd client
npm install
npm run dev          # Vite dev server,代理 /api 和 /ws 到 server
npm run build        # 生产构建
```

**技术栈**:React 19 · Vite 8 · Tailwind CSS 4 · Socket.IO Client

**TODO**
- [ ] Task #1: API 规范 ✅ (docs/api-spec.md)
- [ ] Task #2: Server 实现
- [ ] Task #3: UI 实现 (docs/ui-spec.md)
