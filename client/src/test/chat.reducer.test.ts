import {
  AgentEvents, // noqa: 用于事件契约存在性校验
  type AppErrorEvent,
  type ChatMessage,
  type PlanDay,
  type TravelPlan,
} from '../lib/types';
import {
  createChatReducer,
  defaultProgressText,
  initialChatState,
  RECOVERABLE_CODES,
  type ChatState,
} from '../components/chat.reducer';

/** 确定性 id 工厂:m-1、m-2... 便于断言消息 id 与顺序。 */
function seqIds() {
  let n = 0;
  return () => `m-${++n}`;
}

const REQ = 'req-1';

function baseState(over: Partial<ChatState> = {}): ChatState {
  return { ...initialChatState('s1'), ...over };
}

function textMsg(id: string, content = ''): ChatMessage {
  return { id, role: 'assistant', kind: 'text', content, timestamp: 0 };
}

/** 取消息 content(plan 消息无 content 返回 undefined)。 */
function contentOf(m: ChatMessage): string | undefined {
  return 'content' in m ? m.content : undefined;
}

function planMsgOf(state: ChatState): Extract<ChatMessage, { kind: 'plan' }> {
  const m = state.messages.find((x) => x.role === 'assistant' && x.kind === 'plan');
  if (!m || m.role !== 'assistant' || m.kind !== 'plan') throw new Error('no plan message');
  return m;
}

const day = (n: number): PlanDay => ({ day: n, items: [{ time: '09:00', title: `D${n} 景点` }] });

describe('chat.reducer — 连接与表单开关', () => {
  const reduce = createChatReducer(seqIds());

  it('CONNECT / DISCONNECT 只切 isConnected', () => {
    let s = reduce(baseState(), { type: 'CONNECT' });
    expect(s.isConnected).toBe(true);
    s = reduce(s, { type: 'DISCONNECT' });
    expect(s.isConnected).toBe(false);
  });

  it('TOGGLE_PLANNING_FORM 支持取反与显式指定', () => {
    let s = reduce(baseState(), { type: 'TOGGLE_PLANNING_FORM' });
    expect(s.showPlanningForm).toBe(true);
    s = reduce(s, { type: 'TOGGLE_PLANNING_FORM', show: false });
    expect(s.showPlanningForm).toBe(false);
  });

  it('未知 action 原样返回', () => {
    const s = baseState();
    expect(reduce(s, { type: 'UNKNOWN' } as never)).toBe(s);
  });
});

describe('chat.reducer — 发送与 requestId 过滤', () => {
  const reduce = createChatReducer(seqIds());

  it('SEND_PLAN 追加用户消息并进入 streaming,隐藏表单清 toast', () => {
    const s = reduce(
      baseState({ showPlanningForm: true, toast: { code: 'LLM_ERROR', message: 'x', recoverable: true } }),
      { type: 'SEND_PLAN', requestId: REQ, userMsg: '规划 3 天行程' },
    );
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: 'user', content: '规划 3 天行程' });
    expect(s.pendingRequestId).toBe(REQ);
    expect(s.isStreaming).toBe(true);
    expect(s.showPlanningForm).toBe(false);
    expect(s.toast).toBeUndefined();
  });

  it('SEND_CHAT 追加用户消息 + 空 assistant 占位并记录 streamingMessageId', () => {
    const s = reduce(baseState(), { type: 'SEND_CHAT', requestId: REQ, question: '西柏坡怎么去' });
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1]).toMatchObject({ role: 'assistant', kind: 'text', content: '' });
    expect(s.streamingMessageId).toBe(s.messages[1].id);
    expect(s.isStreaming).toBe(true);
  });

  it('pendingRequestId 存在时,异 requestId 的进度/天/结果/token/done/error 全部被忽略', () => {
    const s = baseState({
      pendingRequestId: REQ,
      streamingMessageId: 'm-x',
      isStreaming: true,
    });
    const other = 'req-other';
    expect(reduce(s, { type: 'PLAN_PROGRESS', data: { requestId: other, node: 'plan', status: 'start' } })).toBe(s);
    expect(
      reduce(s, { type: 'PLAN_DAY', data: { requestId: other, day: day(1), totalDays: 1 } }),
    ).toBe(s);
    expect(reduce(s, { type: 'PLAN_RESULT', data: { requestId: other, plan: {} as TravelPlan } })).toBe(s);
    expect(reduce(s, { type: 'CHAT_TOKEN', data: { requestId: other, sessionId: 's1', token: 't' } })).toBe(s);
    expect(reduce(s, { type: 'CHAT_DONE', data: { requestId: other, sessionId: 's1', answer: 'a' } })).toBe(s);
    expect(
      reduce(s, { type: 'APP_ERROR', data: { requestId: other, code: 'INTERNAL', message: 'e' }, recoverable: true }),
    ).toBe(s);
  });
});

