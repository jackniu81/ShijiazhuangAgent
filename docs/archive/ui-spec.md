# UI 规范 — 石家庄旅游助手 Chat 窗口

> Task #3: Client 实现。基于 `docs/api-spec.md`，仅修改 `client/` 目录。
> 📦 **已归档**（2026-09-26）:本规范已全部实现并超出(错误 toast、断线重连、plan:day 逐日流式渲染、chat.reducer 状态机);当前状态以代码为准,进度与剩余工作见 [docs/todo.md](../todo.md)。

## 1. 功能范围

单页聊天窗口,支持两种交互模式:

| 模式 | 触发事件 | 说明 |
|------|----------|------|
| **行程规划** | `plan:create` | 用户填写表单(天数/日期/人数/预算/兴趣),服务端返回完整行程卡片 |
| **自由问答** | `chat:ask` | 多轮对话,RAG 检索,LLM 流式输出 |

底部输入框智能切换:检测到用户意图为规划时显示表单卡片,否则走文本聊天。

## 2. 页面布局

```
┌─────────────────────────────────────────────┐
│  header: 石家庄旅游助手  ● connect status   │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─ assistant ──────────────────────────┐  │
│  │  你好!我是石家庄旅游助手,可以帮你规划   │  │
│  │  行程或回答关于石家庄的任何问题~        │  │
│  └──────────────────────────────────────┘  │
│                                             │
│  ┌─ user ────────────────────────────────┐  │
│  │  帮我规划一个2天的周末游               │  │
│  └──────────────────────────────────────┘  │
│                                             │
│  ┌─ assistant (plan result) ──────────────┐ │
│  │  📋 石家庄2日游                         │ │
│  │  Day 1: 正定古城 → 隆兴寺 ...          │ │
│  │  Day 2: 西柏坡纪念馆 ...               │ │
│  │  💡 小贴士: ...                        │ │
│  └──────────────────────────────────────┘  │
│                                             │
│  ┌─ assistant (streaming) ────────────────┐ │
│  │  (逐 token 追加显示,打字机效果)         │ │
│  └──────────────────────────────────────┘  │
│                                             │
├─────────────────────────────────────────────┤
│  [规划按钮]   [文本输入框.........] [发送]  │
└─────────────────────────────────────────────┘
```

## 3. 组件结构

```
client/src/
├── components/
│   ├── Layout.tsx            # 保留:header + main + footer
│   ├── ChatWindow.tsx        # 主容器:消息列表 + 输入区
│   ├── MessageList.tsx       # 消息滚动列表,自动滚到底
│   ├── MessageItem.tsx       # 单条消息(user / assistant / system)
│   ├── PlanCard.tsx          # 行程结果卡片(渲染 PlanDay[])
│   ├── StreamingText.tsx     # 打字机效果组件(chat:token 累加)
│   ├── PlanningForm.tsx      # 行程规划表单
│   └── ConnectionStatus.tsx  # 连接状态指示器
├── lib/
│   ├── socket.ts             # Socket.IO 单例封装
│   └── types.ts              # API 类型定义(对齐 api-spec.md)
├── App.tsx                   # 路由简化:只有 / → ChatWindow
└── index.css                 # 全局样式(保留 Tailwind)
```

**删除/清理**: Welcome.tsx、About.tsx、NotFound.tsx、api.ts(替换为 socket.ts)、react-router 依赖可移除。

## 4. 状态管理

单组件 `useReducer` 或分散 `useState`,无需 Zustand/Redux。核心状态:

```ts
interface ChatState {
  messages: Message[];              // 所有消息
  sessionId: string;                // chat:ask 用的会话 id
  isConnected: boolean;             // socket 连接状态
  isStreaming: boolean;             // 是否正在流式输出
  pendingRequestId?: string;        // 当前进行中的请求,用于取消
}

type Message =
  | { id: string; role: 'user'; content: string; timestamp: number }
  | { id: string; role: 'assistant'; kind: 'text'; content: string; sources?: string[]; timestamp: number }
  | { id: string; role: 'assistant'; kind: 'plan'; plan: PlanResultEvent['plan']; timestamp: number }
  | { id: string; role: 'system'; content: string; type: 'progress' | 'error'; timestamp: number };
```

