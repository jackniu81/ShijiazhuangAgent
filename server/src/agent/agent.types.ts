/**
 * WebSocket API 契约类型 —— 严格对齐 docs/api-spec.md
 * server 与 client 共用,后续可抽取到 shared/。
 */

// ---------- 事件名 ----------
export const AgentEvents = {
  // client -> server
  PLAN_CREATE: 'plan:create',
  CHAT_ASK: 'chat:ask',
  TASK_CANCEL: 'task:cancel',
  // server -> client
  PLAN_PROGRESS: 'plan:progress',
  PLAN_RESULT: 'plan:result',
  CHAT_TOKEN: 'chat:token',
  CHAT_DONE: 'chat:done',
  APP_ERROR: 'app:error',
} as const;

// ---------- Client -> Server payload ----------
export interface PlanCreatePayload {
  requestId: string;
  input: {
    days: number;
    startDate?: string;
    travelers?: number;
    budget?: 'economy' | 'comfort' | 'luxury';
    interests?: string[];
    preferences?: string;
  };
}

export interface ChatAskPayload {
  requestId: string;
  sessionId: string;
  question: string;
}

export interface TaskCancelPayload {
  requestId: string;
}

// ---------- Server -> Client events ----------
export type PlanNode = 'retrieve' | 'plan' | 'refine' | 'done';
export type NodeStatus = 'start' | 'finish';

export interface PlanProgressEvent {
  requestId: string;
  node: PlanNode;
  status: NodeStatus;
  message?: string;
}

export interface PlanItem {
  time?: string;
  title: string;
  place?: string;
  description?: string;
  tips?: string;
}

export interface PlanDay {
  day: number;
  items: PlanItem[];
}

export interface TravelPlan {
  title: string;
  days: PlanDay[];
  summary?: string;
  tips?: string[];
}

export interface PlanResultEvent {
  requestId: string;
  plan: TravelPlan;
}

export interface ChatTokenEvent {
  requestId: string;
  sessionId: string;
  token: string;
}

export interface ChatDoneEvent {
  requestId: string;
  sessionId: string;
  answer: string;
  sources?: string[];
}

export type AppErrorCode =
  | 'INVALID_INPUT'
  | 'LLM_ERROR'
  | 'RAG_ERROR'
  | 'CANCELLED'
  | 'INTERNAL';

export interface AppErrorEvent {
  requestId?: string;
  code: AppErrorCode;
  message: string;
}
