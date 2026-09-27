import { Inject, Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
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

/**
 * WebSocket 网关 —— namespace `/agent`,path `/ws`(与 HTTP 同源共享端口)。
 * 严格实现 docs/api-spec.md 定义的事件契约。
 */
@WebSocketGateway({
  namespace: '/agent',
  path: '/ws',
  cors: { origin: '*' },
})
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AgentGateway.name);

  /** 进行中的请求:requestId -> 取消标记 + abort 控制器。请求结束即回收。 */
  private readonly active = new Map<string, { cancelled: boolean; ctrl: AbortController }>();

  /** IP + 会话双维度限流器(issue #62)。 */
  private readonly limiter: WsRateLimiter;

  /** 进行中的请求:requestId -> 会话 key,用于结束后归还并发额度。 */
  private readonly sessionOf = new Map<string, string>();

  constructor(
    private readonly service: AgentService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.limiter = new WsRateLimiter(config.rateLimit);
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
