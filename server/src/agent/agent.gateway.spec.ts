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
  Inject: () => () => {},
}));
jest.mock('@nestjs/websockets', () => ({
  WebSocketGateway: () => () => {},
  WebSocketServer: () => () => {},
  SubscribeMessage: () => () => {},
  OnGatewayInit: () => {},
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

function makeGateway(rateLimit?: { maxConcurrentPerSession?: number; perWindow?: number; windowMs?: number }) {
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

  const config = {
    rateLimit: {
      maxConcurrentPerSession: 1,
      perWindow: 30,
      windowMs: 60_000,
      ...rateLimit,
    },
    wsAuth: { token: '' },
  } as unknown as import('../config/configuration').AppConfig;

  const emitted: Array<{ event: string; data: unknown }> = [];
  const client = {
    id: 'sock-1',
    handshake: { address: '10.0.0.1' },
    emit: (event: string, data: unknown) => emitted.push({ event, data }),
  } as unknown as import('socket.io').Socket;

  const gateway = new AgentGateway(service, config);
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

describe('AgentGateway — 请求限流(issue #62)', () => {
  it('同一会话并发超阈值 → 第二个请求被拒,回 app:error RATE_LIMITED', () => {
    const { gateway, planCalls, emitted, client } = makeGateway();
    gateway.handlePlanCreate(client, { requestId: 'r1', input: { days: 2 } });
    gateway.handlePlanCreate(client, { requestId: 'r2', input: { days: 2 } });

    expect(planCalls).toHaveLength(1); // 第二个未派发到 service
    expect(emitted).toEqual([
      {
        event: 'app:error',
        data: { requestId: 'r2', code: 'RATE_LIMITED', message: expect.any(String) },
      },
    ]);
  });

  it('前一请求结束后归还并发额度,后续请求放行', async () => {
    const { gateway, planCalls, client, finishPlan } = makeGateway();
    gateway.handlePlanCreate(client, { requestId: 'r1', input: { days: 2 } });
    finishPlan();
    await new Promise((r) => setImmediate(r));

    gateway.handlePlanCreate(client, { requestId: 'r2', input: { days: 2 } });
    expect(planCalls).toHaveLength(2);
  });

  it('速率超窗口阈值 → 拒绝并回 RATE_LIMITED(perWindow=3)', () => {
    const { gateway, askCalls, emitted, client } = makeGateway({
      maxConcurrentPerSession: 100,
      perWindow: 3,
    });
    for (let i = 1; i <= 4; i++) {
      gateway.handleChatAsk(client, { requestId: `r${i}`, sessionId: 's1', question: 'q' });
    }
    expect(askCalls).toHaveLength(3);
    expect(emitted).toHaveLength(1);
    expect((emitted[0].data as { code: string; requestId: string }).code).toBe('RATE_LIMITED');
    expect((emitted[0].data as { requestId: string }).requestId).toBe('r4');
  });

  it('IP 维度独立生效:同 IP 不同会话共用速率额度(perWindow=2)', () => {
    const { gateway, askCalls, emitted, client } = makeGateway({
      maxConcurrentPerSession: 100,
      perWindow: 2,
    });
    gateway.handleChatAsk(client, { requestId: 'a', sessionId: 's1', question: 'q' });
    gateway.handleChatAsk(client, { requestId: 'b', sessionId: 's2', question: 'q' });
    gateway.handleChatAsk(client, { requestId: 'c', sessionId: 's3', question: 'q' });
    expect(askCalls).toHaveLength(2);
    expect(emitted).toHaveLength(1);
  });

  it('被拒绝的请求不消耗服务调用,也不进入 active', () => {
    const { gateway, planCalls, client } = makeGateway();
    gateway.handlePlanCreate(client, { requestId: 'r1', input: { days: 2 } });
    gateway.handlePlanCreate(client, { requestId: 'r2', input: { days: 2 } });
    expect(activeMap(gateway).has('r2')).toBe(false);
    expect(planCalls[0].isCancelled()).toBe(false);
  });
});

describe('AgentGateway — 连接鉴权(issue #61)', () => {
  /** 构造带 token 的 gateway,伪造 afterInit 入参对象以捕获挂接的 middleware。 */
  function makeAuthed(token: string, mode: 'namespace' | 'server' = 'namespace') {
    const middlewares: Array<(socket: unknown, next: (err?: unknown) => void) => void> = [];
    const ns = { use: (mw: (typeof middlewares)[number]) => middlewares.push(mw) };
    const gateway = new AgentGateway(
      { generatePlan: async () => {}, answerQuestion: async () => {} } as unknown as AgentService,
      {
        rateLimit: { maxConcurrentPerSession: 1, perWindow: 30, windowMs: 60_000 },
        wsAuth: { token },
      } as unknown as import('../config/configuration').AppConfig,
    );
    // Nest 对带 namespace 的 gateway 传入的是 Namespace 实例(无 of);源头 Server 则带 of
    const injected = mode === 'server' ? { of: (name: string) => (name === '/agent' ? ns : undefined) } : ns;
    gateway.afterInit(injected);
    const handshake = (auth: unknown) =>
      ({ handshake: { auth, address: '10.0.0.1' } }) as unknown as import('socket.io').Socket;
    return { gateway, middlewares, handshake };
  }

  const nextResult = (mw: (s: unknown, n: (e?: unknown) => void) => void, socket: unknown) =>
    new Promise<{ err?: unknown }>((resolve) => mw(socket, (err) => resolve({ err })));

  it('配置 token → afterInit 挂接 middleware;有效 token 放行', async () => {
    const { middlewares, handshake } = makeAuthed('secret');
    expect(middlewares).toHaveLength(1);
    const { err } = await nextResult(middlewares[0], handshake({ token: 'secret' }));
    expect(err).toBeUndefined();
  });

  it('afterInit 收到源头 Server(带 of) → 同样挂接到 /agent', async () => {
    const { middlewares, handshake } = makeAuthed('secret', 'server');
    expect(middlewares).toHaveLength(1);
    const { err } = await nextResult(middlewares[0], handshake({ token: 'secret' }));
    expect(err).toBeUndefined();
  });

  it('token 缺失 / 非字符串 / 不匹配 → 以 UNAUTHORIZED 拒绝', async () => {
    const { middlewares, handshake } = makeAuthed('secret');
    for (const auth of [undefined, {}, { token: 42 }, { token: 'wrong' }, { token: '' }]) {
      const { err } = await nextResult(middlewares[0], handshake(auth));
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe('UNAUTHORIZED');
    }
  });

  it('WS_TOKEN 为空(开发默认) → 不挂接 middleware,连接不受鉴权约束', () => {
    const { middlewares } = makeAuthed('');
    expect(middlewares).toHaveLength(0);
  });

  it('afterInit 入参不可用(空/Namespace 缺 of) → 安全跳过,不抛异常', () => {
    const gateway = new AgentGateway(
      {} as unknown as AgentService,
      { rateLimit: {}, wsAuth: { token: 'secret' } } as unknown as import('../config/configuration').AppConfig,
    );
    expect(() => gateway.afterInit(undefined)).not.toThrow();
    expect(() => gateway.afterInit({ of: () => undefined })).not.toThrow();
  });
});
