/** jest 无法直接加载 @nestjs/* 纯 ESM 包,同 nodes.spec.ts 打桩 Logger。 */
jest.mock('@nestjs/common', () => ({
  Logger: class {
    log(): void {}
    warn(): void {}
  },
}));

import { AgentEvents } from '@shijiazhuang-agent/shared';
import { Msg, LLMProvider } from '../llm/llm.types';
import { AppConfig } from '../../config/configuration';
import { runChatGraph } from './chat.graph';
import { ChatState, GraphDeps } from './graph.types';

/** 记录 llm.stream 收到的消息,用于断言天气参考是否进入 prompt。 */
function makeDeps(over: { weatherEnabled?: boolean } = {}): GraphDeps & { userMsgs: string[] } {
  const userMsgs: string[] = [];
  const llm = {
    name: 'fake',
    stream: async (msgs: Msg[]) => {
      userMsgs.push(msgs[msgs.length - 1].content);
      return '好的';
    },
    chat: async () => '',
    embed: async (t: string[]) => t.map(() => []),
  } as unknown as LLMProvider;

  const config = {
    chat: {
      historyTurns: 6,
      temperature: 0.7,
      maxTokens: 2048,
      weather: { enabled: over.weatherEnabled ?? true },
    },
    rag: { topK: 5, minScore: 0 },
  } as unknown as AppConfig;

  return Object.assign(
    {
      llm,
      retrieve: async () => [],
      config,
      emit: () => {},
      requestId: 'req-1',
      isCancelled: () => false,
      signal: new AbortController().signal,
      ragDegraded: false,
    } as unknown as GraphDeps,
    { userMsgs },
  );
}

const ask = (question: string) => ({ question, sessionId: 's1', history: [] as Msg[] });

describe('chat graph 天气分支', () => {
  it('问题含"明天" → 走 weather 节点,天气文本进入 user 消息', async () => {
    const deps = makeDeps();
    const answer = await runChatGraph(deps, ask('明天去正定古城合适吗'));
    expect(answer).toBe('好的');
    expect(deps.userMsgs[0]).toContain('天气参考(');
    expect(deps.userMsgs[0]).toContain('石家庄');
  });

  it('问题不含时间 → 跳过 weather 节点,prompt 无天气行', async () => {
    const deps = makeDeps();
    await runChatGraph(deps, ask('正定古城好玩吗'));
    expect(deps.userMsgs[0]).not.toContain('天气参考');
  });

  it('开关关闭 → 即使含日期也不查天气', async () => {
    const deps = makeDeps({ weatherEnabled: false });
    await runChatGraph(deps, ask('明天去正定古城合适吗'));
    expect(deps.userMsgs[0]).not.toContain('天气参考');
  });

  it('天气分支不影响 chat:done 与 answer 主链路', async () => {
    const emitted: Array<{ event: string; data: unknown }> = [];
    const deps = Object.assign(makeDeps(), {
      emit: (event: string, data: unknown) => emitted.push({ event, data }),
    });
    const answer = await runChatGraph(deps, ask('后天去苍岩山'));
    expect(answer).toBe('好的');
    expect(emitted.some((e) => e.event === AgentEvents.CHAT_DONE)).toBe(true);
  });
});
