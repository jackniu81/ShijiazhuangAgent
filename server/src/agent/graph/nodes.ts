import {
  AgentEvents,
  AppErrorEvent,
  PlanDay,
  PlanItem,
  PlanNode,
  PlanProgressEvent,
  PlanResultEvent,
  TravelPlan,
} from '../agent.types';
import { Msg } from '../llm/llm.types';
import { RetrievedDoc } from '../rag/rag.types';
import { CancelledSignal, ChatState, GraphDeps, PlanState } from './graph.types';

// ────────────────────────────────────────────────────────────
// 通用:带进度上报 + 取消守卫的节点包装
// ────────────────────────────────────────────────────────────
async function tracked<T>(
  deps: GraphDeps,
  node: PlanNode,
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  guardCancel(deps);
  emitProgress(deps, node, 'start', message);
  const result = await fn();
  guardCancel(deps);
  emitProgress(deps, node, 'finish');
  return result;
}

function guardCancel(deps: GraphDeps): void {
  if (deps.isCancelled()) {
    emitError(deps, 'CANCELLED', '请求已取消。');
    throw new CancelledSignal();
  }
}

function emitProgress(
  deps: GraphDeps,
  node: PlanNode,
  status: PlanProgressEvent['status'],
  message?: string,
): void {
  deps.emit(AgentEvents.PLAN_PROGRESS, {
    requestId: deps.requestId,
    node,
    status,
    message,
  } as PlanProgressEvent);
}

function emitError(deps: GraphDeps, code: AppErrorEvent['code'], message: string): void {
  deps.emit(AgentEvents.APP_ERROR, { requestId: deps.requestId, code, message } as AppErrorEvent);
}

// ────────────────────────────────────────────────────────────
// 节点工厂(闭包捕获 deps,节点签名仍兼容 LangGraph)
// ────────────────────────────────────────────────────────────
export const nodes = {
  retrieve(deps: GraphDeps, opts: { emitProgress?: boolean } = {}) {
    const emitProgress = opts.emitProgress ?? true;
    return async (state: PlanState & ChatState) => {
      const query = state.question
        ? `${state.question} 石家庄 旅游`
        : planQuery(state.input);
      const search = () => deps.retrieve(query, deps.config.rag.topK);
      const docs = emitProgress
        ? await tracked(deps, 'retrieve', '正在检索景点资料…', search)
        : (guardCancel(deps), await search());
      return { docs };
    };
  },

  /** 行程:mock 用代码依据 docs 组装;真模型改走 chat + parse。 */
  plan(deps: GraphDeps) {
    return async (state: PlanState) => {
      const plan = await tracked(deps, 'plan', '正在规划行程…', async () => {
        if (deps.llm.name === 'mock') {
          return assemblePlanFromDocs(state.input, state.docs);
        }
        const raw = await deps.llm.chat(buildPlanMessages(state.input, state.docs));
        return parsePlanJson(raw, state.input.days);
      });
      return { plan };
    };
  },

  refine(deps: GraphDeps) {
    return async (state: PlanState) => {
      const plan = await tracked(deps, 'refine', '正在优化路线与时间安排…', async () =>
        refinePlan(state.plan!, state.input.days),
      );
      return { plan };
    };
  },

  done(deps: GraphDeps) {
    return async (state: PlanState) => {
      emitProgress(deps, 'done', 'start', '行程已生成');
      deps.emit(AgentEvents.PLAN_RESULT, { requestId: deps.requestId, plan: state.plan } as PlanResultEvent);
      emitProgress(deps, 'done', 'finish');
      return {};
    };
  },

  /** 问答:流式输出,token 直连 chat:token,结束发 chat:done。支持取消/超时信号中断。 */
  generate(deps: GraphDeps) {
    return async (state: ChatState) => {
      guardCancel(deps);
      const msgs = buildChatMessages(state, deps.config.chat.historyTurns);
      let answer = '';
      const sources = uniqueSources(state.docs);
      answer = await deps.llm.stream(
        msgs,
        (token) => {
          if (deps.isCancelled()) return; // stream 内部会自然收敛
          deps.emit(AgentEvents.CHAT_TOKEN, {
            requestId: deps.requestId,
            sessionId: state.sessionId,
            token,
          });
        },
        { signal: deps.signal },
      );
      // 取消/超时会 abort 信号:此时静默终止,错误已由 withTimeout/guardCancel 上报
      if (deps.signal?.aborted) throw new CancelledSignal();
      // RAG 降级时在完整 answer 中注明(流式 token 已过,前端以 chat:done.answer 为准)
      if (!state.docs.length && deps.ragDegraded) {
        answer += '\n(注:本地资料检索暂不可用,以上回答基于模型常识)';
      }
      guardCancel(deps);
      deps.emit(AgentEvents.CHAT_DONE, {
        requestId: deps.requestId,
        sessionId: state.sessionId,
        answer,
        sources,
      });
      return { answer };
    };
  },
};

// 保留导出以便未来扩展(当前实现以闭包工厂为主)

