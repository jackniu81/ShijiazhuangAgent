import type { TravelPlan } from '../lib/types';
import {
  baseState,
  day,
  planMsgOf,
  reducer,
  REQ,
} from './chat.reducer.fixtures';

describe('chat.reducer — 连接与表单开关', () => {
  const reduce = reducer();

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
  const reduce = reducer();

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
  const reduce = reducer();

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
