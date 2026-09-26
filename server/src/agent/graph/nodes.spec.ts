import { AgentEvents, AppErrorEvent, PlanDayEvent } from '@shijiazhuang-agent/shared';
import { LLMProvider } from '../llm/llm.types';
import { AppConfig } from '../../config/configuration';
import { nodes } from './nodes';
import { CancelledSignal, ChatState, GraphDeps, PlanState } from './graph.types';

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

// ────────────────────────────────────────────────────────────
// nodes.plan 逐天流式 emit plan:day(issue #52,覆盖 #34 新增路径)
// ────────────────────────────────────────────────────────────

function makePlanState(days = 3): PlanState {
  return {
    input: { days, interests: ['人文'] },
    docs: [],
  } as PlanState;
}

/** mock 路径不碰 LLM,直接由 docs 组装行程后逐天 emit。返回 any 以访问 emitted 采集器。 */
function makeMockPlanDeps(over: { isCancelled: () => boolean }): any {
  const d = makeDeps({ isCancelled: over.isCancelled, signal: new AbortController().signal }) as any;
  d.llm = { name: 'mock' };
  return d;
}

const planDaysOf = (d: any): PlanDayEvent[] =>
  d.emitted.filter((e: any) => e.event === AgentEvents.PLAN_DAY).map((e: any) => e.data);

describe('nodes.plan 流式 emitPlanDays', () => {
  it('3 天行程 → 逐天 emit 3 个 plan:day,day 序号/totalDays/title 正确,仅首日带 summary', async () => {
    const d = makeMockPlanDeps({ isCancelled: () => false });
    const res = await nodes.plan(d)(makePlanState(3));

    const events = planDaysOf(d);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.day.day)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.totalDays === 3)).toBe(true);
    expect(events.every((e) => e.title === res.plan.title)).toBe(true);
    expect(events.every((e) => e.requestId === 'req-1')).toBe(true);
    // 内容与最终行程逐天一致
    expect(events.map((e) => e.day)).toEqual(res.plan.days);
    // 仅首个事件携带 summary
    expect(events[0].summary).toBe(res.plan.summary);
    expect(events[1].summary).toBeUndefined();
    expect(events[2].summary).toBeUndefined();
  });

  it('plan:day 发生在 plan 进度 start 与 finish 之间,且不发 plan:result', async () => {
    const d = makeMockPlanDeps({ isCancelled: () => false });
    await nodes.plan(d)(makePlanState(2));

    const names = d.emitted.map((e: any) => e.event as string);
    const startIdx = names.findIndex(
      (n, i) =>
        n === AgentEvents.PLAN_PROGRESS &&
        (d.emitted[i].data as any).node === 'plan' &&
        (d.emitted[i].data as any).status === 'start',
    );
    const finishIdx = names.findIndex(
      (n, i) =>
        n === AgentEvents.PLAN_PROGRESS &&
        (d.emitted[i].data as any).node === 'plan' &&
        (d.emitted[i].data as any).status === 'finish',
    );
    const dayIdxs = names
      .map((n, i) => (n === AgentEvents.PLAN_DAY ? i : -1))
      .filter((i) => i >= 0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(dayIdxs).toHaveLength(2);
    expect(finishIdx).toBeGreaterThan(Math.max(...dayIdxs));
    expect(names).not.toContain(AgentEvents.PLAN_RESULT);
  });

  it('emit 前已取消 → 抛 CancelledSignal,一个 plan:day 都不发,补发 app:error(CANCELLED)', async () => {
    const d = makeMockPlanDeps({ isCancelled: () => true });
    await expect(nodes.plan(d)(makePlanState(3))).rejects.toBeInstanceOf(CancelledSignal);
    expect(planDaysOf(d)).toHaveLength(0);
    const errs = d.emitted.filter((e: any) => e.event === AgentEvents.APP_ERROR);
    expect(errs).toHaveLength(1);
    expect((errs[0].data as AppErrorEvent).code).toBe('CANCELLED');
  });

  it('sleep 间隔窗口内取消(R4) → 中断后续 emit,已发的首档保留,补发一次 CANCELLED', async () => {
    let cancelled = false;
    const d = makeMockPlanDeps({ isCancelled: () => cancelled });
    const pending = nodes.plan(d)(makePlanState(3));
    // 首日已 emit、正处 300ms sleep 窗口时取消
    await new Promise((r) => setTimeout(r, 100));
    cancelled = true;
    await expect(pending).rejects.toBeInstanceOf(CancelledSignal);

    const events = planDaysOf(d);
    expect(events).toHaveLength(1);
    expect(events[0].day.day).toBe(1);
    const errs = d.emitted.filter((e: any) => e.event === AgentEvents.APP_ERROR);
    expect(errs).toHaveLength(1);
    expect((errs[0].data as AppErrorEvent).code).toBe('CANCELLED');
  });
});
