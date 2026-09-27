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

type Listener = (data: any, extra?: string) => void;
/** 连接状态回调:第二个参数为握手失败原因(鉴权被拒等,issue #61),成功时为空串。 */
type StateListener = (connected: boolean, connectError: string) => void;

const NAMESPACE = '/agent';
// path 是 socket.io 底层 HTTP 路径,Vite 代理 /ws → localhost:3000/ws
const SOCKET_PATH = '/ws';
// 连接鉴权静态 token(issue #61,R1),构建期由 VITE_WS_TOKEN 注入,须与 server 的 WS_TOKEN 一致
const WS_TOKEN = (import.meta.env.VITE_WS_TOKEN as string | undefined) ?? '';

class AgentSocket {
  private socket: Socket | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private _connected = false;
  private _connectError = '';

  get connected(): boolean {
    return this._connected;
  }

  /** 最近一次握手失败原因(如鉴权被拒);成功连接后清空。 */
  get connectError(): string {
    return this._connectError;
  }

  connect() {
    if (this.socket) return;

    this.socket = io(NAMESPACE, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 1000,
      auth: { token: WS_TOKEN },
    });

    this.socket.on('connect', () => {
      this._connected = true;
      this._connectError = '';
      this.emitStateChange();
    });

    this.socket.on('disconnect', () => {
      this._connected = false;
      this.emitStateChange();
    });

    // middleware 拒绝握手时触发(issue #61),保留原因供 UI 展示
    this.socket.on('connect_error', (err: Error) => {
      this._connectError = err.message;
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

  onConnectionChange(cb: StateListener) {
    this.on('__state__', cb as Listener);
  }

  offConnectionChange(cb: StateListener) {
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
    this.listeners.get('__state__')?.forEach((cb) => cb(this._connected, this._connectError));
  }
}

export const agentSocket = new AgentSocket();
