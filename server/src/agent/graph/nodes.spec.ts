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
import { localDateStr } from './analyze.schema';
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
  toolCalls: [],
  toolResults: [],
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
  ({ question, sessionId: 's1', history, docs: [], toolCalls: [], toolResults: [], input: { days: 1 } } as unknown as PlanState & ChatState);

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
    toolCalls: [],
    toolResults: [],
  } as unknown as ChatState;

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

// ────────────────────────────────────────────────────────────
// nodes.analyze 工具调度(chat-tools-spec P4):规则短路 / LLM JSON / server 闸门 / 降级
// ────────────────────────────────────────────────────────────

/** analyze 专用 deps:可控 provider 名、chat 输出与工具开关,并记录每次 chat 入参。 */
function makeAnalyzeDeps(opts: {
  llmName?: string;
  chatImpl?: (msgs: unknown, o?: unknown) => Promise<string> | string;
  chatThrows?: Error;
  weatherEnabled?: boolean;
  analyzeLlmEnabled?: boolean;
}): any {
  const d = makeDeps({ isCancelled: () => false, signal: new AbortController().signal }) as any;
  const chatCalls: Array<{ msgs: unknown; opts: unknown }> = [];
  d.llm = {
    name: opts.llmName ?? 'siliconflow',
    chat: async (msgs: unknown, o?: unknown) => {
      chatCalls.push({ msgs, opts: o });
      if (opts.chatThrows) throw opts.chatThrows;
      return opts.chatImpl ? opts.chatImpl(msgs, o) : '';
    },
    stream: async () => '',
    embed: async (t: unknown[]) => t,
  };
  d.config.chat = {
    ...d.config.chat,
    maxToolRounds: 3,
    weatherEnabled: opts.weatherEnabled ?? false,
    ragToolTopK: 3,
    analyzeLlmEnabled: opts.analyzeLlmEnabled ?? false,
  };
  d.chatCalls = chatCalls;
  return d;
}

const tomorrow = () => localDateStr(new Date(Date.now() + 86400000));

describe('nodes.analyze 规则短路(mock provider / 灰度关闭)', () => {
  it('mock provider 即使开关打开也走规则:含"明天"+天气开关 → weather,日期换算为本地明天', async () => {
    const d = makeAnalyzeDeps({
      llmName: 'mock',
      analyzeLlmEnabled: true,
      weatherEnabled: true,
    });
    const res = await nodes.analyze(d)(chatState('明天石家庄天气怎么样', []));
    expect(res.toolCalls).toEqual([{ name: 'weather', params: { date: tomorrow() } }]);
    // 规则路径不产生 LLM 调用
    expect(d.chatCalls).toHaveLength(0);
  });

  it('问题含白名单景点且未被 docs 覆盖 → rag_attraction', async () => {
    const d = makeAnalyzeDeps({ llmName: 'mock' });
    const res = await nodes.analyze(d)(chatState('赵云庙值得去吗', []));
    expect(res.toolCalls).toEqual([
      { name: 'rag_attraction', params: { attraction: '赵云庙' } },
    ]);
  });

  it('景点已在 baseline docs 中 → 不调用工具', async () => {
    const d = makeAnalyzeDeps({ llmName: 'mock' });
    const res = await nodes.analyze(d)({ ...chatState('赵云庙值得去吗', []), docs: [retrieved('赵云庙')] });
    expect(res.toolCalls).toEqual([]);
  });

  it('天气开关关闭时含日期也不调度 weather;普通问题 → []', async () => {
    const d = makeAnalyzeDeps({ llmName: 'mock', weatherEnabled: false });
    expect((await nodes.analyze(d)(chatState('明天天气怎么样', []))).toolCalls).toEqual([]);
    expect((await nodes.analyze(d)(chatState('石家庄有什么好玩的', []))).toolCalls).toEqual([]);
  });
});