describe('chat.reducer — PLAN_DAY 占位/填充/替换', () => {
  const reduce = createChatReducer(seqIds());

  const withPending = () => baseState({ pendingRequestId: REQ, isStreaming: true });

  it('首个事件创建 totalDays 个占位 day,streaming=true,带 title/summary', () => {
    let s = reduce(withPending(), {
      type: 'PLAN_DAY',
      data: { requestId: REQ, title: '石家庄 3 日游', day: day(1), totalDays: 3, summary: '总述' },
    });
    expect(s.streamingPlanId).toBeDefined();
    const pm = planMsgOf(s);
    expect(pm.streaming).toBe(true);
    expect(pm.plan.title).toBe('石家庄 3 日游');
    expect(pm.plan.summary).toBe('总述');
    expect(pm.plan.days).toHaveLength(3);
    expect(pm.plan.days[1].items).toEqual([]); // 占位为空
    // 原实现:首个事件只建占位骨架(含首天),当天内容由后续同 day 号事件替换进来
    expect(pm.plan.days[0]).toEqual({ day: 1, items: [] });
    s = reduce(s, { type: 'PLAN_DAY', data: { requestId: REQ, day: day(1), totalDays: 3 } });
    expect(planMsgOf(s).plan.days[0]).toEqual(day(1));
  });

  it('后续事件按 day 号替换对应天,不新增消息', () => {
    let s = reduce(withPending(), {
      type: 'PLAN_DAY',
      data: { requestId: REQ, day: day(1), totalDays: 2 },
    });
    const msgCount = s.messages.length;
    s = reduce(s, { type: 'PLAN_DAY', data: { requestId: REQ, day: day(2), totalDays: 2 } });
    expect(s.messages).toHaveLength(msgCount);
    const pm = planMsgOf(s);
    expect(pm.plan.days[1]).toEqual(day(2));
    // 后续事件不再带 summary 也不覆盖标题
    expect(pm.plan.summary).toBeUndefined();
  });

  it('day 号乱序到达也按号替换', () => {
    let s = reduce(withPending(), {
      type: 'PLAN_DAY',
      data: { requestId: REQ, day: day(1), totalDays: 3 },
    });
    s = reduce(s, { type: 'PLAN_DAY', data: { requestId: REQ, day: day(3), totalDays: 3 } });
    const pm = planMsgOf(s);
    expect(pm.plan.days[2]).toEqual(day(3));
    expect(pm.plan.days[1].items).toEqual([]);
  });

  it('PLAN_RESULT 有 streamingPlanId 时原位替换为完整 plan 并全量复位', () => {
    let s = reduce(withPending(), {
      type: 'PLAN_DAY',
      data: { requestId: REQ, day: day(1), totalDays: 2 },
    });
    const fullPlan: TravelPlan = { title: '完整行程', days: [day(1), day(2)], summary: 's', tips: ['t'] };
    s = reduce(s, { type: 'PLAN_RESULT', data: { requestId: REQ, plan: fullPlan } });
    expect(s.messages).toHaveLength(1); // 原位替换,不追加
    const pm = planMsgOf(s);
    expect(pm.streaming).toBeUndefined();
    expect(pm.plan).toEqual(fullPlan);
    expect(s.pendingRequestId).toBeUndefined();
    expect(s.streamingPlanId).toBeUndefined();
    expect(s.isStreaming).toBe(false);
  });

  it('PLAN_RESULT 无流式消息时直接追加', () => {
    const s = reduce(withPending(), {
      type: 'PLAN_RESULT',
      data: { requestId: REQ, plan: { title: 't', days: [day(1)] } },
    });
    expect(s.messages).toHaveLength(1);
    expect(s.isStreaming).toBe(false);
  });
});

