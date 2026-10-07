import { Logger } from '@nestjs/common';
import {
  AgentEvents,
  AppErrorEvent,
  PlanDay,
  PlanDayEvent,
  PlanItem,
  PlanNode,
  PlanProgressEvent,
  PlanResultEvent,
  TravelPlan,
} from '@shijiazhuang-agent/shared';
import { LLMError } from '../llm/http';
import { Msg, TokenUsage } from '../llm/llm.types';
import { buildChatMessages } from '../prompts/chat.prompt';
import { buildPlanMessages, buildPlanRepairMessages } from '../prompts/plan.prompt';
import { uniqueSources, uniqueTitles } from '../prompts/util';
import { RetrievedDoc } from '../rag/rag.types';
import { extractTripDate, lookupWeather } from '../tools/weather.tool';
import { CancelledSignal, ChatState, GraphDeps, PlanState } from './graph.types';
import { validatePlanJson } from './plan.schema';

// prompt 模板已抽至 agent/prompts/(issue #10),此处 re-export 保持对外 API 不变
export { buildChatMessages, buildPlanMessages };

const logger = new Logger('PlanGraph');

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

/** 逐天流式 emit plan:day,每 300ms 一档让前端逐步显示。 */
async function emitPlanDays(deps: GraphDeps, plan: TravelPlan): Promise<void> {
  const totalDays = plan.days.length;
  for (let i = 0; i < totalDays; i++) {
    guardCancel(deps);
    const evt: PlanDayEvent = {
      requestId: deps.requestId,
      title: plan.title,
      day: plan.days[i],
      totalDays,
      summary: i === 0 ? plan.summary : undefined,
    };
    deps.emit(AgentEvents.PLAN_DAY, evt);
    if (i < totalDays - 1) await sleep(300);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ────────────────────────────────────────────────────────────
// 节点工厂(闭包捕获 deps,节点签名仍兼容 LangGraph)
// ────────────────────────────────────────────────────────────
export const nodes = {
  retrieve(deps: GraphDeps, opts: { emitProgress?: boolean } = {}) {
    const emitProgress = opts.emitProgress ?? true;
    return async (state: PlanState & ChatState) => {
      const query = state.question
        ? rewriteRetrieveQuery(state.question, state.history)
        : planQuery(state.input);
      // 追问改写生效时记录最终 query,便于排查指代消解效果(issue #88)
      if (state.question && (state.history?.length ?? 0) > 0) {
        logger.log(`retrieve query 改写: "${state.question}" → "${query}"`);
      }
      const search = () => deps.retrieve(query, deps.config.rag.topK);
      // 阈值开启(minScore>0)且返回空 = 候选全部被过滤,标记后由回答注明无资料(issue #89)
      const filteredEmpty = deps.config.rag.minScore > 0;
      const docs = emitProgress
        ? await tracked(deps, 'retrieve', '正在检索景点资料…', search)
        : (guardCancel(deps), await search());
      return { docs, filteredEmpty: !docs.length && filteredEmpty };
    };
  },

  /** 行程:mock 用代码依据 docs 组装;真模型走 chat + 校验(脏输出重试 1 次)。 */
  plan(deps: GraphDeps) {
    return async (state: PlanState) => {
      const plan = await tracked(deps, 'plan', '正在规划行程…', async () => {
        const rawPlan =
          deps.llm.name === 'mock'
            ? assemblePlanFromDocs(state.input, state.docs)
            : await planWithRepair(deps, state);
        // 逐天流式 emit:plan:day 让前端提前看到部分行程
        await emitPlanDays(deps, rawPlan);
        return rawPlan;
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

  /**
   * 天气 tool:问题含具体出行日期时查该日天气文本,写入 weather 通道供 generate
   * 作为参考资料。当前为本地 mock 实现,无日期时由图的条件边跳过,不发查询。
   */
  weather(deps: GraphDeps) {
    return async (state: ChatState) => {
      guardCancel(deps);
      const trip = extractTripDate(state.question);
      if (!trip) return {};
      const weather = lookupWeather(trip.date);
      logger.log(`天气工具: 命中日期"${trip.label}"→${trip.date}, ${weather}`);
      return { weather };
    };
  },

  /** 问答:流式输出,token 直连 chat:token,结束发 chat:done。支持取消/超时信号中断。 */
  generate(deps: GraphDeps) {
    return async (state: ChatState) => {
      guardCancel(deps);
      const msgs = buildChatMessages(state, deps.config.chat.historyTurns);
      logger.log(`LLM 查询 ${msgs.length}条记录:`);
      msgs.map((msg) => logger.log(JSON.stringify(msg)));
      // 执行过程观测:记录耗时与 provider 回传的 token 用量(见 ChatOptions.onUsage)。
      const startedAt = Date.now();
      let usage: TokenUsage | undefined;
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
        // 生成参数透传(issue #86):温度与上限按场景配置,信号仍用于取消/超时中断
        {
          temperature: deps.config.chat.temperature,
          maxTokens: deps.config.chat.maxTokens,
          signal: deps.signal,
          onUsage: (u) => {
            usage = u;
          },
        },
      );
      // 取消/超时会 abort 信号,分两种收尾:
      //  - 用户取消:经 guardCancel 上报 app:error(CANCELLED),让客户端立即复位;
      //  - 请求内超时:withTimeout 已以 LLM_ERROR 上报,此处静默抛断,不重复发事件。
      if (deps.signal?.aborted) {
        guardCancel(deps);
        throw new CancelledSignal();
      }
      // 无本地资料时在完整 answer 中注明(流式 token 已过,前端以 chat:done.answer 为准):
      //  - 索引降级:检索不可用;
      //  - 阈值全过滤(issue #89):检索到候选但相关度均低于 minScore。
      if (!state.docs.length && state.filteredEmpty) {
        answer += '\n(注:未检索到本地资料,以上回答基于模型常识)';
      } else if (!state.docs.length && deps.ragDegraded) {
        answer += '\n(注:本地资料检索暂不可用,以上回答基于模型常识)';
      }
      logger.log(
        `LLM 执行过程: provider=${deps.llm.name}, 耗时=${Date.now() - startedAt}ms, ` +
          `输入消息=${msgs.length}条, 温度=${deps.config.chat.temperature}, maxTokens=${deps.config.chat.maxTokens}, ` +
          `token用量=${JSON.stringify(usage ?? {})}`,
      );
      // "工具"= RAG 检索命中:输出命中切块数、来源与相关度,便于核对回答依据。
      logger.log(`LLM 检索工具: 命中 ${state.docs.length} 个切块, 来源=${JSON.stringify(sources)}`);
      state.docs.forEach((d) => logger.log(`  - [${d.score.toFixed(3)}] ${d.source}`));
      logger.log(`LLM 回答(长度 ${answer.length} 字): ${answer}`);
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
// 纯函数:查询、组装、解析、规整(prompt 构建见 agent/prompts/)
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

/** 追问改写取最近几条 user 消息(issue #88 方案 A):1 条足够定位指代,再多会稀释检索主题。 */
const REWRITE_USER_TURNS = 1;
/** 单条历史消息的拼接长度上限,防止长回答占满检索预算。 */
const REWRITE_TURN_MAX_CHARS = 30;

/**
 * 问答检索 query 改写(issue #88):history 非空时把最近一轮 user 消息
 * 拼在当前 question 前,让"它门票多少钱"这类追问能命中上一轮话题(正定古城)的资料。
 */
export function rewriteRetrieveQuery(question: string, history?: Msg[]): string {
  const base = `${question} 石家庄 旅游`;
  const recent = (history ?? []).filter((m) => m.role === 'user').slice(-REWRITE_USER_TURNS);
  const keyword = recent
    .map((m) => m.content.replace(/\s+/g, ' ').trim().slice(0, REWRITE_TURN_MAX_CHARS))
    .filter(Boolean)
    .join(' ');
  return keyword ? `${keyword} ${base}` : base;
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

/**
 * 真模型行程:输出先过 schema,不合法则带错误原因回炉重试 1 次。
 * 仍不合法时抛 LLMError,由 service 收敛为可读的 app:error(LLM_ERROR),
 * 具体校验原因只进日志,不外泄给客户端。
 */
async function planWithRepair(deps: GraphDeps, state: PlanState): Promise<TravelPlan> {
  // plan 场景低温采样 + token 上限(issue #86)+ JSON 强约束(issue #87),两次调用参数一致
  const opts = {
    temperature: deps.config.plan.temperature,
    maxTokens: deps.config.plan.maxTokens,
    jsonMode: true,
  };
  const first = await deps.llm.chat(buildPlanMessages(state.input, state.docs), opts);
  const checked = validatePlanJson(first, state.input.days);
  if (checked.ok) return refinePlan(checked.plan, state.input.days);

  recordPlanFormat('retry', checked.reasons);
  guardCancel(deps);
  const second = await deps.llm.chat(
    buildPlanRepairMessages(state.input, state.docs, first, checked.reasons),
    opts,
  );
  const rechecked = validatePlanJson(second, state.input.days);
  if (rechecked.ok) return refinePlan(rechecked.plan, state.input.days);

  recordPlanFormat('fail', rechecked.reasons);
  throw new LLMError('模型返回的行程格式有误,已自动重试仍未成功,请稍后重试。', false);
}

/** 累计计数写进日志行,`grep plan 输出格式校验 | tail -1` 即得当前格式漂移率。 */
const planFormatStats = { retries: 0, failures: 0 };

function recordPlanFormat(stage: 'retry' | 'fail', reasons: string[]): void {
  if (stage === 'retry') planFormatStats.retries += 1;
  else planFormatStats.failures += 1;
  logger.warn(
    `plan 输出格式校验未通过(${stage},累计 retry=${planFormatStats.retries} fail=${planFormatStats.failures}): ` +
      reasons.join('; '),
  );
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

function clampDays(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(7, Math.max(1, Math.round(n)));
}