describe('nodes.analyze LLM 化路径 (P4)', () => {
  it('真实 provider + 开关开 → 调一次 chat(temperature:0 + jsonMode),按 JSON 调度表外景点 rag', async () => {
    const d = makeAnalyzeDeps({
      analyzeLlmEnabled: true,
      chatImpl: () =>
        JSON.stringify({ toolCalls: [{ name: 'rag_attraction', params: { attraction: '柏林禅寺' } }] }),
    });
    const res = await nodes.analyze(d)(chatState('柏林禅寺门票多少', []));
    expect(d.chatCalls).toHaveLength(1);
    expect(d.chatCalls[0].opts).toMatchObject({ temperature: 0, jsonMode: true });
    expect(res.toolCalls).toEqual([
      { name: 'rag_attraction', params: { attraction: '柏林禅寺' } },
    ]);
  });

  it('LLM 返回 ```json 代码块包裹的 weather 调用 + 开关开 → 解析并选中', async () => {
    const d = makeAnalyzeDeps({
      analyzeLlmEnabled: true,
      weatherEnabled: true,
      chatImpl: () =>
        `好的\n\`\`\`json\n${JSON.stringify({ toolCalls: [{ name: 'weather', params: { date: tomorrow() } }] })}\n\`\`\``,
    });
    const res = await nodes.analyze(d)(chatState('明天需要带伞吗', []));
    expect(res.toolCalls).toEqual([{ name: 'weather', params: { date: tomorrow() } }]);
  });

  it('server 闸门:天气开关关闭时 LLM 要求 weather → 不调度', async () => {
    const d = makeAnalyzeDeps({
      analyzeLlmEnabled: true,
      weatherEnabled: false,
      chatImpl: () => JSON.stringify({ toolCalls: [{ name: 'weather', params: { date: tomorrow() } }] }),
    });
    const res = await nodes.analyze(d)(chatState('明天天气', []));
    expect(res.toolCalls).toEqual([]);
  });

  it('LLM 输出不可解析 → 降级为不调用工具,不抛错', async () => {
    const d = makeAnalyzeDeps({ analyzeLlmEnabled: true, chatImpl: () => '我认为不需要工具' });
    const res = await nodes.analyze(d)(chatState('随便聊聊', []));
    expect(res.toolCalls).toEqual([]);
  });

  it('LLM 调用抛错 → 降级 [] 并写 warn,不阻断问答', async () => {
    warns.splice(0, warns.length);
    const d = makeAnalyzeDeps({ analyzeLlmEnabled: true, chatThrows: new Error('boom') });
    const res = await nodes.analyze(d)(chatState('明天天气', []));
    expect(res.toolCalls).toEqual([]);
    expect(warns.join('\n')).toContain('analyze LLM 调用失败');
  });

  it('toolResults 达 MAX_TOOL_ROUNDS → 强制 [],且不再调用 LLM', async () => {
    const d = makeAnalyzeDeps({ analyzeLlmEnabled: true });
    const s: ChatState = {
      ...chatState('还想问天气', []),
      toolResults: [
        { name: 'weather', params: { date: '2026-10-13' }, output: '晴' },
        { name: 'rag_attraction', params: { attraction: '赵云庙' }, output: '资料' },
        { name: 'rag_attraction', params: { attraction: '隆兴寺' }, output: '资料' },
      ],
    };
    const res = await nodes.analyze(d)(s);
    expect(res.toolCalls).toEqual([]);
    expect(d.chatCalls).toHaveLength(0);
  });
});

describe('nodes.weatherTool 防御性校验与降级 (spec §5.3)', () => {
  const weatherState = (date: string): ChatState =>
    ({ ...chatState('', []), toolCalls: [{ name: 'weather', params: { date } }] }) as ChatState;

  it('日期超过 5 天 → output"暂不支持",且不调用 deps.weather', async () => {
    const d = makeDeps({ isCancelled: () => false, signal: new AbortController().signal }) as any;
    let called = false;
    d.weather = async () => {
      called = true;
      return '晴';
    };
    const far = localDateStr(new Date(Date.now() + 10 * 86400000));
    const res = await nodes.weatherTool(d)(weatherState(far));
    expect(called).toBe(false);
    expect(res.toolCalls).toEqual([]);
    expect(res.toolResults[0].output).toBe('暂不支持该日期天气查询');
  });

  it('合法日期 → 透传 deps.weather 结果并清空 toolCalls', async () => {
    const d = makeDeps({ isCancelled: () => false, signal: new AbortController().signal }) as any;
    d.weather = async (date: string, city: string) => `${city} ${date} 晴 20℃`;
    const date = tomorrow();
    const res = await nodes.weatherTool(d)(weatherState(date));
    expect(res.toolCalls).toEqual([]);
    expect(res.toolResults[0].output).toBe(`石家庄 ${date} 晴 20℃`);
  });

  it('deps.weather 抛错 → 降级为"服务暂不可用",节点不抛', async () => {
    const d = makeDeps({ isCancelled: () => false, signal: new AbortController().signal }) as any;
    d.weather = async () => {
      throw new Error('network down');
    };
    const res = await nodes.weatherTool(d)(weatherState(tomorrow()));
    expect(res.toolResults[0].output).toBe('天气查询服务暂不可用');
  });
});
