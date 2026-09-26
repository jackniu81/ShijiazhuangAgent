import { SessionStore } from './session.store';

/**
 * SessionStore 单测(issue #51):轮数截断、TTL 回收、未知会话、空答案跳过。
 * 直接 new,不调度真实 sweeper(设超长间隔 + afterAll dispose)。
 */

function makeStore(over: Partial<ConstructorParameters<typeof SessionStore>[0]> = {}) {
  return new SessionStore({
    maxTurns: over.maxTurns ?? 3,
    ttlMs: over.ttlMs ?? 60_000,
    sweepIntervalMs: over.sweepIntervalMs ?? 60 * 60_000, // 测试期间不触发
  });
}

describe('SessionStore — 读写与轮数截断', () => {
  it('未知 sessionId 返回空数组', () => {
    const s = makeStore();
    expect(s.getHistory('nope')).toEqual([]);
    s.dispose();
  });

  it('appendTurn 后 getHistory 返回 user+assistant 两条副本', () => {
    const s = makeStore();
    s.appendTurn('c1', '问', '答');
    const h = s.getHistory('c1');
    expect(h).toEqual([
      { role: 'user', content: '问' },
      { role: 'assistant', content: '答' },
    ]);
    // 返回副本,外部修改不影响内部
    h.push({ role: 'user', content: '注入' });
    expect(s.getHistory('c1')).toHaveLength(2);
    s.dispose();
  });

  it('超过 maxTurns 的旧轮被从头截断,只保留最近 N 轮', () => {
    const s = makeStore({ maxTurns: 2 });
    s.appendTurn('c1', 'q1', 'a1');
    s.appendTurn('c1', 'q2', 'a2');
    s.appendTurn('c1', 'q3', 'a3'); // 触发截断
    const h = s.getHistory('c1');
    expect(h).toHaveLength(4); // 2 轮 = 4 条
    expect(h.map((m) => m.content)).toEqual(['q2', 'a2', 'q3', 'a3']);
    s.dispose();
  });

  it('answer 为空 → 跳过写入(不产生半成品轮次)', () => {
    const s = makeStore();
    s.appendTurn('c1', '问', '');
    expect(s.getHistory('c1')).toEqual([]);
    expect(s.size).toBe(0);
    s.dispose();
  });

  it('sessionId 为空 → 忽略', () => {
    const s = makeStore();
    s.appendTurn('', 'q', 'a');
    expect(s.size).toBe(0);
    s.dispose();
  });
});

describe('SessionStore — TTL 回收', () => {
  it('闲置超过 ttlMs 的会话被 pruneExpired 清除', () => {
    const s = makeStore({ ttlMs: 1000 });
    s.appendTurn('c1', 'q', 'a');
    expect(s.size).toBe(1);

    // 未到期的 now:保留
    s.pruneExpired(Date.now() + 500);
    expect(s.size).toBe(1);

    // 远超 TTL 的 now:回收
    s.pruneExpired(Date.now() + 10_000);
    expect(s.size).toBe(0);
    s.dispose();
  });

  it('appendTurn 写入前会顺带惰性回收过期会话', () => {
    const s = makeStore({ ttlMs: 1000 });
    s.appendTurn('stale', 'q', 'a');
    // 手动把 stale 的活跃时间推到过去
    const entry = (s as unknown as { sessions: Map<string, { lastActive: number }> }).sessions.get('stale')!;
    entry.lastActive = Date.now() - 5000;
    // 写入新会话触发内部 pruneExpired()
    s.appendTurn('fresh', 'q', 'a');
    expect(s.getHistory('stale')).toEqual([]);
    expect(s.getHistory('fresh')).toHaveLength(2);
    s.dispose();
  });
});
