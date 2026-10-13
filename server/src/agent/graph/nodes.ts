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
import { buildAnalyzeMessages } from '../prompts/analyze.prompt';
import { buildPlanMessages, buildPlanRepairMessages } from '../prompts/plan.prompt';
import { uniqueSources, uniqueTitles } from '../prompts/util';
import { RetrievedDoc } from '../rag/rag.types';
import {
  daysFromToday,
  localDateStr,
  parseAnalyzeToolCalls,
  selectAnalyzeToolCall,
} from './analyze.schema';
import { CancelledSignal, ChatState, GraphDeps, PlanState, ToolCall, ToolResult } from './graph.types';
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
export function mergeDocs(baseline: RetrievedDoc[], extra: RetrievedDoc[]): RetrievedDoc[] {
  const seen = new Set(baseline.map((d) => d.source));
  return [...baseline, ...extra.filter((d) => !seen.has(d.source))];
}

/** 规则短路识别的本地景点白名单(LLM 路径不依赖此表,可识别表外景点)。 */
const KNOWN_ATTRACTIONS = [
  '正定古城', '隆兴寺', '开元寺', '广惠寺华塔', '天宁寺凌霄塔', '临济寺', '苍岩山', '西柏坡',
  '赵州桥', '荣国府', '抱犊寨', '嶂石岩', '天桂山', '土门关驿道小镇', '河北博物院', '滹沱河生态区',
  '华北军区烈士陵园', '石家庄植物园', '世纪公园', '县文庙', '阳和楼', '长安公园', '骆梁', '赵云庙',
  '正定博物馆', '正定古城墙', '正太广场历史片区',
];

/** 可解析的日期表达:ISO + 常用相对/周历表达(周历由 LLM 路径换算,规则路径只识别前三档)。 */
const DATE_RE = /\d{4}-\d{1,2}-\d{1,2}|今天|明天|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天]|周末/;

/** 天气语义:含日期不等于问天气("明天隆兴寺开门吗"不应触发 weather)。 */
const WEATHER_INTENT_RE = /天气|气温|温度|冷不?冷|热不?热|穿什么|穿衣|带伞|下雨|降雨|预报|刮风|防晒|适合.*出行/;

/** 景点实体/旅游服务信号:本地景点通名后缀 + 常见问法。 */
const ATTRACTION_SIGNAL_RE =
  /寺|庙|山|桥|古城|古镇|古寺|塔|楼|公园|博物|陵|村|寨|驿|景区|景点|门票|开放|地址|怎么去|好玩|值得去/;

/** 追问指代:有历史对话且出现指代词,工具目标可能在上文(交给 LLM 结合 history 判断)。 */
const FOLLOWUP_REF_RE = /它|这个|那个|这里|那里|这儿|那儿|该景点/;

/**
 * 廉价信号闸门(spec §10):判断问题(或结合历史的追问)是否可能需要工具。
 * 无信号的闲聊直接进入 generate,省掉一次 analyze LLM 往返。
 */
function hasToolSignal(question: string, history?: { role: string }[]): boolean {
  if (DATE_RE.test(question) || WEATHER_INTENT_RE.test(question) || ATTRACTION_SIGNAL_RE.test(question)) {
    return true;
  }
  return (history?.length ?? 0) > 0 && FOLLOWUP_REF_RE.test(question);
}

/**
 * analyze 规则短路候选生成(mock provider 或 analyzeLlmEnabled=false)。
 * 仅产出候选,语义校验(日期范围/去重/资料覆盖)统一交给 selectAnalyzeToolCall,
 * 与 LLM 路径共用同一道 server 侧闸门。
 */
