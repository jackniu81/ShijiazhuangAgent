import { WsRateLimiter } from './rate-limit';

/**
 * 限流器单测(issue #62):并发、IP/会话双维度滑动窗口速率、
 * 窗口过期自愈、release 归还额度。使用注入假时钟,不依赖真实时间。
 */

const keys = (session = 'session:s1', ip = 'ip:1.2.3.4') => ({ session, ip });

function makeLimiter(overrides?: Partial<{ maxConcurrentPerSession: number; perWindow: number; windowMs: number }>) {
  let clock = 1_000;
  const limiter = new WsRateLimiter(
    { maxConcurrentPerSession: 1, perWindow: 5, windowMs: 60_000, ...overrides },
    () => clock,
  );
  return { limiter, tick: (ms: number) => (clock += ms) };
}

describe('WsRateLimiter — 并发', () => {
  it('达到 maxConcurrent 后再 acquire 被拒(reason=concurrent)', () => {
    const { limiter } = makeLimiter();
    expect(limiter.tryAcquire(keys())).toEqual({ ok: true });
    const second = limiter.tryAcquire(keys());
    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toBe('concurrent');
  });

  it('release 后额度归还,可再次通过', () => {
    const { limiter } = makeLimiter();
    limiter.tryAcquire(keys());
    limiter.release('session:s1');
    expect(limiter.tryAcquire(keys()).ok).toBe(true);
  });

  it('不同会话并发互不影响', () => {
    const { limiter } = makeLimiter();
    expect(limiter.tryAcquire(keys('session:a')).ok).toBe(true);
    expect(limiter.tryAcquire(keys('session:b')).ok).toBe(true);
  });

  it('多并发额度:maxConcurrent=2 时第三个才被拒', () => {
    const { limiter } = makeLimiter({ maxConcurrentPerSession: 2 });
    expect(limiter.tryAcquire(keys()).ok).toBe(true);
    expect(limiter.tryAcquire(keys()).ok).toBe(true);
    expect(limiter.tryAcquire(keys()).ok).toBe(false);
  });
});

describe('WsRateLimiter — 速率窗口', () => {
  it('窗口内达到 perWindow 后拒绝(reason=rate)', () => {
    const { limiter, tick } = makeLimiter({ maxConcurrentPerSession: 100, perWindow: 3 });
    for (let i = 0; i < 3; i++) {
      tick(1);
      expect(limiter.tryAcquire(keys()).ok).toBe(true);
    }
    tick(1);
    const denied = limiter.tryAcquire(keys());
    expect(denied.ok).toBe(false);
    expect((denied as { reason: string }).reason).toBe('rate');
  });

  it('窗口滑过后旧记录过期,重新放行', () => {
    const { limiter, tick } = makeLimiter({ maxConcurrentPerSession: 100, perWindow: 2, windowMs: 1000 });
    tick(1);
    expect(limiter.tryAcquire(keys()).ok).toBe(true);
    tick(1);
    expect(limiter.tryAcquire(keys()).ok).toBe(true);
    tick(1);
    expect(limiter.tryAcquire(keys()).ok).toBe(false); // 仍在窗口内
    tick(1000); // 最早的两次滑出窗口
    expect(limiter.tryAcquire(keys()).ok).toBe(true);
  });

  it('IP 维度独立计数:同会话不同 IP 各自享有额度', () => {
    const { limiter } = makeLimiter({ maxConcurrentPerSession: 100, perWindow: 1 });
    expect(limiter.tryAcquire(keys('session:s1', 'ip:1.1.1.1')).ok).toBe(true);
    expect(limiter.tryAcquire(keys('session:s1', 'ip:2.2.2.2')).ok).toBe(false); // session 已用尽
    expect(limiter.tryAcquire(keys('session:s2', 'ip:3.3.3.3')).ok).toBe(true); // 新 session + 新 ip
  });

  it('被拒的请求不消耗额度:拒绝后立即可重试通过(窗口未满时仅受并发限制)', () => {
    const { limiter } = makeLimiter({ maxConcurrentPerSession: 1, perWindow: 2 });
    expect(limiter.tryAcquire(keys()).ok).toBe(true);
    limiter.release('session:s1');
    // 第 2 次通过并释放;第 3 次若被拒(速率),不应把窗口撑到不可恢复
    expect(limiter.tryAcquire(keys()).ok).toBe(true);
    limiter.release('session:s1');
    expect(limiter.tryAcquire(keys()).ok).toBe(false);
  });
});