// ────────────────────────────────────────────────────────────
// 纯函数:查询、prompt、组装、解析、规整
// ────────────────────────────────────────────────────────────
function planQuery(input: PlanState['input']): string {
  const parts = [
    '石家庄',
    ...(input.interests ?? []),
    input.preferences ?? '',
    '旅游 行程 景点',
  ];
  return parts.filter(Boolean).join(' ');
}

export function assemblePlanFromDocs(input: PlanState['input'], docs: RetrievedDoc[]): TravelPlan {
  const titles = uniqueTitles(docs);
  const pool = titles.length ? titles : ['河北博物院', '正定古城', '苍岩山', '西柏坡', '赵州桥'];
  const days = clampDays(input.days);
  const planDays: PlanDay[] = [];
  let cursor = 0;
  for (let d = 0; d < days; d++) {
    const morning = pool[cursor % pool.length];
    cursor++;
    const afternoon = pool[cursor % pool.length];
    cursor++;
    const items: PlanItem[] = [
      { time: '09:00', title: morning, description: '上午首站,人少时体验更佳。' },
      { time: '14:00', title: afternoon, description: '下午延续当日主题。' },
      { time: '18:30', title: '自由觅食 / 本地小吃', place: '市区', description: '推荐牛肉板面、正定八大碗。' },
    ];
    planDays.push({ day: d + 1, items });
  }
  return {
    title: `石家庄 ${days} 日休闲游`,
    days: planDays,
    summary: input.interests?.length
      ? `结合你的兴趣(${input.interests.join('、')})与本地资料,推荐如下路线。`
      : '兼顾市区人文与周边山水的经典组合。',
    tips: [
      '市区地铁 + 公交可达主要景点,周边建议自驾或包车。',
      '春秋季最宜出游,夏季山区注意防晒防雨。',
    ],
  };
}

export function buildPlanMessages(input: PlanState['input'], docs: RetrievedDoc[]): Msg[] {
  const context = docs.map((d) => `- ${d.meta.title}:${d.text.slice(0, 120)}`).join('\n');
  return [
    {
      role: 'system',
      content:
        '你是石家庄旅游规划助手。只输出符合给定 JSON schema 的行程,不要多余文字。' +
        'schema: {"title":string,"days":[{"day":int,"items":[{"time":string,"title":string,"place":string,"description":string}]}],"summary":string,"tips":[string]}',
    },
    {
      role: 'user',
      content:
        `需求:天数=${input.days},人数=${input.travelers ?? 1},预算=${input.budget ?? 'comfort'},` +
        `兴趣=${(input.interests ?? []).join('/')||'不限'},偏好=${input.preferences ?? '无'}\n` +
        `参考本地资料:\n${context || '(无)'}`,
    },
  ];
}

export function buildChatMessages(state: ChatState, historyTurns: number): Msg[] {
  const contextTitles = uniqueTitles(state.docs).slice(0, 4);
  const user =
    `CONTEXT:${contextTitles.join('、')}\n` +
    `参考资料:\n${state.docs.map((d) => `## ${d.meta.title}\n${d.text}`).join('\n\n').slice(0, 2000)}\n` +
    `Q:${state.question}`;
  const history = state.history.slice(-historyTurns * 2);
  return [
    { role: 'system', content: '你是石家庄旅游助手,基于提供的本地资料用中文自然回答,简洁友好。' },
    ...history,
    { role: 'user', content: user },
  ];
}

export function parsePlanJson(raw: string, expectedDays: number): TravelPlan {
  const json = extractJson(raw);
  const parsed = JSON.parse(json) as TravelPlan;
  return refinePlan(parsed, expectedDays);
}

function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced) return fenced[1].trim();
  const brace = /[\[{][\s\S]*[\]}]/.exec(raw);
  return (brace ? brace[0] : raw).trim();
}

/** 规整:天数对齐、day 序号连续、兜底字段。 */
export function refinePlan(plan: TravelPlan, expectedDays: number): TravelPlan {
  const days = clampDays(expectedDays);
  const normalized: PlanDay[] = plan.days.slice(0, days).map((d, i) => ({
    day: i + 1,
    items: (d.items ?? []).map((it) => ({
      time: it.time,
      title: it.title,
      place: it.place,
      description: it.description,
      tips: it.tips,
    })),
  }));
  // 天数不足则补齐空壳,保证 days.length === expectedDays
  while (normalized.length < days) {
    normalized.push({
      day: normalized.length + 1,
      items: [{ title: '自由活动', description: '可依据喜好灵活安排。' }],
    });
  }
  return {
    title: plan.title || `石家庄 ${days} 日休闲游`,
    days: normalized,
    summary: plan.summary,
    tips: plan.tips,
  };
}

function uniqueTitles(docs: RetrievedDoc[]): string[] {
  return [...new Set(docs.map((d) => d.meta.title).filter(Boolean))];
}

function uniqueSources(docs: RetrievedDoc[]): string[] {
  return [...new Set(docs.map((d) => d.source).filter(Boolean))];
}

function clampDays(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(7, Math.max(1, Math.round(n)));
}
