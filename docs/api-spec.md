# 石家庄旅游助手 — WebSocket API 规范

> Task #1:定义 UI(Client)与 Server 的集成接口。本文档是双方唯一契约,后续实现须严格对齐。

## 1. 传输方式

- **协议**:Socket.IO(NestJS `@nestjs/websockets` + `socket.io`)
- **地址**:与 HTTP 服务同源,`ws://localhost:3000/ws`(namespace:`/agent`)
- 开发模式下 Vite 代理 `/ws` 到 server,生产模式同域,无需额外配置
- 事件名采用 `域:动作` 小写冒号分隔,如 `plan:create`

## 2. 通用约定

- 每次"提问 / 生成行程"是一个 **请求(request)**,由 client 生成 `requestId`(uuid)贯穿整个响应链路
- 所有 payload 均为 JSON 对象
- 服务端任意环节失败,统一发 `app:error`,client 按 `requestId` 关联到对应请求

## 3. Client → Server

### 3.1 `plan:create` — 生成旅游行程
```ts
interface PlanCreatePayload {
  requestId: string;
  input: {
    days: number;              // 行程天数 1-7
    startDate?: string;        // 出发日期 YYYY-MM-DD,缺省为"最近周末"
    travelers?: number;        // 人数,默认 1
    budget?: 'economy' | 'comfort' | 'luxury';
    interests?: string[];      // 兴趣标签,如 ['历史','美食','亲子']
    preferences?: string;      // 自由文本,如 "带老人,少爬山"
  };
}
```

### 3.2 `chat:ask` — 旅游问答(RAG)
```ts
interface ChatAskPayload {
  requestId: string;
  sessionId: string;           // 会话 id,server 端据此维护多轮上下文
  question: string;
}
```

### 3.3 `task:cancel` — 取消进行中的请求(如停止流式生成)
```ts
interface TaskCancelPayload {
  requestId: string;
}
```

## 4. Server → Client

### 4.1 `plan:progress` — LangGraph 节点进度(每个节点开始/完成各推一次)
```ts
interface PlanProgressEvent {
  requestId: string;
  node: 'retrieve' | 'plan' | 'refine' | 'done';  // RAG检索 → 生成计划 → 优化
  status: 'start' | 'finish';
  message?: string;            // 展示用文案,如 "正在检索景点资料…"
}
```

### 4.2 `plan:result` — 最终行程
```ts
interface PlanResultEvent {
  requestId: string;
  plan: {
    title: string;
    days: PlanDay[];
    summary?: string;
    tips?: string[];           // 通用提示(天气、交通等)
  };
}

interface PlanDay {
  day: number;                 // 第几天,从 1 开始
  items: PlanItem[];
}

interface PlanItem {
  time?: string;               // "09:00",可为空(弹性安排)
  title: string;               // 活动名
  place?: string;              // 地点
  description?: string;        // 推荐理由 / 玩法
  tips?: string;               // 小贴士
}
```

### 4.3 `chat:token` — LLM 流式输出(逐 token)
```ts
interface ChatTokenEvent {
  requestId: string;
  sessionId: string;
  token: string;
}
```

### 4.4 `chat:done` — 回答完成
```ts
interface ChatDoneEvent {
  requestId: string;
  sessionId: string;
  answer: string;              // 完整文本(与 token 拼接结果一致,便于容错)
  sources?: string[];          // RAG 引用的本地文件,如 "景点/正定古城.md"
}
```

### 4.5 `app:error` — 统一错误
```ts
interface AppErrorEvent {
  requestId?: string;          // 连接级错误时为空
  code: 'INVALID_INPUT' | 'LLM_ERROR' | 'RAG_ERROR' | 'CANCELLED' | 'INTERNAL';
  message: string;             // 可直接展示给用户的中文文案
}
```

## 5. 交互时序

```
Client                                 Server (LangGraph + RAG + LLM)
  │  connect /ws (namespace /agent)       │
  │──────────────────────────────────────>│
  │  plan:create {requestId}              │
  │──────────────────────────────────────>│
  │  plan:progress  retrieve/start        │
  │<──────────────────────────────────────│
  │  plan:progress  plan/finish ...       │
  │<──────────────────────────────────────│
  │  plan:result                          │
  │<──────────────────────────────────────│
  │                                       │
  │  chat:ask {requestId, sessionId}      │
  │──────────────────────────────────────>│
  │  chat:token × N        (流式)          │
  │<─ ─<─ ─<─ ─<─ ─<─ ─<─ ─<─ ─<─ ─<─ ─ ─│
  │  chat:done                            │
  │<──────────────────────────────────────│
```

## 6. HTTP 保留接口

现有 `/api/version` 保持不变,仅用于健康检查;所有 Agent 能力一律走 WebSocket。

## 7. 实现约定(供 Task #2+ 参考)

- 上述 TS 类型后续抽取到 `shared/types.ts`(或先各自复制),client 与 server 保持一致
- client 侧封装单例 socket:`connect() / createPlan() / ask() / cancel()`,事件按 requestId 分发
- server 侧:`AgentGateway`(@WebSocketGateway namespace `/agent`)+ `AgentService`(编排 LangGraph)
