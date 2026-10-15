import {
  AgentEvents, // noqa: 用于事件契约存在性校验
} from '../lib/types';
import {
  RECOVERABLE_CODES,
  defaultProgressText,
  type ChatState,
} from '../components/chat.reducer';
import {
  baseState,
  contentOf,
  day,
  planMsgOf,
  reducer,
  REQ,
  textMsg,
} from './chat.reducer.fixtures';

describe('chat.reducer — chat 流式与进度文案', () => {
  const reduce = reducer();

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
  const reduce = reducer();

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
