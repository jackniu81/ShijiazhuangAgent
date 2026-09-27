import { PostgresSessionStore, SessionDb } from './pg-session.store';

/** 模拟 chat_messages 表的内存假库:落地 INSERT/DELETE/SELECT 的关键 SQL 模式。 */
interface MsgRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: Date;
}

class FakeSessionDb implements SessionDb {
  rows: MsgRow[] = [];
  private nextId = 1;
  readonly sqls: string[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: MsgRow[] }> {
    this.sqls.push(sql);
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE/i.test(s)) return { rows: [] };
    if (/^INSERT INTO/i.test(s)) {
      const [session_id, role, content, created_at] = params as [string, string, string, Date];
      this.rows.push({ id: this.nextId++, session_id, role, content, created_at });
      return { rows: [] };
    }
    if (/SELECT role, content .* WHERE session_id = \$1 ORDER BY id DESC LIMIT/i.test(s)) {
      const [sessionId, limit] = params as [string, number];
      const picked = this.rows
        .filter((r) => r.session_id === sessionId)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
      return { rows: picked };
    }
    if (/DELETE FROM \S+ WHERE session_id = \$1 AND id NOT IN/i.test(s)) {
      const [sessionId, limit] = params as [string, number];
      const keepIds = new Set(
        this.rows
          .filter((r) => r.session_id === sessionId)
          .sort((a, b) => b.id - a.id)
          .slice(0, limit)
          .map((r) => r.id),
      );
      this.rows = this.rows.filter(
        (r) => r.session_id !== sessionId || keepIds.has(r.id),
      );
      return { rows: [] };
    }
    if (/DELETE FROM \S+ WHERE created_at < \$1/i.test(s)) {
      const cutoff = params[0] as Date;
      this.rows = this.rows.filter((r) => r.created_at >= cutoff);
      return { rows: [] };
    }
    if (/SELECT COUNT\(DISTINCT session_id\)/i.test(s)) {
      const n = new Set(this.rows.map((r) => r.session_id)).size;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { rows: [{ n } as any] };
    }
    throw new Error('unexpected sql: ' + s);
  }
}

function makeStore(over: { maxTurns?: number; ttlMs?: number; table?: string } = {}) {
  const db = new FakeSessionDb();
  const store = new PostgresSessionStore(db, {
    maxTurns: over.maxTurns ?? 3,
    ttlMs: over.ttlMs ?? 60_000,
    table: over.table,
  });
  return { db, store };
}

describe('PostgresSessionStore', () => {
  it('ensureSchema 建表 + 索引', async () => {
    const { db, store } = makeStore();
    await store.ensureSchema();
    expect(db.sqls.some((x) => /CREATE TABLE IF NOT EXISTS chat_messages/i.test(x))).toBe(true);
    expect(db.sqls.some((x) => /CREATE INDEX/i.test(x))).toBe(true);
  });

  it('appendTurn 后 getHistory 返回 user+assistant  chronological 顺序', async () => {
    const { store } = makeStore();
    await store.appendTurn('c1', '问', '答');
    const h = await store.getHistory('c1');
    expect(h).toEqual([
      { role: 'user', content: '问' },
      { role: 'assistant', content: '答' },
    ]);
  });

  it('超过 maxTurns 的旧轮被截断,只保留最近 N 轮', async () => {
    const { store } = makeStore({ maxTurns: 2 });
    await store.appendTurn('c1', 'q1', 'a1');
    await store.appendTurn('c1', 'q2', 'a2');
    await store.appendTurn('c1', 'q3', 'a3');
    const h = await store.getHistory('c1');
    expect(h).toHaveLength(4);
    expect(h.map((m) => m.content)).toEqual(['q2', 'a2', 'q3', 'a3']);
  });

  it('answer 为空 / sessionId 为空 → 跳过写入', async () => {
    const { db, store } = makeStore();
    await store.appendTurn('c1', '问', '');
    await store.appendTurn('', 'q', 'a');
    await expect(store.getHistory('c1')).resolves.toEqual([]);
    await expect(store.size()).resolves.toBe(0);
    expect(db.rows).toHaveLength(0);
  });

  it('未知 sessionId 返回空数组', async () => {
    const { store } = makeStore();
    await expect(store.getHistory('nope')).resolves.toEqual([]);
  });

  it('size 统计存活会话数(去重)', async () => {
    const { store } = makeStore();
    await store.appendTurn('c1', 'q', 'a');
    await store.appendTurn('c2', 'q', 'a');
    await store.appendTurn('c1', 'q2', 'a2');
    await expect(store.size()).resolves.toBe(2);
  });

  it('pruneExpired 删除闲置超过 TTL 的消息', async () => {
    const { db, store } = makeStore({ ttlMs: 1000 });
    await store.appendTurn('c1', 'q', 'a');
    expect(db.rows).toHaveLength(2);
    // 未来 cutoff:全部过期
    await store.pruneExpired(Date.now() + 10_000);
    expect(db.rows).toHaveLength(0);
  });

  it('非法表名回退默认 chat_messages', async () => {
    const { db, store } = makeStore({ table: 'bad; DROP' });
    await store.ensureSchema();
    expect(db.sqls.some((x) => /CREATE TABLE IF NOT EXISTS chat_messages/i.test(x))).toBe(true);
  });
});