function ruleAnalyzeCalls(question: string, weatherEnabled: boolean): ToolCall[] {
  const calls: ToolCall[] = [];
  // spec §5.2:含日期且语义与天气/出行相关才调 weather
  if (weatherEnabled && WEATHER_INTENT_RE.test(question)) {
    const m = question.match(/(\d{4}-\d{1,2}-\d{1,2})|今天|明天|后天|大后天/);
    if (m) {
      const now = new Date();
      const date =
        m[0] === '今天' ? localDateStr(now)
        : m[0] === '明天' ? localDateStr(new Date(now.getTime() + 86400000))
        : m[0] === '后天' ? localDateStr(new Date(now.getTime() + 2 * 86400000))
        : m[0] === '大后天' ? localDateStr(new Date(now.getTime() + 3 * 86400000))
        : m[1];
      calls.push({ name: 'weather', params: { date } });
    }
  }
  for (const att of KNOWN_ATTRACTIONS) {
    if (question.includes(att)) {
      calls.push({ name: 'rag_attraction', params: { attraction: att } });
    }
  }
  return calls;
}

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

  /**
   * 工具调度决策(chat-tools-spec §5.2/P4)。
   * mock provider 或灰度开关关闭 → 规则短路(零额外 LLM 延迟);
   * 真实 provider + analyzeLlmEnabled → LLM JSON 判断,输出经结构解析与 server 侧语义校验;
   * LLM 故障或输出不可解析时本轮不调用工具,不阻断问答主链路。
   */
  analyze(deps: GraphDeps) {
    return async (state: ChatState) => {
      guardCancel(deps);
      const maxRounds = deps.config.chat.maxToolRounds ?? 3;
      if ((state.toolResults?.length ?? 0) >= maxRounds) {
        return { toolCalls: [] };
      }

      const useLlm = deps.llm.name !== 'mock' && deps.config.chat.analyzeLlmEnabled;
      let calls: ToolCall[];
      if (useLlm && hasToolSignal(state.question ?? '', state.history)) {
        // 信号闸门(spec §10 延迟优化):问题无任何工具信号(日期/天气语义/景点实体)时
        // 不调 LLM,避免给每次问答都叠加一次模型往返
        try {
          const raw = await deps.llm.chat(
            buildAnalyzeMessages({
              question: state.question ?? '',
              today: localDateStr(),
              docTitles: uniqueTitles(state.docs),
              toolResults: state.toolResults ?? [],
              history: state.history,
            }),
            { temperature: 0, jsonMode: true, signal: deps.signal },
          );
          calls = parseAnalyzeToolCalls(raw);
        } catch (err) {
          logger.warn(
            `analyze LLM 调用失败,本轮不调用工具直接生成: ${err instanceof Error ? err.message : String(err)}`,
          );
          calls = [];
        }
      } else {
        calls = ruleAnalyzeCalls(state.question ?? '', deps.config.chat.weatherEnabled);
      }

      const selected = selectAnalyzeToolCall(calls, {
        weatherEnabled: deps.config.chat.weatherEnabled,
        docTitles: new Set(state.docs.map((d) => d.meta.title)),
        weatherDone: (state.toolResults ?? []).some((r) => r.name === 'weather'),
        ragDone: new Set(
          (state.toolResults ?? [])
            .filter((r) => r.name === 'rag_attraction')
            .map((r) => String(r.params.attraction ?? '')),
        ),
      });
      return { toolCalls: selected ? [selected] : [] };
    };
  },

  weatherTool(deps: GraphDeps) {
    return async (state: ChatState) => {
      guardCancel(deps);
      const call = (state.toolCalls ?? []).find((c) => c.name === 'weather');
      if (!call) return { toolCalls: [], toolResults: [] };

      const date = String(call.params.date ?? '');
      const city = (call.params.city as string) ?? '石家庄';
      // 防御性范围校验(spec §5.3):防 analyze 误判;仍产出 result 让轮次计数前进,避免死循环
      const diff = daysFromToday(date);
      if (diff === null || diff < 0 || diff > 5) {
        return {
          toolCalls: [],
          toolResults: [{ name: 'weather', params: call.params, output: '暂不支持该日期天气查询' }],
        };
      }
      let output: string;
      try {
        output = deps.weather
          ? await deps.weather(date, city)
          : `${city} ${date} 天气晴好，气温适宜，适合出行。`;
      } catch {
        output = '天气查询服务暂不可用';
      }

      const result: ToolResult = {
        name: 'weather',
        params: call.params,
        output,
      };

      return {
        toolCalls: [],
        toolResults: [result],
      };
    };
  },

  ragTool(deps: GraphDeps) {
    return async (state: ChatState) => {
      guardCancel(deps);
      const call = (state.toolCalls ?? []).find((c) => c.name === 'rag_attraction');
      if (!call) return { toolCalls: [], toolResults: [] };

      const attraction = String(call.params.attraction ?? '');
      const topK = deps.config.chat.ragToolTopK ?? 3;
      let docs: RetrievedDoc[] = [];
      try {
        docs = await deps.retrieve(attraction, topK);
      } catch {
        docs = [];
      }

      const output = docs.length
        ? docs.map((d) => `## ${d.meta.title}\n${d.text}`).join('\n\n')
        : `未检索到关于「${attraction}」的详细资料。`;

      const result: ToolResult = {
        name: 'rag_attraction',
        params: call.params,
        output,
        docs,
      };

      // Also merge extra docs into state.docs via mergeDocs
      const extraDocs = docs;
      const mergedDocs = mergeDocs(state.docs, extraDocs);

      return {
        toolCalls: [],
        toolResults: [result],
        docs: mergedDocs,
      };
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

  /** 问答:流式输出,token 直连 chat:token,结束发 chat:done。支持取消/超时信号中断。 */
  generate(deps: GraphDeps) {
    return async (state: ChatState) => {
      guardCancel(deps);
      // spec §5.5:rag_attraction 命中切块已由 rag_tool 合并进 state.docs(去重),
      // 额外 context 只拼非 rag 类结果(如 weather),避免同一资料重复占预算。
      const extraToolResults = (state.toolResults ?? []).filter((r) => r.name !== 'rag_attraction');
      const msgs = buildChatMessages(
        {
          question: state.question,
          history: state.history,
          docs: state.docs,
          toolResults: extraToolResults,
        },
        deps.config.chat.historyTurns,
      );
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
