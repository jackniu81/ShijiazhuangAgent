import { OnModuleDestroy } from '@nestjs/common';
import type { Msg } from '../llm/llm.types';
import { SessionRepository, SessionStoreOptions } from './session.store';

/** pg 客户端的结构化最小契约(与 RAG 侧同思路,便于注入离线 fake 单测)。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SessionDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface PostgresSessionStoreOptions extends SessionStoreOptions {
  /** 会话消息表名,默认 chat_messages(仅允许合法标识符)。 */
  table?: string;
}

const DEFAULT_TABLE = 'chat_messages';

function safeTable(table?: string): string {
  return table && /^[a-z_][a-z0-9_]*$/i.test(table) ? table : DEFAULT_TABLE;
}

/**
 * Postgres 会话持久化(issue #29 三阶段)。
 * 逐条消息落表,读取取最近 maxTurns 轮、写入后截断、并按 TTL 清理过期消息,
 * 与内存 SessionStore 行为对齐;进程重启历史不丢。
 */
export class PostgresSessionStore implements SessionRepository, OnModuleDestroy {
  private readonly maxMessages: number;
  private readonly ttlMs: number;
  private readonly table: string;

  constructor(
    private readonly db: SessionDb,
    options: PostgresSessionStoreOptions,
    /** 底层连接资源(如 pg.Pool),onModuleDestroy 时关闭;注入 fake 测试时可省略。 */
    private readonly closer?: { end(): Promise<unknown> },
  ) {
    this.maxMessages = Math.max(1, options.maxTurns) * 2;
    this.ttlMs = options.ttlMs;
    this.table = safeTable(options.table);
  }

  /** 建表 + 索引(幂等)。RagService 的 pgvector 扩展不在此处,会话表无需向量。 */
  async ensureSchema(): Promise<void> {
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         id BIGSERIAL PRIMARY KEY,
         session_id TEXT NOT NULL,
         role TEXT NOT NULL,
         content TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await this.db.query(`CREATE INDEX IF NOT EXISTS ${this.table}_session_idx ON ${this.table} (session_id)`);
  }

  async getHistory(sessionId: string): Promise<Msg[]> {
    if (!sessionId) return [];
    const { rows } = await this.db.query(
      `SELECT role, content FROM ${this.table} WHERE session_id = $1 ORDER BY id DESC LIMIT $2`,
      [sessionId, this.maxMessages],
    );
    return rows
      .slice()
      .reverse()
      .map((r) => ({ role: r.role as Msg['role'], content: String(r.content) }));
  }

  async appendTurn(sessionId: string, question: string, answer: string): Promise<void> {
    if (!sessionId || !answer) return;
    const now = new Date();
    await this.insert(sessionId, 'user', question, now);
    await this.insert(sessionId, 'assistant', answer, now);
    await this.trim(sessionId);
    await this.pruneExpired();
  }

  /** 存活会话数(观测用)。 */
  async size(): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT COUNT(DISTINCT session_id)::int AS n FROM ${this.table}`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  private async insert(sessionId: string, role: Msg['role'], content: string, at: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.table} (session_id, role, content, created_at) VALUES ($1, $2, $3, $4)`,
      [sessionId, role, content, at],
    );
  }

  /** 仅保留该会话最近 maxMessages 条(id 最大者)。 */
  private async trim(sessionId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM ${this.table} WHERE session_id = $1 AND id NOT IN (
         SELECT id FROM ${this.table} WHERE session_id = $1 ORDER BY id DESC LIMIT $2
       )`,
      [sessionId, this.maxMessages],
    );
  }

  /** 删除闲置超过 TTL 的消息(以最后一批写入时间为准,近似会话级 TTL)。 */
  async pruneExpired(now = Date.now()): Promise<void> {
    await this.db.query(`DELETE FROM ${this.table} WHERE created_at < $1`, [
      new Date(now - this.ttlMs),
    ]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.closer?.end();
  }

  /** 与内存实现命名一致的释放入口。 */
  dispose(): void {
    void this.closer?.end();
  }
}
