import { AgentGateway } from './agent.gateway';
import type { AgentService } from './agent.service';
import { AgentEvents } from '@shijiazhuang-agent/shared';

/**
 * Gateway 层单测(issue #50):requestId 校验、emit 注入、取消标记 + abort、
 * active 集合登记与回收。不启动 Nest 容器,直接 new + stub 依赖。
 *
 * jest-runtime 无法 require @nestjs/* 纯 ESM 包,故用 jest.mock(由 ts-jest 提升)
 * 打桩装饰器/Logger 与 agent.service 模块(保留 AgentService 类供 design:paramtypes 引用)。
 */
jest.mock('@nestjs/common', () => ({
  Logger: class {
    log(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  },
}));
jest.mock('@nestjs/websockets', () => ({
  WebSocketGateway: () => () => {},
  WebSocketServer: () => () => {},
  SubscribeMessage: () => () => {},
  OnGatewayConnection: () => {},
  OnGatewayDisconnect: () => {},
}));
jest.mock('./agent.service', () => ({ AgentService: class AgentService {} }));

interface CallRecord {
  requestId: string;
  emit: (event: string, data: unknown) => void;
  isCancelled: () => boolean;
  signal: AbortSignal;
}

function makeGateway() {
  const planCalls: CallRecord[] = [];
  const askCalls: CallRecord[] = [];
  let resolvePlan: () => void = () => {};
  let resolveAsk: () => void = () => {};

  const service = {
    generatePlan: (payload: { requestId: string }, emit: CallRecord['emit'], isCancelled: CallRecord['isCancelled'], signal: AbortSignal) => {
      planCalls.push({ requestId: payload.requestId, emit, isCancelled, signal });
      return new Promise<void>((r) => (resolvePlan = r));
    },
    answerQuestion: (payload: { requestId: string }, emit: CallRecord['emit'], isCancelled: CallRecord['isCancelled'], signal: AbortSignal) => {
      askCalls.push({ requestId: payload.requestId, emit, isCancelled, signal });
      return new Promise<void>((r) => (resolveAsk = r));
    },
  } as unknown as AgentService;

  const emitted: Array<{ event: string; data: unknown }> = [];
  const client = {
    id: 'sock-1',
    emit: (event: string, data: unknown) => emitted.push({ event, data }),
  } as unknown as import('socket.io').Socket;

  const gateway = new AgentGateway(service);
  return { gateway, planCalls, askCalls, emitted, client, finishPlan: () => resolvePlan(), finishAsk: () => resolveAsk() };
}

const activeMap = (g: AgentGateway) =>
  (g as unknown as { active: Map<string, { cancelled: boolean; ctrl: AbortController }> }).active;

describe('AgentGateway — 入站校验', () => {
  it('plan:create 缺 requestId → 直接丢弃,不触碰 service', () => {
    const { gateway, planCalls, client } = makeGateway();
    gateway.handlePlanCreate(client, undefined as never);
    gateway.handlePlanCreate(client, { input: { days: 2 } } as never);
    expect(planCalls).toHaveLength(0);
  });

  it('chat:ask 缺 requestId → 直接丢弃,不触碰 service', () => {
    const { gateway, askCalls, client } = makeGateway();
    gateway.handleChatAsk(client, { sessionId: 's1', question: 'x' } as never);
    expect(askCalls).toHaveLength(0);
  });

  it('task:cancel 缺 requestId / 未知 requestId → 安全忽略', () => {
    const { gateway, client } = makeGateway();
    expect(() => gateway.handleTaskCancel(client, undefined as never)).not.toThrow();
    expect(() => gateway.handleTaskCancel(client, { requestId: 'nope' })).not.toThrow();
  });
});

describe('AgentGateway — 任务派发与 emit 注入', () => {
  it('合法 plan:create → 调 service.generatePlan,注入的 emit 转发到 client.emit', async () => {
    const { gateway, planCalls, emitted, client } = makeGateway();
    gateway.handlePlanCreate(client, { requestId: 'r1', input: { days: 3 } });
    expect(planCalls).toHaveLength(1);

    planCalls[0].emit(AgentEvents.PLAN_PROGRESS, { requestId: 'r1', node: 'plan', status: 'start' });
    expect(emitted).toEqual([
      { event: 'plan:progress', data: { requestId: 'r1', node: 'plan', status: 'start' } },
    ]);
  });

  it('合法 chat:ask → 调 service.answerQuestion 并透传 payload', () => {
    const { gateway, askCalls, client } = makeGateway();
    gateway.handleChatAsk(client, { requestId: 'r2', sessionId: 's1', question: '西柏坡' });
    expect(askCalls).toHaveLength(1);
    expect(askCalls[0].requestId).toBe('r2');
  });
});

describe('AgentGateway — 取消与 active 回收', () => {
  it('task:cancel 命中进行中请求 → isCancelled 翻转为 true 且 signal 被 abort', () => {
    const { gateway, planCalls, client } = makeGateway();
    gateway.handlePlanCreate(client, { requestId: 'r1', input: { days: 2 } });

    expect(planCalls[0].isCancelled()).toBe(false);
    expect(planCalls[0].signal.aborted).toBe(false);

    gateway.handleTaskCancel(client, { requestId: 'r1' });
    expect(planCalls[0].isCancelled()).toBe(true);
    expect(planCalls[0].signal.aborted).toBe(true);
  });

  it('请求结束后 active 回收,再 cancel 不产生副作用', async () => {
    const { gateway, planCalls, client, finishPlan } = makeGateway();
    gateway.handlePlanCreate(client, { requestId: 'r1', input: { days: 2 } });
    expect(activeMap(gateway).has('r1')).toBe(true);

    finishPlan();
    await new Promise((r) => setImmediate(r)); // finally 回调在微任务后执行
    expect(activeMap(gateway).has('r1')).toBe(false);

    gateway.handleTaskCancel(client, { requestId: 'r1' });
    expect(planCalls[0].isCancelled()).toBe(false); // 已回收,cancel 扑空
  });

  it('chat 与 plan 互不影响:cancel 只命中各自 requestId', async () => {
    const { gateway, planCalls, askCalls, client, finishAsk } = makeGateway();
    gateway.handlePlanCreate(client, { requestId: 'p1', input: { days: 1 } });
    gateway.handleChatAsk(client, { requestId: 'c1', sessionId: 's', question: 'q' });

    gateway.handleTaskCancel(client, { requestId: 'c1' });
    expect(askCalls[0].isCancelled()).toBe(true);
    expect(planCalls[0].isCancelled()).toBe(false);

    finishAsk();
    await new Promise((r) => setImmediate(r));
    expect(activeMap(gateway).has('c1')).toBe(false);
    expect(activeMap(gateway).has('p1')).toBe(true);
  });
});
