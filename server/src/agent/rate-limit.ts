/**
 * WebSocket 请求限流器(issue #62)—— IP + 会话双维度:
 * - 并发:同一会话同时进行中的活跃请求不超过 maxConcurrentPerSession;
 * - 速率:滑动窗口内,每个 IP 与每个会话的请求数均不超过 perWindow。
 * 阈值由配置提供,默认宽松(每分钟 30 次 + 每会话 1 个并发)。
 */

export interface RateLimitOptions {
  maxConcurrentPerSession: number;
  perWindow: number;
  windowMs: number;
}

export interface RateLimitKeys {
  /** 会话维度 key(如 `session:<sessionId>` / `socket:<id>`) */
  session: string;
  /** IP 维度 key(如 `ip:<addr>`) */
  ip: string;
}

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; reason: 'concurrent' | 'rate'; message: string };

export class WsRateLimiter {
  /** 滑动窗口:维度 key -> 窗口内各请求的时间戳(升序) */
  private readonly hits = new Map<string, number[]>();
  /** 并发计数:会话 key -> 进行中请求数 */
  private readonly inflight = new Map<string, number>();

  constructor(
    private readonly opts: RateLimitOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** 判定并登记一次请求;通过时占用 1 个并发额度,调用方须在请求结束后 release。 */
  tryAcquire(keys: RateLimitKeys): RateLimitDecision {
    const now = this.now();

    const concurrent = (this.inflight.get(keys.session) ?? 0) + 1;
    if (concurrent > this.opts.maxConcurrentPerSession) {
      return { ok: false, reason: 'concurrent', message: '当前会话已有请求在处理中,请等待完成后再试。' };
    }
    for (const key of [keys.session, keys.ip]) {
      if (this.countInWindow(key, now) >= this.opts.perWindow) {
        return { ok: false, reason: 'rate', message: '请求过于频繁,请稍后再试。' };
      }
    }

    for (const key of [keys.session, keys.ip]) {
      this.record(key, now);
    }
    this.inflight.set(keys.session, concurrent);
    return { ok: true };
  }

  /** 请求结束(无论成败)后归还并发额度。 */
  release(session: string): void {
    const n = (this.inflight.get(session) ?? 1) - 1;
    if (n <= 0) this.inflight.delete(session);
    else this.inflight.set(session, n);
  }

  private countInWindow(key: string, now: number): number {
    const cutoff = now - this.opts.windowMs;
    const ts = this.hits.get(key);
    if (!ts) return 0;
    // 就地剪除窗口外旧记录,键自然收敛,无需定时清扫
    let i = 0;
    while (i < ts.length && ts[i] <= cutoff) i++;
    if (i > 0) ts.splice(0, i);
    if (ts.length === 0) this.hits.delete(key);
    return ts.length;
  }

  private record(key: string, now: number): void {
    const ts = this.hits.get(key);
    if (ts) ts.push(now);
    else this.hits.set(key, [now]);
  }
}
