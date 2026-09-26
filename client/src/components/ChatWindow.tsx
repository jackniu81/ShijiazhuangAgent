import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { agentSocket } from '../lib/socket';
import {
  AgentEvents,
  type AppErrorEvent,
  type ChatAskPayload,
  type ChatDoneEvent,
  type ChatMessage,
  type ChatTokenEvent,
  type PlanCreatePayload,
  type PlanDayEvent,
  type PlanProgressEvent,
  type PlanResultEvent,
  type TravelPlan,
} from '../lib/types';
import Layout from './Layout';
import MessageList from './MessageList';
import PlanningForm from './PlanningForm';

// ---------- Session 持久化 ----------
const SESSION_KEY = 'shijiazhuang-agent-session-id';

function loadSessionId(): string {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) return stored;
  } catch {
    // 忽略(某些隐私模式 sessionStorage 可能不可用)
  }
  return makeId();
}

function persistSessionId(id: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, id);
  } catch {
    // 忽略
  }
}

// ---------- Last request(供重试) ----------
type LastRequest =
  | { kind: 'chat'; requestId: string; sessionId: string; question: string }
  | { kind: 'plan'; requestId: string; input: PlanCreatePayload['input'] }
  | null;

// ---------- State & Reducer ----------

interface ChatState {
  messages: ChatMessage[];
  sessionId: string;
  isConnected: boolean;
  isStreaming: boolean;
  pendingRequestId?: string;
  streamingMessageId?: string;
  streamingPlanId?: string;
  showPlanningForm: boolean;
  toast?: { code: string; message: string; recoverable: boolean };
}

type ChatAction =
  | { type: 'CONNECT' }
  | { type: 'DISCONNECT' }
  | { type: 'SEND_PLAN'; requestId: string; userMsg: string }
  | { type: 'PLAN_PROGRESS'; data: PlanProgressEvent }
  | { type: 'PLAN_DAY'; data: PlanDayEvent }
  | { type: 'PLAN_RESULT'; data: PlanResultEvent }
  | { type: 'SEND_CHAT'; requestId: string; question: string }
  | { type: 'CHAT_TOKEN'; data: ChatTokenEvent }
  | { type: 'CHAT_DONE'; data: ChatDoneEvent }
  | { type: 'APP_ERROR'; data: AppErrorEvent; recoverable: boolean }
  | { type: 'TIMEOUT' }
  | { type: 'CLEAR_TOAST' }
  | { type: 'TOGGLE_PLANNING_FORM'; show?: boolean };

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // jsdom fallback
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const RECOVERABLE_CODES: Set<AppErrorEvent['code']> = new Set(['LLM_ERROR', 'RAG_ERROR', 'INTERNAL']);