## 5. Socket.IO 封装

```ts
// lib/socket.ts
import { io, Socket } from 'socket.io-client';

class AgentSocket {
  private socket: Socket | null = null;
  private listeners = new Map<string, Function[]>();

  connect() { /* 连接 /agent namespace */ }
  disconnect() {}
  on(event: string, cb: Function) {}
  off(event: string, cb: Function) {}

  createPlan(input: PlanCreatePayload['input']) {}  // emit plan:create
  ask(question: string) {}                          // emit chat:ask
  cancel(requestId: string) {}                       // emit task:cancel
}

export const agentSocket = new AgentSocket();
```

**依赖新增**: `socket.io-client`(替换 `axios`)。

## 6. 事件处理流程

### 6.1 行程规划流
```
用户填表单 → emit plan:create {requestId, input}
  ← plan:progress (展示在 system 消息)
  ← plan:progress (继续)
  ← plan:result (渲染为 PlanCard)
  ← app:error (渲染为 error system 消息)
```

### 6.2 问答流
```
用户发消息 → emit chat:ask {requestId, sessionId, question}
  ← chat:token × N → 追加到当前 assistant 消息
  ← chat:done → 标记完成,附加 sources
  ← app:error (同上)
```

### 6.3 取消
```
用户点"停止"按钮 → emit task:cancel {requestId}
  ← app:error { code: 'CANCELLED' } 或服务端静默终止
```

## 7. 视觉设计

- **风格**:简洁现代,Tailwind CSS,深色/浅色自动跟随系统
- **配色**:主色 slate + accent emerald(石家庄 正定古城 元素暗示)
- **头像**:user 用圆形渐变,assistant 用 🤖 emoji 或简化图标
- **动画**:
  - 打字机光标闪烁(CSS `@keyframes blink`)
  - 连接状态指示器脉冲(`animate-pulse`)
  - 新消息滑入(`animate-slide-up`)
- **响应式**:移动端和桌面端,消息区最大宽度 3xl

## 8. 输入区交互

- 默认显示 **文本输入框** + 发送按钮
- 点击 "规划行程" 按钮 → 展开 PlanningForm 表单卡片(天数/日期/人数/预算/兴趣标签选择)
- 流式输出中 → 发送按钮变为 **停止** 按钮
- Enter 发送(Shift+Enter 换行),移动端适配

## 9. 错误处理

| 场景 | 处理 |
|------|------|
| WebSocket 断线 | header 显示红色 "● 未连接",自动重连 3 次,失败提示手动刷新 |
| `app:error` INVALID_INPUT | toast 提示,不清空已填表单 |
| `app:error` LLM_ERROR / RAG_ERROR | assistant 消息显示 "抱歉,服务暂时不可用" |
| `app:error` CANCELLED | assistant 消息末尾加 ~~(已停止)~~ 标记 |
| 网络超时(15s 无任何事件) | 提示 "响应超时,请重试" |

## 10. Vite 代理补充

当前 `vite.config.ts` 缺少 `/ws` 代理,需补充:

```ts
proxy: {
  '/api': { target: 'http://localhost:3000', changeOrigin: true },
  '/ws':  { target: 'http://localhost:3000', changeOrigin: true, ws: true },
},
```

## 11. 验收标准

1. ✅ `npm run dev` 后页面可访问,header 连接状态变绿
2. ✅ 发送规划请求 → 看到 progress 提示 → 最终行程卡片渲染完整
3. ✅ 发送问答 → token 逐字显示(打字机效果)
4. ✅ 多轮对话保持 sessionId,上下文连贯
5. ✅ 停止按钮可中断流式输出
6. ✅ 断线重连、错误提示正常
7. ✅ 移动端布局无错乱
