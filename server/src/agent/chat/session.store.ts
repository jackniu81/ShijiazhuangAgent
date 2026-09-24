import type { Msg } from '../llm/llm.types';

/** 供 NestJS 依赖注入使用的会话存储 token。 */
export const SESSION_STORE = Symbol('SESSION_STORE');

export interface SessionStoreOptions {
  /** 保留的最大轮数,1 轮 = user + assistant 各一条(spec §7 CHAT_HISTORY_TURNS) */
  maxTurns: number;
  /** 闲置超过该毫秒数的会话被回收 */
  ttlMs: number;
  /** 定期清扫间隔,默认 5 分钟 */
  sweepIntervalMs?: number;
}

interface SessionEntry {
  msgs: Msg[];
  lastActive: number;
}

/**
 * 内存多轮会话历史:按 sessionId 存储,读取/写入时刷新活跃时间,
 * 闲置超过 TTL 由定期清扫与写入时机惰性回收。后续可替换为持久化实现,接口不变。
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly maxMessages: number;
  private readonly ttlMs: number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly options: SessionStoreOptions) {
    this.maxMessages = Math.max(1, options.maxTurns) * 2;
    this.ttlMs = options.ttlMs;
    // unref:不让定时器阻止进程退出(测试/构建场景)
    this.sweeper = setInterval(() => this.pruneExpired(), options.sweepIntervalMs ?? 5 * 60_000);
    this.sweeper.unref?.();
  }

  /** 返回该会话最近 maxMessages 条消息的副本;未知 sessionId 返回空数组。 */
  getHistory(sessionId: string): Msg[] {
    const entry = this.sessions.get(sessionId);
    return entry ? [...entry.msgs] : [];
  }

  /** 追加一轮问答并截断到最近 N 轮;answer 为空时跳过写入。 */
  appendTurn(sessionId: string, question: string, answer: string): void {
    if (!sessionId || !answer) return;
    this.pruneExpired();
    const entry = this.sessions.get(sessionId) ?? { msgs: [], lastActive: Date.now() };
    entry.msgs.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    if (entry.msgs.length > this.maxMessages) {
      entry.msgs = entry.msgs.slice(-this.maxMessages);
    }
    entry.lastActive = Date.now();
    this.sessions.set(sessionId, entry);
  }

  /** 当前存活会话数(测试/观测用)。 */
  get size(): number {
    return this.sessions.size;
  }

  /** 回收闲置超过 TTL 的会话。 */
  pruneExpired(now = Date.now()): void {
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastActive >= this.ttlMs) this.sessions.delete(id);
    }
  }

  /** 停止清扫器(模块销毁时调用)。 */
  dispose(): void {
    clearInterval(this.sweeper);
  }
}
