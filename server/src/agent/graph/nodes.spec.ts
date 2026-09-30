/** jest-runtime 无法 require @nestjs/* 纯 ESM 包(同 llm.factory.spec.ts),故打桩 Logger 并收集 warn。 */
const warns: string[] = [];
jest.mock('@nestjs/common', () => ({
  Logger: class {
    log(): void {}
    warn(msg: string): void {
      warns.push(msg);
    }
  },
}));

import { AgentEvents, AppErrorEvent, PlanDayEvent } from '@shijiazhuang-agent/shared';
import { LLMProvider } from '../llm/llm.types';
import { RetrievedDoc } from '../rag/rag.types';
import { AppConfig } from '../../config/configuration';
import { nodes, rewriteRetrieveQuery } from './nodes';
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
    chat: { historyTurns: 6, temperature: 0.7, maxTokens: 2048 },
    plan: { temperature: 0.2, maxTokens: 4096 },
    rag: { topK: 5, minScore: 0 },
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

// ────────────────────────────────────────────────────────────
// nodes.plan 真模型脏输出加固:schema 校验 + 回炉重试 1 次(issue #59)
// ────────────────────────────────────────────────────────────

const VALID_PLAN_JSON = JSON.stringify({
  title: '石家庄 2 日游',
  days: [
    { day: 1, items: [{ title: '河北博物院' }] },
    { day: 2, items: [{ title: '正定古城' }] },
  ],
});

/** 按调用次序返回预设输出的 fake provider,同时留下每次的 messages 供断言。 */
function makeScriptedPlanDeps(outputs: string[], over: { isCancelled?: () => boolean } = {}): any {
  const d = makeDeps({ isCancelled: over.isCancelled ?? (() => false), signal: new AbortController().signal });
  const calls: Array<{ role: string; content: string }[]> = [];
  let i = 0;
  d.llm = {
    name: 'fake',
    chat: async (msgs: { role: string; content: string }[]) => {
      calls.push(msgs);
      const out = outputs[Math.min(i, outputs.length - 1)];
      i += 1;
      return out;
    },
  } as unknown as LLMProvider;
  (d as any).calls = calls;
  return d;
}

const planState = (days = 2): PlanState => ({ input: { days }, docs: [] }) as PlanState;

