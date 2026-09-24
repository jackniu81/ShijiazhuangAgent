/**
 * Socket.IO 单例 —— 连接 /agent namespace,path /ws
 * 对齐 server/src/agent/agent.gateway.ts 的 @WebSocketGateway 配置。
 */
import { io, Socket } from 'socket.io-client';
import {
  AgentEvents,
  ChatAskPayload,
  PlanCreatePayload,
  TaskCancelPayload,
} from './types';

type Listener = (data: any) => void;

const NAMESPACE = '/agent';
// path 是 socket.io 底层 HTTP 路径,Vite 代理 /ws → localhost:3000/ws
const SOCKET_PATH = '/ws';

class AgentSocket {
  private socket: Socket | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  connect() {
    if (this.socket) return;

    this.socket = io(NAMESPACE, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 1000,
    });

    this.socket.on('connect', () => {
      this._connected = true;
      this.emitStateChange();
    });

    this.socket.on('disconnect', () => {
      this._connected = false;
      this.emitStateChange();
    });

    // 透传 server → client 事件
    (Object.values(AgentEvents) as string[]).forEach((event) => {
      this.socket!.on(event, (data) => this.dispatch(event, data));
    });
  }

  disconnect() {
    this.socket?.disconnect();
    this.socket = null;
    this._connected = false;
    this.emitStateChange();
  }

  // ---------- 事件订阅 ----------
  on(event: string, cb: Listener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(cb);
  }

  off(event: string, cb: Listener) {
    this.listeners.get(event)?.delete(cb);
  }

  onConnectionChange(cb: (connected: boolean) => void) {
    this.on('__state__', cb as Listener);
  }

  offConnectionChange(cb: (connected: boolean) => void) {
    this.off('__state__', cb as Listener);
  }

  // ---------- Client → Server ----------
  createPlan(payload: PlanCreatePayload) {
    this.socket?.emit(AgentEvents.PLAN_CREATE, payload);
  }

  ask(payload: ChatAskPayload) {
    this.socket?.emit(AgentEvents.CHAT_ASK, payload);
  }

  cancel(requestId: string) {
    const payload: TaskCancelPayload = { requestId };
    this.socket?.emit(AgentEvents.TASK_CANCEL, payload);
  }

  // ---------- 内部 ----------
  private dispatch(event: string, data: any) {
    this.listeners.get(event)?.forEach((cb) => cb(data));
  }

  private emitStateChange() {
    this.listeners.get('__state__')?.forEach((cb) => cb(this._connected));
  }
}

export const agentSocket = new AgentSocket();