describe('chat.reducer — chat 流式与进度文案', () => {
  const reduce = createChatReducer(seqIds());

  it('PLAN_PROGRESS 无 message 时用默认文案,有 message 时用之', () => {
    let s = reduce(baseState(), { type: 'PLAN_PROGRESS', data: { requestId: REQ, node: 'retrieve', status: 'start' } });
    expect(s.messages[0]).toMatchObject({ role: 'system', type: 'progress', content: defaultProgressText('retrieve', 'start') });
    s = reduce(s, { type: 'PLAN_PROGRESS', data: { requestId: REQ, node: 'plan', status: 'start', message: '自定义' } });
    expect(contentOf(s.messages[1])).toBe('自定义');
  });

  it('CHAT_TOKEN 只拼接到 streamingMessageId 的 assistant text 消息', () => {
    const miss = reduce(
      baseState({ pendingRequestId: REQ, streamingMessageId: 'm-not-exist', isStreaming: true }),
      { type: 'CHAT_TOKEN', data: { requestId: REQ, sessionId: 's1', token: 'x' } },
    );
    // 目标消息不存在时不新增不改写
    expect(miss.messages).toEqual([]);

    const st = baseState({
      messages: [textMsg('m-9', ''), textMsg('other', 'x')],
      pendingRequestId: REQ,
      streamingMessageId: 'm-9',
      isStreaming: true,
    });
    let s = reduce(st, { type: 'CHAT_TOKEN', data: { requestId: REQ, sessionId: 's1', token: 'A' } });
    s = reduce(s, { type: 'CHAT_TOKEN', data: { requestId: REQ, sessionId: 's1', token: 'B' } });
    expect(contentOf(s.messages[0])).toBe('AB');
    expect(contentOf(s.messages[1])).toBe('x');
  });

  it('CHAT_DONE 用 answer 兜底覆盖内容并写 sources,复位流式状态', () => {
    const st = baseState({
      messages: [textMsg('m-9', '拼了')],
      pendingRequestId: REQ,
      streamingMessageId: 'm-9',
      isStreaming: true,
    });
    const s = reduce(st, { type: 'CHAT_DONE', data: { requestId: REQ, sessionId: 's1', answer: '完整回答', sources: ['a.md'] } });
    expect(s.messages[0]).toMatchObject({ content: '完整回答', sources: ['a.md'] });
    expect(s.streamingMessageId).toBeUndefined();
    expect(s.isStreaming).toBe(false);
  });

  it('CHAT_DONE answer 为空时保留已拼接 token', () => {
    const st = baseState({
      messages: [textMsg('m-9', '半截')],
      pendingRequestId: REQ,
      streamingMessageId: 'm-9',
      isStreaming: true,
    });
    const s = reduce(st, { type: 'CHAT_DONE', data: { requestId: REQ, sessionId: 's1', answer: '' } });
    expect(contentOf(s.messages[0])).toBe('半截');
  });
});

