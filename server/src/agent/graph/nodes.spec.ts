import { AgentEvents, AppErrorEvent } from '@shijiazhuang-agent/shared';
import { LLMProvider } from '../llm/llm.types';
import { AppConfig } from '../../config/configuration';
import { nodes } from './nodes';
import { CancelledSignal, ChatState, GraphDeps } from './graph.types';

/** 构造一个可控制 signal/取消 的最小问答节点依赖。 */
function makeDeps(over: { isCancelled: () => boolean; signal: AbortSignal }): GraphDeps {
  const emitted: Array<{ event: string; data: unknown }> = [];
  const llm = {
    name: 'fake',
    // 模拟流式中途因 abort 提前返回,不抛错(交由节点收尾判定)
    stream: async (_msgs: unknown, onToken: (t: string) => void, opts?: { signal?: AbortSignal }) => {
      let out = '';
      for (const tk of ['第一段', '第二段', '第三段']) {
        if (opts?.signal?.aborted) return out;
        out += tk;
        onToken(tk);
      }
      return out;
    },
    chat: async () => '',
    embed: async (t: string[]) => t.map(() => []),
  } as unknown as LLMProvider;

  const config = {
    chat: { historyTurns: 6 },
    rag: { topK: 5 },
  } as unknown as AppConfig;

  const deps: GraphDeps = {
    llm,
    retrieve: async () => [],
    config,
    emit: (event, data) => emitted.push({ event, data }),
    requestId: 'req-1',
    isCancelled: over.isCancelled,
    signal: over.signal,
    ragDegraded: false,
  };
  // 把事件采集挂到 deps 上返回,方便断言
  (deps as unknown as { emitted: typeof emitted }).emitted = emitted;
  return deps;
}

const state: ChatState = {
  question: '介绍一下景点',
  sessionId: 's1',
  history: [],
  docs: [],
};

describe('nodes.generate 取消/超时收尾', () => {
  it('用户中途取消 → 抛 CancelledSignal 且上报一次 app:error(CANCELLED)', async () => {
    const ctrl = new AbortController();
    const d = makeDeps({ isCancelled: () => true, signal: ctrl.signal }) as any;
    // 流式开始前就标记取消(等价于流中途收到 cancel)
    ctrl.abort();

    await expect(nodes.generate(d)(state)).rejects.toBeInstanceOf(CancelledSignal);

    const errs = d.emitted.filter((e: any) => e.event === AgentEvents.APP_ERROR);
    expect(errs).toHaveLength(1);
    const payload = errs[0].data as AppErrorEvent;
    expect(payload.code).toBe('CANCELLED');
    expect(payload.requestId).toBe('req-1');
    // 取消不应再发 chat:done
    expect(d.emitted.some((e: any) => e.event === AgentEvents.CHAT_DONE)).toBe(false);
  });

  it('超时 abort(非用户取消) → 静默抛断,不发 CANCELLED', async () => {
    const ctrl = new AbortController();
    const d = makeDeps({ isCancelled: () => false, signal: ctrl.signal }) as any;
    ctrl.abort(); // withTimeout 会 abort 内部 ctrl,但 isCancelled 仍为 false

    await expect(nodes.generate(d)(state)).rejects.toBeInstanceOf(CancelledSignal);
    expect(d.emitted.some((e: any) => e.event === AgentEvents.APP_ERROR)).toBe(false);
  });

  it('正常完成 → 发 chat:done 带 answer 与 sources,无 error', async () => {
    const d = makeDeps({ isCancelled: () => false, signal: new AbortController().signal }) as any;
    const res = await nodes.generate(d)(state);
    const done = d.emitted.find((e: any) => e.event === AgentEvents.CHAT_DONE);
    expect(done).toBeTruthy();
    expect((done.data as any).answer).toContain('第一段');
    expect(res.answer).toContain('第一段');
    expect(d.emitted.some((e: any) => e.event === AgentEvents.APP_ERROR)).toBe(false);
  });
});
