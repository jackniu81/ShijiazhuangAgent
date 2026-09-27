import { buildAppConfig } from './configuration';

describe('buildAppConfig 默认值与开关(issue #9 相关)', () => {
  it('默认:hybrid 开启、provider=mock、会话参数符合 spec', () => {
    const c = buildAppConfig({});
    expect(c.rag.hybrid).toBe(true);
    expect(c.llm.provider).toBe('mock');
    expect(c.chat.historyTurns).toBe(6);
    expect(c.chat.sessionTtlMs).toBe(30 * 60_000);
    expect(c.chat.questionMaxLen).toBe(500);
    // issue #27 实测上调:SiliconFlow 免费池 60s 会超时,默认 180s
    expect(c.llm.timeoutMs).toBe(180000);
  });

  it('限流默认值(issue #62):并发 1 + 每分钟 30 次', () => {
    const c = buildAppConfig({});
    expect(c.rateLimit.maxConcurrentPerSession).toBe(1);
    expect(c.rateLimit.perWindow).toBe(30);
    expect(c.rateLimit.windowMs).toBe(60_000);
  });

  it('限流阈值可由环境变量覆盖', () => {
    const c = buildAppConfig({
      WS_MAX_CONCURRENT_PER_SESSION: '2',
      WS_RATE_LIMIT_PER_WINDOW: '10',
      WS_RATE_LIMIT_WINDOW_MS: '5000',
    });
    expect(c.rateLimit.maxConcurrentPerSession).toBe(2);
    expect(c.rateLimit.perWindow).toBe(10);
    expect(c.rateLimit.windowMs).toBe(5000);
  });

  it('RAG_HYBRID=0 / false 关闭混合检索', () => {
    expect(buildAppConfig({ RAG_HYBRID: '0' }).rag.hybrid).toBe(false);
    expect(buildAppConfig({ RAG_HYBRID: 'false' }).rag.hybrid).toBe(false);
    expect(buildAppConfig({ RAG_HYBRID: '1' }).rag.hybrid).toBe(true);
  });

  it('环境变量数值转换与非法值兜底', () => {
    expect(buildAppConfig({ CHAT_HISTORY_TURNS: '3' }).chat.historyTurns).toBe(3);
    expect(buildAppConfig({ CHAT_HISTORY_TURNS: 'abc' }).chat.historyTurns).toBe(6);
    expect(buildAppConfig({ LLM_PROVIDER: 'ollama' }).llm.provider).toBe('ollama');
    expect(buildAppConfig({ LLM_PROVIDER: 'unknown' }).llm.provider).toBe('mock');
  });
  
  it('issue #29 向量后端默认 memory,pgvector 需显式开关', () => {
    const def = buildAppConfig({});
    expect(def.rag.backend).toBe('memory');
    expect(def.rag.databaseUrl).toBe('');
    expect(def.rag.vectorDim).toBe(1024);
    expect(def.rag.vectorTable).toBe('rag_chunks');
  
    const pg = buildAppConfig({
      RAG_STORE_BACKEND: 'pgvector',
      DATABASE_URL: 'postgres://u:p@localhost:5432/agent',
      RAG_VECTOR_DIM: '256',
      RAG_VECTOR_TABLE: 'my_chunks',
    });
    expect(pg.rag.backend).toBe('pgvector');
    expect(pg.rag.databaseUrl).toBe('postgres://u:p@localhost:5432/agent');
    expect(pg.rag.vectorDim).toBe(256);
    expect(pg.rag.vectorTable).toBe('my_chunks');
  
    // 非法/未知取值回退 memory
    expect(buildAppConfig({ RAG_STORE_BACKEND: 'chroma' }).rag.backend).toBe('memory');
    // 非法维度数值回退默认 1024
    expect(buildAppConfig({ RAG_VECTOR_DIM: 'abc' }).rag.vectorDim).toBe(1024);
  });
});