function reducer(state: ChatState, action: ChatAction): ChatState {
  const now = Date.now();

  switch (action.type) {
    case 'CONNECT':
      return { ...state, isConnected: true };

    case 'DISCONNECT':
      return { ...state, isConnected: false };

    case 'SEND_PLAN':
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: makeId(), role: 'user', content: action.userMsg, timestamp: now },
        ],
        pendingRequestId: action.requestId,
        isStreaming: true,
        showPlanningForm: false,
        toast: undefined,
      };

    case 'PLAN_PROGRESS': {
      if (state.pendingRequestId && action.data.requestId !== state.pendingRequestId) return state;
      const text = action.data.message ?? defaultProgressText(action.data.node, action.data.status);
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: makeId(), role: 'system', type: 'progress', content: text, timestamp: now },
        ],
      };
    }

    case 'PLAN_DAY': {
      if (state.pendingRequestId && action.data.requestId !== state.pendingRequestId) return state;
      const ev = action.data;

      if (!state.streamingPlanId) {
        // 首次:创建带占位的 streaming plan message
        const placeholderDays = Array.from({ length: ev.totalDays }, (_, i) => ({
          day: i + 1,
          items: [] as TravelPlan['days'][number]['items'],
        }));
        const planMsg: ChatMessage = {
          id: makeId(),
          role: 'assistant',
          kind: 'plan',
          plan: {
            title: ev.title ?? '行程规划中',
            days: placeholderDays,
            summary: ev.summary,
          },
          streaming: true,
          timestamp: now,
        };
        return {
          ...state,
          messages: [...state.messages, planMsg],
          streamingPlanId: planMsg.id,
        };
      }

      // 后续:追加到现有 plan message,替换对应 day
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== state.streamingPlanId || m.role !== 'assistant' || m.kind !== 'plan') return m;
          const updatedDays = m.plan.days.map((d) =>
            d.day === ev.day.day ? ev.day : d
          );
          return { ...m, plan: { ...m.plan, days: updatedDays } };
        }),
      };
    }

    case 'PLAN_RESULT': {
      if (state.pendingRequestId && action.data.requestId !== state.pendingRequestId) return state;
      const planMsg: ChatMessage = {
        id: makeId(),
        role: 'assistant',
        kind: 'plan',
        plan: action.data.plan,
        timestamp: now,
      };

      // 如果之前有 streaming plan message,替换它;否则直接追加
      if (state.streamingPlanId) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === state.streamingPlanId ? planMsg : m
          ),
          pendingRequestId: undefined,
          streamingPlanId: undefined,
          isStreaming: false,
          toast: undefined,
        };
      }

      return {
        ...state,
        messages: [...state.messages, planMsg],
        pendingRequestId: undefined,
        isStreaming: false,
        toast: undefined,
      };
    }

    case 'SEND_CHAT': {
      const msgId = makeId();
      const emptyAssistant: ChatMessage = {
        id: makeId(),
        role: 'assistant',
        kind: 'text',
        content: '',
        timestamp: now,
      };
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: msgId, role: 'user', content: action.question, timestamp: now },
          emptyAssistant,
        ],
        pendingRequestId: action.requestId,
        streamingMessageId: emptyAssistant.id,
        isStreaming: true,
        toast: undefined,
      };
    }

    case 'CHAT_TOKEN': {
      if (state.pendingRequestId && action.data.requestId !== state.pendingRequestId) return state;
      if (!state.streamingMessageId) return state;
      const token = action.data.token ?? '';
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === state.streamingMessageId && m.role === 'assistant' && m.kind === 'text'
            ? { ...m, content: m.content + token }
            : m
        ),
      };
    }

    case 'CHAT_DONE': {
      if (state.pendingRequestId && action.data.requestId !== state.pendingRequestId) return state;
      if (!state.streamingMessageId) return state;
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === state.streamingMessageId && m.role === 'assistant' && m.kind === 'text'
            ? { ...m, content: action.data.answer || m.content, sources: action.data.sources }
            : m
        ),
        pendingRequestId: undefined,
        streamingMessageId: undefined,
        isStreaming: false,
        toast: undefined,
      };
    }

    case 'APP_ERROR': {
      if (state.pendingRequestId && action.data.requestId !== state.pendingRequestId) return state;

      if (action.data.code === 'CANCELLED' && state.streamingMessageId) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === state.streamingMessageId && m.role === 'assistant' && m.kind === 'text'
              ? { ...m, cancelled: true }
              : m
          ),
          pendingRequestId: undefined,
          streamingMessageId: undefined,
          streamingPlanId: undefined,
          isStreaming: false,
          toast: undefined,
        };
      }

      // plan 流式构建中取消:标记已有的天数
      if (action.data.code === 'CANCELLED' && state.streamingPlanId) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === state.streamingPlanId && m.role === 'assistant' && m.kind === 'plan'
              ? { ...m, streaming: false }
              : m
          ),
          pendingRequestId: undefined,
          streamingPlanId: undefined,
          isStreaming: false,
          toast: undefined,
        };
      }

      if (action.data.code === 'INVALID_INPUT') {
        // INVALID_INPUT: PlanningForm 内部校验兜底,这里不再追加 system 消息
        return {
          ...state,
          pendingRequestId: undefined,
          streamingMessageId: undefined,
          streamingPlanId: undefined,
          isStreaming: false,
          toast: {
            code: 'INVALID_INPUT',
            message: action.data.message || '输入有误,请检查后重试',
            recoverable: true,
          },
        };
      }

      // 其它错误 → 显示 toast + 追加 system error 消息
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: makeId(),
            role: 'system',
            type: 'error',
            content: action.data.message || '抱歉,服务暂时不可用',
            timestamp: now,
          },
        ],
        pendingRequestId: undefined,
        streamingMessageId: undefined,
        streamingPlanId: undefined,
        isStreaming: false,
        toast: {
          code: action.data.code,
          message: action.data.message || '抱歉,服务暂时不可用',
          recoverable: action.recoverable,
        },
      };
    }

    case 'TIMEOUT':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: makeId(),
            role: 'system',
            type: 'error',
            content: '响应超时,请重试',
            timestamp: now,
          },
        ],
        pendingRequestId: undefined,
        streamingMessageId: undefined,
        streamingPlanId: undefined,
        isStreaming: false,
        toast: { code: 'TIMEOUT', message: '响应超时,请重试', recoverable: true },
      };

    case 'CLEAR_TOAST':
      return { ...state, toast: undefined };

    case 'TOGGLE_PLANNING_FORM':
      return { ...state, showPlanningForm: action.show ?? !state.showPlanningForm };

    default:
      return state;
  }
}

