import { useEffect, useReducer, useRef, type KeyboardEvent } from 'react';
import { agentSocket } from '../lib/socket';
import {
  AgentEvents,
  type AppErrorEvent,
  type ChatDoneEvent,
  type ChatMessage,
  type ChatTokenEvent,
  type PlanCreatePayload,
  type PlanProgressEvent,
  type PlanResultEvent,
} from '../lib/types';
import Layout from './Layout';
import MessageList from './MessageList';
import PlanningForm from './PlanningForm';

// ---------- State & Reducer ----------

interface ChatState {
  messages: ChatMessage[];
  sessionId: string;
  isConnected: boolean;
  isStreaming: boolean;
  pendingRequestId?: string;
  streamingMessageId?: string;
  showPlanningForm: boolean;
}

type ChatAction =
  | { type: 'CONNECT' }
  | { type: 'DISCONNECT' }
  | { type: 'SEND_PLAN'; requestId: string; userMsg: string }
  | { type: 'PLAN_PROGRESS'; data: PlanProgressEvent }
  | { type: 'PLAN_RESULT'; data: PlanResultEvent }
  | { type: 'SEND_CHAT'; requestId: string; question: string }
  | { type: 'CHAT_TOKEN'; data: ChatTokenEvent }
  | { type: 'CHAT_DONE'; data: ChatDoneEvent }
  | { type: 'APP_ERROR'; data: AppErrorEvent }
  | { type: 'TIMEOUT' }
  | { type: 'TOGGLE_PLANNING_FORM'; show?: boolean };

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // jsdom fallback
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

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

    case 'PLAN_RESULT': {
      if (state.pendingRequestId && action.data.requestId !== state.pendingRequestId) return state;
      const planMsg: ChatMessage = {
        id: makeId(),
        role: 'assistant',
        kind: 'plan',
        plan: action.data.plan,
        timestamp: now,
      };
      return {
        ...state,
        messages: [...state.messages, planMsg],
        pendingRequestId: undefined,
        isStreaming: false,
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
      // 用完整 answer 兜底（与 token 拼接一致,容错）,附加 sources
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
      };
    }

    case 'APP_ERROR': {
      if (state.pendingRequestId && action.data.requestId !== state.pendingRequestId) return state;

      if (action.data.code === 'CANCELLED' && state.streamingMessageId) {
        // 流式中途取消 → 在 assistant 消息标记 cancelled
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === state.streamingMessageId && m.role === 'assistant' && m.kind === 'text'
              ? { ...m, cancelled: true }
              : m
          ),
          pendingRequestId: undefined,
          streamingMessageId: undefined,
          isStreaming: false,
        };
      }

      const isUserError = action.data.code === 'INVALID_INPUT';
      return {
        ...state,
        messages: isUserError
          ? state.messages // INVALID_INPUT 不新添消息,直接忽略(PlanningForm 内部处理)
          : [
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
        isStreaming: false,
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
        isStreaming: false,
      };

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
  const sessionIdRef = useRef<string>('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  if (!sessionIdRef.current) {
    sessionIdRef.current = makeId();
  }

  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    sessionId: sessionIdRef.current,
    isConnected: false,
    isStreaming: false,
    pendingRequestId: undefined,
    streamingMessageId: undefined,
    showPlanningForm: false,
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
    const onPlanResult = (data: PlanResultEvent) => {
      clearTimeoutRef();
      dispatch({ type: 'PLAN_RESULT', data });
    };
    const onChatToken = (data: ChatTokenEvent) => {
      resetTimeout();
      dispatch({ type: 'CHAT_TOKEN', data });
    };
    const onChatDone = (data: ChatDoneEvent) => {
      clearTimeoutRef();
      dispatch({ type: 'CHAT_DONE', data });
    };
    const onAppError = (data: AppErrorEvent) => {
      clearTimeoutRef();
      dispatch({ type: 'APP_ERROR', data });
    };

    agentSocket.onConnectionChange(onStateChange);
    agentSocket.on(AgentEvents.PLAN_PROGRESS, onPlanProgress);
    agentSocket.on(AgentEvents.PLAN_RESULT, onPlanResult);
    agentSocket.on(AgentEvents.CHAT_TOKEN, onChatToken);
    agentSocket.on(AgentEvents.CHAT_DONE, onChatDone);
    agentSocket.on(AgentEvents.APP_ERROR, onAppError);

    // 初始状态
    onStateChange(agentSocket.connected);

    return () => {
      agentSocket.offConnectionChange(onStateChange);
      agentSocket.off(AgentEvents.PLAN_PROGRESS, onPlanProgress);
      agentSocket.off(AgentEvents.PLAN_RESULT, onPlanResult);
      agentSocket.off(AgentEvents.CHAT_TOKEN, onChatToken);
      agentSocket.off(AgentEvents.CHAT_DONE, onChatDone);
      agentSocket.off(AgentEvents.APP_ERROR, onAppError);
      clearTimeoutRef();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const handleSendChat = () => {
    const el = textareaRef.current;
    const text = el?.value?.trim() ?? '';
    if (!text || state.isStreaming) return;

    const requestId = makeId();
    dispatch({ type: 'SEND_CHAT', requestId, question: text });
    el!.value = '';
    startTimeout();

    agentSocket.ask({
      requestId,
      sessionId: sessionIdRef.current,
      question: text,
    });
  };

  const handlePlanSubmit = (input: PlanCreatePayload['input']) => {
    if (state.isStreaming) return;

    const requestId = makeId();
    // 构造用户可视化消息
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

  const handleTextareaKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendChat();
    }
  };

  // ---------- Render ----------

  const footer = (
    <div className="flex flex-col gap-2 pt-1">
      {/* PlanningForm 条件展开 */}
      {state.showPlanningForm && (
        <PlanningForm
          onSubmit={handlePlanSubmit}
          submitting={state.isStreaming}
        />
      )}

      {/* 输入区 */}
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => dispatch({ type: 'TOGGLE_PLANNING_FORM' })}
          disabled={state.isStreaming}
          className={[
            'shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition',
            state.showPlanningForm
              ? 'bg-emerald-500 text-white hover:bg-emerald-600'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
            state.isStreaming ? 'cursor-not-allowed opacity-50' : '',
          ].join(' ')}
        >
          📋 规划行程
        </button>

        <textarea
          ref={textareaRef}
          placeholder={state.showPlanningForm ? '或直接输入问题…' : '输入你的问题…'}
          rows={1}
          onKeyDown={handleTextareaKey}
          disabled={state.isStreaming}
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
            disabled={!state.isConnected}
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