describe('nodes.plan 输出校验与自动重试 (#59)', () => {
  beforeEach(() => {
    warns.splice(0, warns.length);
  });
  it('首次即合法 → 只请求模型一次,行程按需求天数规整', async () => {
    const d = makeScriptedPlanDeps([VALID_PLAN_JSON]);
    const res = await nodes.plan(d)(planState());
    expect(d.calls).toHaveLength(1);
    expect(res.plan.days).toHaveLength(2);
  });

  it('脏输出 → 带具体错误原因回炉重试 1 次并成功', async () => {
    const d = makeScriptedPlanDeps(['抱歉,行程如下(非 JSON)', VALID_PLAN_JSON]);
    const res = await nodes.plan(d)(planState());

    expect(d.calls).toHaveLength(2);
    expect(res.plan.days).toHaveLength(2);
    const repair = d.calls[1].map((m: any) => m.content).join('\n');
    expect(repair).toContain('未通过结构校验');
    expect(repair).toContain('不是合法 JSON');
    // 上次脏输出原样回喂,让模型定点修而非重新发挥
    expect(repair).toContain('抱歉,行程如下(非 JSON)');
  });

  it('天数超出需求也算脏输出,回炉提示要求按需求天数重出', async () => {
    const oneDay = JSON.stringify({ title: '石家庄 1 日游', days: [{ items: [{ title: '河北博物院' }] }] });
    const d = makeScriptedPlanDeps([VALID_PLAN_JSON, oneDay]);
    const res = await nodes.plan(d)(planState(1));

    expect(d.calls).toHaveLength(2);
    expect(res.plan.days).toHaveLength(1);
    const repair = d.calls[1].map((m: any) => m.content).join('\n');
    expect(repair).toContain('请按 1 天');
  });

  it('校验通过前不逐日推流,重试成功后才发 plan:day', async () => {
    const d = makeScriptedPlanDeps(['not json', VALID_PLAN_JSON]);
    await nodes.plan(d)(planState());
    const names: string[] = d.emitted.map((e: any) => e.event as string);
    const planStart = names.findIndex(
      (n, i) =>
        n === AgentEvents.PLAN_PROGRESS &&
        (d.emitted[i].data as any).node === 'plan' &&
        (d.emitted[i].data as any).status === 'start',
    );
    const dayPositions = names
      .map((n, i) => (n === AgentEvents.PLAN_DAY ? i : -1))
      .filter((i) => i >= 0);
    expect(dayPositions).toHaveLength(2);
    expect(Math.min(...dayPositions)).toBeGreaterThan(planStart);
  });

  it('两次都脏 → 抛 LLMError,用户侧只见可读文案,不含解析细节', async () => {
    const d = makeScriptedPlanDeps(['我无法规划', '{"days":[]}']);
    await expect(nodes.plan(d)(planState())).rejects.toMatchObject({
      name: 'LLMError',
      message: '模型返回的行程格式有误,已自动重试仍未成功,请稍后重试。',
    });
    expect(planDaysOf(d)).toHaveLength(0);
    // 具体校验原因进日志,便于统计格式漂移
    expect(warns.join('\n')).toContain('不是合法 JSON');
  });

  it('重试前才取消 → 抛 CancelledSignal,不再请求模型第二次', async () => {
    let cancelled = false;
    const d = makeScriptedPlanDeps(['not json', VALID_PLAN_JSON], { isCancelled: () => cancelled });
    const chat = d.llm.chat.bind(d.llm);
    // 首次请求拿到脏输出之后才取消(等价于模型往返之间用户点了停止)
    d.llm.chat = async (msgs: never, opts?: never) => {
      const out = await chat(msgs, opts);
      cancelled = true;
      return out;
    };

    await expect(nodes.plan(d)(planState())).rejects.toBeInstanceOf(CancelledSignal);
    expect(d.calls).toHaveLength(1);
  });

  it('mock provider 仍走代码组装,不进校验链路', async () => {
    const d = makeMockPlanDeps({ isCancelled: () => false });
    const res = await nodes.plan(d)(planState());
    expect(res.plan.days).toHaveLength(2);
    expect(planDaysOf(d)).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────
// 追问 query 改写(issue #88):retrieve 带 history 上下文
// ────────────────────────────────────────────────────────────

/** 记录 retrieve 节点实际下发的检索 query。 */
function makeRetrieveDeps(): any {
  const d = makeDeps({ isCancelled: () => false, signal: new AbortController().signal }) as any;
  const queries: string[] = [];
  d.retrieve = async (query: string) => {
    queries.push(query);
    return [];
  };
  d.queries = queries;
  return d;
}

const chatState = (question: string, history: ChatState['history']): PlanState & ChatState =>
  ({ question, sessionId: 's1', history, docs: [], input: { days: 1 } } as PlanState & ChatState);

describe('nodes.retrieve 追问 query 改写 (#88)', () => {
  it('无 history → 保持原拼接:question + 固定词', async () => {
    const d = makeRetrieveDeps();
    await nodes.retrieve(d, { emitProgress: false })(chatState('正定古城好玩吗', []));
    expect(d.queries).toEqual(['正定古城好玩吗 石家庄 旅游']);
  });

  it('有 history → 拼入最近一轮 user 消息,追问能命中上轮话题', async () => {
    const d = makeRetrieveDeps();
    const history = [
      { role: 'user', content: '正定古城好玩吗' },
      { role: 'assistant', content: '挺好玩的,建议晚上去……' },
    ] as ChatState['history'];
    await nodes.retrieve(d, { emitProgress: false })(chatState('它门票多少钱', history));
    expect(d.queries).toEqual(['正定古城好玩吗 它门票多少钱 石家庄 旅游']);
  });

  it('只取最近一条 user 消息,忽略更早话题', async () => {
    const history = [
      { role: 'user', content: '河北博物院值得去吗' },
      { role: 'assistant', content: '值得' },
      { role: 'user', content: '正定古城好玩吗' },
      { role: 'assistant', content: '好玩' },
    ] as ChatState['history'];
    expect(rewriteRetrieveQuery('它门票多少钱', history)).toBe('正定古城好玩吗 它门票多少钱 石家庄 旅游');
  });

  it('超长历史消息截断至 30 字,assistant 消息不参与改写', () => {
    const long = '游'.repeat(50);
    const history = [{ role: 'assistant', content: '与检索无关的长回答' }] as ChatState['history'];
    expect(rewriteRetrieveQuery('第二天怎么走', history)).toBe('第二天怎么走 石家庄 旅游');
    expect(rewriteRetrieveQuery('第二天怎么走', [{ role: 'user', content: long }] as ChatState['history'])).toBe(
      `${long.slice(0, 30)} 第二天怎么走 石家庄 旅游`,
    );
  });

  it('plan 分支(无 question)不受影响,仍走 planQuery', async () => {
    const d = makeRetrieveDeps();
    const planStateInput = { input: { days: 2, interests: ['人文'] }, docs: [] } as unknown as PlanState & ChatState;
    await nodes.retrieve(d, { emitProgress: false })(planStateInput);
    expect(d.queries).toEqual(['石家庄 人文 旅游 行程 景点']);
  });
});

// ────────────────────────────────────────────────────────────
// 相关度阈值过滤(issue #89):全过滤 → filteredEmpty 标记与无资料提示
// ────────────────────────────────────────────────────────────

/** 可控检索结果 + minScore 的 retrieve deps。 */
function makeFilterDeps(docs: RetrievedDoc[], minScore: number): any {
  const d = makeDeps({ isCancelled: () => false, signal: new AbortController().signal }) as any;
  d.retrieve = async () => docs;
  d.config.rag.minScore = minScore;
  return d;
}

const retrieved = (title: string): RetrievedDoc => ({
  text: `${title}正文`,
  source: `${title}.md`,
  score: 0.03,
  meta: { title, tags: [], source: `${title}.md` },
});

describe('nodes.retrieve 阈值全过滤 (issue #89)', () => {
  it('minScore>0 且返回空 → filteredEmpty=true', async () => {
    const res = await nodes.retrieve(makeFilterDeps([], 0.2), { emitProgress: false })(
      chatState('今天股票涨了吗', []),
    );
    expect(res).toEqual({ docs: [], filteredEmpty: true });
  });

  it('minScore=0(关闭)时空结果不算全过滤,保持旧语义', async () => {
    const res = await nodes.retrieve(makeFilterDeps([], 0), { emitProgress: false })(
      chatState('随便问', []),
    );
    expect(res.filteredEmpty).toBe(false);
  });

  it('有命中 → filteredEmpty=false', async () => {
    const res = await nodes.retrieve(makeFilterDeps([retrieved('正定古城')], 0.2), {
      emitProgress: false,
    })(chatState('正定好玩吗', []));
    expect(res.filteredEmpty).toBe(false);
    expect(res.docs).toHaveLength(1);
  });
});

describe('nodes.generate 无资料注记 (issue #89)', () => {
  const chatOnlyState = {
    question: 'q',
    sessionId: 's1',
    history: [],
    docs: [],
  } as ChatState;

  it('全过滤 → answer 注明"未检索到本地资料"', async () => {
    const d = makeDeps({ isCancelled: () => false, signal: new AbortController().signal }) as any;
    const res = await nodes.generate(d)({ ...chatOnlyState, filteredEmpty: true });
    expect(res.answer).toContain('(注:未检索到本地资料,以上回答基于模型常识)');
  });

  it('索引降级 → 保持原文案"本地资料检索暂不可用"', async () => {
    const d = makeDeps({ isCancelled: () => false, signal: new AbortController().signal }) as any;
    d.ragDegraded = true;
    const res = await nodes.generate(d)(chatOnlyState);
    expect(res.answer).toContain('(注:本地资料检索暂不可用,以上回答基于模型常识)');
  });

  it('两者皆无 → 不加注记', async () => {
    const d = makeDeps({ isCancelled: () => false, signal: new AbortController().signal }) as any;
    const res = await nodes.generate(d)({ ...chatOnlyState, docs: [retrieved('正定古城')] });
    expect(res.answer).not.toContain('注:');
  });
});

// ────────────────────────────────────────────────────────────
// 生成参数透传(issue #86):chat/plan 按场景下发 temperature/maxTokens
// ────────────────────────────────────────────────────────────

/** 在 makeDeps 基础上记录 stream 收到的 options(生成参数默认值见 makeDeps 的 config)。 */
function makeChatParamDeps(): any {
  const d = makeDeps({ isCancelled: () => false, signal: new AbortController().signal }) as any;
  const streamOpts: unknown[] = [];
  const orig = d.llm.stream.bind(d.llm);
  d.llm.stream = (msgs: never, onToken: never, opts: never) => {
    streamOpts.push(opts);
    return orig(msgs, onToken, opts);
  };
  d.streamOpts = streamOpts;
  return d;
}

describe('生成参数透传 (issue #86)', () => {
  it('generate → llm.stream 收到 chat 场景的 temperature/maxTokens 与取消信号', async () => {
    const d = makeChatParamDeps();
    await nodes.generate(d)(state);
    expect(d.streamOpts).toHaveLength(1);
    expect(d.streamOpts[0]).toMatchObject({ temperature: 0.7, maxTokens: 2048 });
    // signal 仍随 options 下发,取消/超时链路不受影响
    expect((d.streamOpts[0] as any).signal).toBe(d.signal);
  });

  it('planWithRepair 两次调用均带 plan 场景低温参数与 JSON 强约束', async () => {
    const d = makeScriptedPlanDeps(['not json', VALID_PLAN_JSON]);
    const chatOpts: unknown[] = [];
    d.llm = {
      name: 'fake',
      chat: async (_msgs: unknown, opts?: unknown) => {
        chatOpts.push(opts);
        return chatOpts.length === 1 ? 'not json' : VALID_PLAN_JSON;
      },
    } as unknown as LLMProvider;

    await nodes.plan(d)(planState());
    // 首次 + 修复重试各一次,参数一致
    expect(chatOpts).toHaveLength(2);
    expect(chatOpts[0]).toEqual({ temperature: 0.2, maxTokens: 4096, jsonMode: true });
    expect(chatOpts[1]).toEqual(chatOpts[0]);
  });
});
