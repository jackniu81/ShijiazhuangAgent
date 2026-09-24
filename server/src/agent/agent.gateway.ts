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

  /** 已被请求取消的 requestId 集合(requestId 为全局唯一 uuid)。 */
  private readonly cancelled = new Set<string>();

  handleConnection(client: Socket): void {
    this.logger.log(`client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`client disconnected: ${client.id}`);
  }

  private makeEmit(client: Socket): Emit {
    return (event, data) => client.emit(event, data);
  }

  private makeIsCancelled(requestId: string) {
    return () => this.cancelled.has(requestId);
  }

  @SubscribeMessage(AgentEvents.PLAN_CREATE)
  handlePlanCreate(client: Socket, payload: PlanCreatePayload): void {
    if (!payload?.requestId) return;
    const emit = this.makeEmit(client);
    // 后台异步执行,不阻塞事件循环;结果通过 emit 回推
    void this.service.generatePlan(payload, emit, this.makeIsCancelled(payload.requestId));
  }

  @SubscribeMessage(AgentEvents.CHAT_ASK)
  handleChatAsk(client: Socket, payload: ChatAskPayload): void {
    if (!payload?.requestId) return;
    const emit = this.makeEmit(client);
    void this.service.answerQuestion(payload, emit, this.makeIsCancelled(payload.requestId));
  }

  @SubscribeMessage(AgentEvents.TASK_CANCEL)
  handleTaskCancel(_client: Socket, payload: TaskCancelPayload): void {
    if (payload?.requestId) {
      this.cancelled.add(payload.requestId);
      this.logger.debug(`request cancelled: ${payload.requestId}`);
    }
  }

  constructor(private readonly service: AgentService) {}
}
