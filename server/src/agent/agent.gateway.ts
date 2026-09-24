import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AgentService, Emit } from './agent.service';
import {
  AgentEvents,
  ChatAskPayload,
  PlanCreatePayload,
  TaskCancelPayload,
} from './agent.types';

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

  /** 进行中的请求:requestId -> 取消标记。请求结束(完成/出错/取消)即回收。 */
  private readonly active = new Map<string, { cancelled: boolean }>();

  handleConnection(client: Socket): void {
    this.logger.log(`client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`client disconnected: ${client.id}`);
  }

  @SubscribeMessage(AgentEvents.PLAN_CREATE)
  handlePlanCreate(client: Socket, payload: PlanCreatePayload): void {
    if (!payload?.requestId) return;
    this.run(payload.requestId, client, (emit, isCancelled) =>
      this.service.generatePlan(payload, emit, isCancelled),
    );
  }

  @SubscribeMessage(AgentEvents.CHAT_ASK)
  handleChatAsk(client: Socket, payload: ChatAskPayload): void {
    if (!payload?.requestId) return;
    this.run(payload.requestId, client, (emit, isCancelled) =>
      this.service.answerQuestion(payload, emit, isCancelled),
    );
  }

  @SubscribeMessage(AgentEvents.TASK_CANCEL)
  handleTaskCancel(_client: Socket, payload: TaskCancelPayload): void {
    const entry = payload?.requestId ? this.active.get(payload.requestId) : undefined;
    if (entry) {
      entry.cancelled = true;
      this.logger.debug(`request cancelled: ${payload.requestId}`);
    }
  }

  /** 统一执行:登记 requestId、注入 emit/取消回调、结束后回收,避免集合泄漏。 */
  private run(
    requestId: string,
    client: Socket,
    invoke: (emit: Emit, isCancelled: () => boolean) => Promise<void>,
  ): void {
    const entry = { cancelled: false };
    this.active.set(requestId, entry);
    const emit: Emit = (event, data) => client.emit(event, data);
    const isCancelled = () => entry.cancelled;

    void invoke(emit, isCancelled).finally(() => this.active.delete(requestId));
  }

  constructor(private readonly service: AgentService) {}
}
