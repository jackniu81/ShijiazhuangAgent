import { buildAppConfig } from './configuration';

describe('buildAppConfig 默认值与开关(issue #9 相关)', () => {
  it('默认:hybrid 开启、provider=mock、会话参数符合 spec', () => {
    const c = buildAppConfig({});
    expect(c.rag.hybrid).toBe(true);
    expect(c.llm.provider).toBe('mock');
    expect(c.chat.historyTurns).toBe(6);
    expect(c.chat.sessionTtlMs).toBe(30 * 60_000);
    expect(c.chat.questionMaxLen).toBe(500);
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
});
