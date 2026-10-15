import {
  createChatReducer,
  initialChatState,
  type ChatState,
} from '../components/chat.reducer';
import type { ChatMessage, PlanDay } from '../lib/types';

/** 确定性 id 工厂:m-1、m-2... 便于断言消息 id 与顺序。 */
export function seqIds() {
  let n = 0;
  return () => `m-${++n}`;
}

export const REQ = 'req-1';

export function baseState(over: Partial<ChatState> = {}): ChatState {
  return { ...initialChatState('s1'), ...over };
}

export function textMsg(id: string, content = ''): ChatMessage {
  return { id, role: 'assistant', kind: 'text', content, timestamp: 0 };
}

/** 取消息 content(plan 消息无 content 返回 undefined)。 */
export function contentOf(m: ChatMessage): string | undefined {
  return 'content' in m ? m.content : undefined;
}

export function planMsgOf(state: ChatState): Extract<ChatMessage, { kind: 'plan' }> {
  const m = state.messages.find((x) => x.role === 'assistant' && x.kind === 'plan');
  if (!m || m.role !== 'assistant' || m.kind !== 'plan') throw new Error('no plan message');
  return m;
}

export const day = (n: number): PlanDay => ({ day: n, items: [{ time: '09:00', title: `D${n} 景点` }] });

/** 与 seqIds 组合出各 describe 内共享的 reduce 实例。 */
export function reducer() {
  return createChatReducer(seqIds());
}
