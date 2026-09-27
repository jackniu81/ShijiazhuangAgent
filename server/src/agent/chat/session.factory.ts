import { Pool } from 'pg';
import { AppConfig } from '../../config/configuration';
import { PostgresSessionStore, SessionDb } from './pg-session.store';
import { SessionRepository, SessionStore } from './session.store';

/**
 * 按配置构建会话存储后端(issue #29 三阶段):memory(默认) | postgres。
 * @param dbOverride 测试注入的 fake pg 客户端(仅 postgres 后端生效),生产省略。
 * postgres 分支持有 pg.Pool,并在 onModuleDestroy 时关闭(Nest 对工厂 provider 会调用该钩子)。
 */
export async function buildSessionStore(
  config: AppConfig,
  dbOverride?: SessionDb,
): Promise<SessionRepository> {
  const { persistence, databaseUrl, historyTurns, sessionTtlMs } = config.chat;

  if (persistence === 'postgres') {
    let pool: Pool | undefined;
    let db: SessionDb;
    if (dbOverride) {
      db = dbOverride;
    } else {
      pool = new Pool({ connectionString: databaseUrl });
      db = {
        query: async (sql, params) => {
          const res = await pool!.query(sql, params as unknown[]);
          return { rows: res.rows };
        },
      };
    }
    const store = new PostgresSessionStore(
      db,
      { maxTurns: historyTurns, ttlMs: sessionTtlMs },
      pool,
    );
    await store.ensureSchema();
    return store;
  }

  return new SessionStore({ maxTurns: historyTurns, ttlMs: sessionTtlMs });
}
