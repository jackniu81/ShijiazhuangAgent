import { Inject, Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import {
  AgentEvents,
  AppErrorEvent,
  ChatAskPayload,
  PlanCreatePayload,
  TaskCancelPayload,
} from '@shijiazhuang-agent/shared';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { WsRateLimiter, RateLimitKeys } from './rate-limit';
import { AgentService, Emit } from './agent.service';

/** namespace middleware 的 next 回调(与 socket.io Handler 同构,便于单测注入)。 */
type NextFn = (err?: Error) => void;

/**
 * WebSocket 网关 —— namespace `/agent`,path `/ws`(与 HTTP 同源共享端口)。
 * 严格实现 docs/api-spec.md 定义的事件契约。
 */
@WebSocketGateway({
  namespace: '/agent',
  path: '/ws',
  cors: { origin: '*' },
})
export class AgentGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AgentGateway.name);

  /** 进行中的请求:requestId -> 取消标记 + abort 控制器。请求结束即回收。 */
  private readonly active = new Map<string, { cancelled: boolean; ctrl: AbortController }>();

  /** IP + 会话双维度限流器(issue #62)。 */
  private readonly limiter: WsRateLimiter;

  /** 连接鉴权 token(issue #61,R1);空串 = 不鉴权(开发默认)。 */
  private readonly authToken: string;

  /** 进行中的请求:requestId -> 会话 key,用于结束后归还并发额度。 */
  private readonly sessionOf = new Map<string, string>();

  constructor(
    private readonly service: AgentService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.limiter = new WsRateLimiter(config.rateLimit);
    this.authToken = config.wsAuth.token;
  }

  /**
   * issue #61:向 `/agent` namespace 挂接鉴权 middleware。
   * Nest 触发 afterInit 时传入本 gateway 对应的服务对象:
   * 带 namespace 的 gateway 拿到的是 Namespace 实例(无 of),源头 Server 则经 of 取命名空间。
   * 注意:use 必须原样挂在接收者上调用,解绑 this 会破坏 socket.io 内部状态。
   */
  afterInit(injected?: unknown): void {
    const target = this.resolveAuthTarget(injected);
    if (!target) {
      this.logger.warn('namespace /agent unavailable, auth middleware not installed');
      return;
    }
    if (!this.authToken) {
      this.logger.warn('WS_TOKEN not set — /agent namespace accepts unauthenticated connections (dev only)');
      return;
    }
    target.use((socket: Socket, next: NextFn) => this.authorize(socket, next));
    this.logger.log('auth middleware installed on /agent');
  }

  /** 统一解析出带 use 的挂接对象(Server → /agent Namespace,Namespace → 自身)。 */
  private resolveAuthTarget(injected: unknown): { use: (mw: (s: Socket, n: NextFn) => void) => void } | undefined {
    const obj = injected as { of?: (ns: string) => unknown; use?: unknown } | undefined;
    if (!obj) return undefined;
    if (typeof obj.of === 'function') {
      const ns = obj.of('/agent') as { use?: unknown } | undefined;
      return ns && typeof ns.use === 'function'
        ? { use: (mw) => (ns.use as (f: typeof mw) => void)(mw) }
        : undefined;
    }
    return typeof obj.use === 'function'
      ? { use: (mw) => (obj.use as (f: typeof mw) => void)(mw) }
      : undefined;
  }

  /** 校验握手携带的静态 token(client.auth.token,issue #61);失败以 UNAUTHORIZED 拒绝连接。 */
  authorize(socket: Socket, next: NextFn): void {
    const presented = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof presented === 'string' && presented === this.authToken) {
      next();
      return;
    }
    const addr = socket.handshake?.address ?? 'unknown';
    this.logger.warn(`unauthorized ws connection from ${addr}`);
    const err = Object.assign(new Error('连接未授权:请提供有效的访问令牌。'), {
      code: 'UNAUTHORIZED',
    });
    next(err);
  }

  handleConnection(client: Socket): void {
    this.logger.log(`client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`client disconnected: ${client.id}`);
  }

  @SubscribeMessage(AgentEvents.PLAN_CREATE)
  handlePlanCreate(client: Socket, payload: PlanCreatePayload): void {
    if (!payload?.requestId) return;
    // plan:create 契约无 sessionId(issue #48),以连接 id 作为会话维度
    const keys = this.rateKeys(client, undefined);
    if (!this.guard(payload.requestId, client, keys)) return;
    this.run(payload.requestId, client, keys.session, (emit, isCancelled, signal) =>
      this.service.generatePlan(payload, emit, isCancelled, signal),
    );
  }

  @SubscribeMessage(AgentEvents.CHAT_ASK)
  handleChatAsk(client: Socket, payload: ChatAskPayload): void {
    if (!payload?.requestId) return;
    const keys = this.rateKeys(client, payload.sessionId);
    if (!this.guard(payload.requestId, client, keys)) return;
    this.run(payload.requestId, client, keys.session, (emit, isCancelled, signal) =>
      this.service.answerQuestion(payload, emit, isCancelled, signal),
    );
  }

  @SubscribeMessage(AgentEvents.TASK_CANCEL)
  handleTaskCancel(_client: Socket, payload: TaskCancelPayload): void {
    const entry = payload?.requestId ? this.active.get(payload.requestId) : undefined;
    if (entry) {
      entry.cancelled = true;
      entry.ctrl.abort(); // 中断在途 provider HTTP 流(issue #8)
      this.logger.debug(`request cancelled: ${payload.requestId}`);
    }
  }

  /** 统一执行:登记 requestId、注入 emit/取消/信号回调、结束后回收,避免集合泄漏。 */
  private run(
    requestId: string,
    client: Socket,
    sessionKey: string,
    invoke: (emit: Emit, isCancelled: () => boolean, signal: AbortSignal) => Promise<void>,
  ): void {
    const ctrl = new AbortController();
    const entry = { cancelled: false, ctrl };
    this.active.set(requestId, entry);
    this.sessionOf.set(requestId, sessionKey);
    const emit: Emit = (event, data) => client.emit(event, data);
    const isCancelled = () => entry.cancelled;

    void invoke(emit, isCancelled, ctrl.signal).finally(() => {
      this.active.delete(requestId);
      this.sessionOf.delete(requestId);
      this.limiter.release(sessionKey);
    });
  }

  /** 组装限流双维度 key;IP 取握手地址(直连场景;反代部署见部署文档注意事项)。 */
  private rateKeys(client: Socket, sessionId: string | undefined): RateLimitKeys {
    const session = sessionId ? `session:${sessionId}` : `socket:${client.id}`;
    const address = client.handshake?.address ?? 'unknown';
    return { session, ip: `ip:${address}` };
  }

  /** 限流判定:超限时按 api-spec §4.6 回 app:error(RATE_LIMITED)并拒绝派发。 */
  private guard(requestId: string, client: Socket, keys: RateLimitKeys): boolean {
    const decision = this.limiter.tryAcquire(keys);
    if (decision.ok) return true;
    this.logger.warn(`rate limited [${decision.reason}]: ${requestId} (${keys.session})`);
    client.emit(AgentEvents.APP_ERROR, {
      requestId,
      code: 'RATE_LIMITED',
      message: decision.message,
    } as AppErrorEvent);
    return false;
  }
}
