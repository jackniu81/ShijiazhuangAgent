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

**当前进度** (Task #3 — UI 实现):

| 步骤 | 内容 | 状态 |
|------|------|------|
| 1 | 工程准备:依赖替换 + 旧页面清理 + Vite `/ws` 代理 | ✅ 完成 |
| 2 | 数据层:`lib/types.ts` + `lib/socket.ts` | ✅ 完成 |
| 3 | Layout 改连接状态指示器 | 🔜 待做 |
| 4 | 核心组件:ChatWindow / MessageList / MessageItem + App.tsx 路由清理 | 🔜 待做 |
| 5 | 功能组件:PlanCard / PlanningForm / StreamingText | 🔜 待做 |
| 6 | 错误处理 + 样式 + 验收 | 🔜 待做 |

> ⚠️ `npm run build` 当前会失败,App.tsx 仍引用 Step 1 已删除的页面;Step 4 完成后恢复。

**变更日志**

- Step 1:移除 `axios` / `react-router` / 旧 Welcome/About/NotFound 页面 / `lib/api.ts`;新增 `socket.io-client`;Vite 补 `/ws` 代理
- Step 2:新增 `lib/types.ts`(对齐 server `agent.types.ts` + UI 消息类型)、`lib/socket.ts`(`AgentSocket` 单例,namespace `/agent`,path `/ws`)
