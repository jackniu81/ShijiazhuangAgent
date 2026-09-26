import {
  type AppErrorEvent,
  type ChatDoneEvent,
  type ChatMessage,
  type ChatTokenEvent,
  type PlanDayEvent,
  type PlanProgressEvent,
  type PlanResultEvent,
  type TravelPlan,
} from '../lib/types';

/**
 * ChatWindow 状态机(issue #49 自 ChatWindow.tsx 抽出,行为零变更)。
 * reducer 保持纯函数,idFactory 注入以便测试断言消息 id。
 */

export interface ChatState {
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

export type ChatAction =
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

/** 可直接一键重试的错误码(与 ChatWindow toast 渲染联动)。 */
export const RECOVERABLE_CODES: Set<AppErrorEvent['code']> = new Set([
  'LLM_ERROR',
  'RAG_ERROR',
  'INTERNAL',
]);

export const initialChatState = (sessionId: string): ChatState => ({
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

export function defaultProgressText(
  node: PlanProgressEvent['node'],
  status: PlanProgressEvent['status'],
): string {
  if (status === 'finish') {
    switch (node) {
      case 'retrieve': return '✅ 景点资料已准备';
      case 'plan': return '✅ 行程已生成';
      case 'refine': return '✅ 行程已优化';
      case 'done': return '✅ 完成';
      default: return '✅ 完成';
    }
  }
  switch (node) {
    case 'retrieve': return '🔍 正在检索景点资料…';
    case 'plan': return '🧠 正在生成行程…';
    case 'refine': return '✨ 正在优化行程…';
    case 'done': return '⏳ 准备中…';
    default: return '⏳ 准备中…';
  }
}

export function createChatReducer(idFactory: () => string) {
  return function chatReducer(state: ChatState, action: ChatAction): ChatState {
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
            { id: idFactory(), role: 'user', content: action.userMsg, timestamp: now },
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
            { id: idFactory(), role: 'system', type: 'progress', content: text, timestamp: now },
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
            id: idFactory(),
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
          id: idFactory(),
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
        const msgId = idFactory();
        const emptyAssistant: ChatMessage = {
          id: idFactory(),
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
              id: idFactory(),
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
              id: idFactory(),
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
  };
}

/** 默认 reducer:随机 id(组件运行时用)。 */
export const chatReducer = createChatReducer(makeId);

/** uuid + jsdom 降级(会话/消息/请求 id 统一入口)。 */
export function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // jsdom fallback
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