function defaultProgressText(node: PlanProgressEvent['node'], status: PlanProgressEvent['status']): string {
  if (status === 'finish') {
    switch (node) {
      case 'retrieve': return '✅ 景点资料已准备';
      case 'plan': return '✅ 行程已生成';
      case 'refine': return '✅ 行程已优化';
      case 'done': return '✅ 完成';
    }
  }
  switch (node) {
    case 'retrieve': return '🔍 正在检索景点资料…';
    case 'plan': return '🧠 正在生成行程…';
    case 'refine': return '✨ 正在优化行程…';
    case 'done': return '⏳ 准备中…';
  }
}

// ---------- Component ----------

export default function ChatWindow() {
  const [sessionId] = useState<string>(() => loadSessionId());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastRequestRef = useRef<LastRequest>(null);

  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    sessionId,
    isConnected: false,
    isStreaming: false,
    pendingRequestId: undefined,
    streamingMessageId: undefined,
    streamingPlanId: undefined,
    showPlanningForm: false,
    toast: undefined,
  });

  // ---------- Socket 连接 + 事件监听 ----------
  useEffect(() => {
    agentSocket.connect();

    const onStateChange = (connected: boolean) =>
      dispatch(connected ? { type: 'CONNECT' } : { type: 'DISCONNECT' });

    const onPlanProgress = (data: PlanProgressEvent) => {
      resetTimeout();
      dispatch({ type: 'PLAN_PROGRESS', data });
    };
    const onPlanDay = (data: PlanDayEvent) => {
      resetTimeout();
      dispatch({ type: 'PLAN_DAY', data });
    };
    const onPlanResult = (data: PlanResultEvent) => {
      clearTimeoutRef();
      dispatch({ type: 'PLAN_RESULT', data });
      // 成功 → 清除 lastRequest(已完成)
      lastRequestRef.current = null;
    };
    const onChatToken = (data: ChatTokenEvent) => {
      resetTimeout();
      dispatch({ type: 'CHAT_TOKEN', data });
    };
    const onChatDone = (data: ChatDoneEvent) => {
      clearTimeoutRef();
      dispatch({ type: 'CHAT_DONE', data });
      lastRequestRef.current = null;
    };
    const onAppError = (data: AppErrorEvent) => {
      clearTimeoutRef();
      const recoverable = RECOVERABLE_CODES.has(data.code);
      dispatch({ type: 'APP_ERROR', data, recoverable });
      if (data.code === 'CANCELLED') lastRequestRef.current = null;
    };

    agentSocket.onConnectionChange(onStateChange);
    agentSocket.on(AgentEvents.PLAN_PROGRESS, onPlanProgress);
    agentSocket.on(AgentEvents.PLAN_DAY, onPlanDay);
    agentSocket.on(AgentEvents.PLAN_RESULT, onPlanResult);
    agentSocket.on(AgentEvents.CHAT_TOKEN, onChatToken);
    agentSocket.on(AgentEvents.CHAT_DONE, onChatDone);
    agentSocket.on(AgentEvents.APP_ERROR, onAppError);

    onStateChange(agentSocket.connected);

    return () => {
      agentSocket.offConnectionChange(onStateChange);
      agentSocket.off(AgentEvents.PLAN_PROGRESS, onPlanProgress);
      agentSocket.off(AgentEvents.PLAN_DAY, onPlanDay);
      agentSocket.off(AgentEvents.PLAN_RESULT, onPlanResult);
      agentSocket.off(AgentEvents.CHAT_TOKEN, onChatToken);
      agentSocket.off(AgentEvents.CHAT_DONE, onChatDone);
      agentSocket.off(AgentEvents.APP_ERROR, onAppError);
      clearTimeoutRef();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // sessionId 持久化
  useEffect(() => {
    persistSessionId(sessionId);
  }, [sessionId]);

  // ---------- 超时计时器 ----------
  const clearTimeoutRef = () => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };
  const resetTimeout = () => {
    clearTimeoutRef();
    timeoutRef.current = setTimeout(() => {
      dispatch({ type: 'TIMEOUT' });
    }, 15000);
  };

  const startTimeout = () => resetTimeout();

  // ---------- 发送动作 ----------

  const canSubmit = () => state.isConnected && !state.isStreaming;

  const handleSendChat = () => {
    if (!canSubmit()) return;
    const el = textareaRef.current;
    const text = el?.value?.trim() ?? '';
    if (!text) return;

    const requestId = makeId();
    lastRequestRef.current = { kind: 'chat', requestId, sessionId, question: text };
    dispatch({ type: 'SEND_CHAT', requestId, question: text });
    el!.value = '';
    startTimeout();

    const payload: ChatAskPayload = { requestId, sessionId, question: text };
    agentSocket.ask(payload);
  };

  const handlePlanSubmit = (input: PlanCreatePayload['input']) => {
    if (!canSubmit()) return;

    const requestId = makeId();
    lastRequestRef.current = { kind: 'plan', requestId, input };

    const parts: string[] = [`规划 ${input.days} 天行程`];
    if (input.startDate) parts.push(`出发 ${input.startDate}`);
    if (input.travelers) parts.push(`${input.travelers} 人`);
    if (input.interests?.length) parts.push(`兴趣:${input.interests.join('/')}`);
    const userMsg = parts.join(' · ');

    dispatch({ type: 'SEND_PLAN', requestId, userMsg });
    startTimeout();

    agentSocket.createPlan({ requestId, input });
  };

  const handleStop = () => {
    if (!state.pendingRequestId) return;
    agentSocket.cancel(state.pendingRequestId);
    clearTimeoutRef();
  };

  const handleRetry = () => {
    const last = lastRequestRef.current;
    if (!last || !canSubmit()) return;

    if (last.kind === 'chat') {
      const requestId = makeId();
      lastRequestRef.current = { ...last, requestId };
      dispatch({ type: 'SEND_CHAT', requestId, question: last.question });
      startTimeout();
      agentSocket.ask({ requestId, sessionId: last.sessionId, question: last.question });
    } else {
      const requestId = makeId();
      lastRequestRef.current = { ...last, requestId };
      const parts: string[] = [`规划 ${last.input.days} 天行程(重试)`];
      if (last.input.startDate) parts.push(`出发 ${last.input.startDate}`);
      const userMsg = parts.join(' · ');
      dispatch({ type: 'SEND_PLAN', requestId, userMsg });
      startTimeout();
      agentSocket.createPlan({ requestId, input: last.input });
    }
    dispatch({ type: 'CLEAR_TOAST' });
  };

  const handleTextareaKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendChat();
    }
  };

  // ---------- Toast 自动消失 ----------
  useEffect(() => {
    if (!state.toast) return;
    const t = setTimeout(() => dispatch({ type: 'CLEAR_TOAST' }), 6000);
    return () => clearTimeout(t);
  }, [state.toast]);

  // ---------- Render ----------

  const toast = state.toast && (
    <div
      className={[
        'flex items-center gap-2 rounded-lg px-3 py-2 text-xs shadow-sm ring-1 animate-slide-up',
        state.toast.recoverable
          ? 'bg-amber-50 text-amber-700 ring-amber-200'
          : 'bg-red-50 text-red-700 ring-red-200',
      ].join(' ')}
      role="alert"
      data-testid="error-toast"
    >
      <span>⚠️ {state.toast.message}</span>
      <div className="ml-auto flex items-center gap-2">
        {state.toast.recoverable && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={!canSubmit()}
            className="rounded bg-amber-500 px-2 py-0.5 text-[11px] font-medium text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="retry-btn"
          >
            重试
          </button>
        )}
        <button
          type="button"
          onClick={() => dispatch({ type: 'CLEAR_TOAST' })}
          className="text-slate-400 hover:text-slate-600"
        >
          ✕
        </button>
      </div>
    </div>
  );

  const footer = (
    <div className="flex flex-col gap-2 pt-1">
      {toast}

      {state.showPlanningForm && (
        <PlanningForm
          onSubmit={handlePlanSubmit}
          submitting={state.isStreaming || !state.isConnected}
        />
      )}

      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => dispatch({ type: 'TOGGLE_PLANNING_FORM' })}
          disabled={!state.isConnected || state.isStreaming}
          className={[
            'shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition',
            state.showPlanningForm
              ? 'bg-emerald-500 text-white hover:bg-emerald-600'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
            !state.isConnected || state.isStreaming ? 'cursor-not-allowed opacity-50' : '',
          ].join(' ')}
        >
          📋 规划行程
        </button>

        <textarea
          ref={textareaRef}
          placeholder={state.showPlanningForm ? '或直接输入问题…' : '输入你的问题…'}
          rows={1}
          onKeyDown={handleTextareaKey}
          disabled={!state.isConnected || state.isStreaming}
          className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-100"
          data-testid="chat-input"
        />

        {state.isStreaming ? (
          <button
            type="button"
            onClick={handleStop}
            className="shrink-0 rounded-md bg-red-500 px-4 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-red-600"
            data-testid="stop-btn"
          >
            ⏹ 停止
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSendChat}
            disabled={!canSubmit()}
            className="shrink-0 rounded-md bg-emerald-500 px-4 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="send-btn"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );

  return (
    <Layout footer={footer}>
      <MessageList
        messages={state.messages}
        streamingId={state.streamingMessageId}
      />
    </Layout>
  );
}