describe('chat.reducer — 错误/取消/超时复位', () => {
  const reduce = createChatReducer(seqIds());

  it('CANCELLED + 文本流式 → 消息标 cancelled,全量复位,不出 toast 不出 error 消息', () => {
    const st = baseState({
      messages: [textMsg('m-9', '半截')],
      pendingRequestId: REQ,
      streamingMessageId: 'm-9',
      isStreaming: true,
    });
    const s = reduce(st, {
      type: 'APP_ERROR',
      data: { requestId: REQ, code: 'CANCELLED', message: '已取消' },
      recoverable: false,
    });
    expect(s.messages[0]).toMatchObject({ cancelled: true });
    expect(s.isStreaming).toBe(false);
    expect(s.streamingMessageId).toBeUndefined();
    expect(s.streamingPlanId).toBeUndefined();
    expect(s.toast).toBeUndefined();
  });

  it('CANCELLED + plan 流式 → plan 消息 streaming=false 并复位', () => {
    let st: ChatState = baseState({ pendingRequestId: REQ, isStreaming: true });
    st = reduce(st, { type: 'PLAN_DAY', data: { requestId: REQ, day: day(1), totalDays: 2 } });
    const s = reduce(st, {
      type: 'APP_ERROR',
      data: { requestId: REQ, code: 'CANCELLED', message: '已取消' },
      recoverable: false,
    });
    expect(planMsgOf(s).streaming).toBe(false);
    expect(s.isStreaming).toBe(false);
    expect(s.streamingPlanId).toBeUndefined();
  });

  it('INVALID_INPUT 只复位并出可恢复 toast,不追加 system 消息', () => {
    const st = baseState({ pendingRequestId: REQ, isStreaming: true });
    const s = reduce(st, {
      type: 'APP_ERROR',
      data: { requestId: REQ, code: 'INVALID_INPUT', message: '天数不对' },
      recoverable: false,
    });
    expect(s.messages).toEqual([]);
    expect(s.toast).toEqual({ code: 'INVALID_INPUT', message: '天数不对', recoverable: true });
    expect(s.isStreaming).toBe(false);
  });

  it('LLM_ERROR(recoverable) → 追加 system error 消息 + toast', () => {
    const st = baseState({ pendingRequestId: REQ, isStreaming: true });
    const s = reduce(st, {
      type: 'APP_ERROR',
      data: { requestId: REQ, code: 'LLM_ERROR', message: '模型出错' },
      recoverable: RECOVERABLE_CODES.has('LLM_ERROR'),
    });
    expect(s.messages[0]).toMatchObject({ role: 'system', type: 'error', content: '模型出错' });
    expect(s.toast).toEqual({ code: 'LLM_ERROR', message: '模型出错', recoverable: true });
    expect(s.isStreaming).toBe(false);
  });

  it('TIMEOUT → 追加超时 system error + 可恢复 toast 并复位', () => {
    const st = baseState({ pendingRequestId: REQ, streamingMessageId: 'm-9', isStreaming: true });
    const s = reduce(st, { type: 'TIMEOUT' });
    expect(s.messages[0]).toMatchObject({ role: 'system', type: 'error', content: '响应超时,请重试' });
    expect(s.toast).toEqual({ code: 'TIMEOUT', message: '响应超时,请重试', recoverable: true });
    expect(s.isStreaming).toBe(false);
    expect(s.pendingRequestId).toBeUndefined();
  });

  it('CLEAR_TOAST 只清 toast', () => {
    const st = baseState({ toast: { code: 'X', message: 'm', recoverable: false } });
    const s = reduce(st, { type: 'CLEAR_TOAST' });
    expect(s.toast).toBeUndefined();
    expect(s.messages).toEqual([]);
  });
});

describe('chat.reducer — 事件契约冒烟', () => {
  it('reducer 消费的事件名与共享契约一致', () => {
    expect(AgentEvents.PLAN_DAY).toBe('plan:day');
    expect(RECOVERABLE_CODES.has('INTERNAL')).toBe(true);
    expect(RECOVERABLE_CODES.has('CANCELLED')).toBe(false);
  });
});
