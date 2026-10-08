import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { AgentEvents } from '@shijiazhuang-agent/shared';
import { z } from 'zod';
import type { Msg } from '../llm/llm.types';
import type { RetrievedDoc } from '../rag/rag.types';
import { uniqueSources } from '../prompts/util';
import { ChatState, GraphDeps } from './graph.types';
import { buildChatMessages, nodes } from './nodes';

// ────────────────────────────────────────────────────────────
// Tools 定义(仅 chat.graph 内部使用,不污染 graph.types / nodes)
// 入参用 zod schema 描述 + 运行时校验,run 的参数类型由 z.infer 推导。
// ────────────────────────────────────────────────────────────

/** 模型输出的工具调用。 */
interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** 工具执行结果(text 注入生成上下文,docs 可选地并入 state.docs)。 */
interface ToolResult {
  tool: string;
  args: Record<string, unknown>;
  text: string;
}

interface ChatTool<T extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** zod 入参 schema,字段用 .describe() 标注说明,供 prompt 展示。 */
  argsSchema: T;
  /** 返回 text(必) 与 docs(选,景点工具把 RAG 命中并回 docs)。 */
  run: (
    args: z.infer<T>,
    deps: GraphDeps,
  ) => Promise<{ text: string; docs?: RetrievedDoc[] }>;
}

// ────────────────────────────────────────────────────────────
// 日期解析:归一化相对/中文/ISO 日期为 YYYY-MM-DD
// LLM 可能传"明天"而非具体日期,weather 工具内部统一归一化。
// ────────────────────────────────────────────────────────────
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function extractDate(input: string): string | null {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const relativeMap: Record<string, number> = {
    大后天: 3,
    后天: 2,
    明天: 1,
    明日: 1,
    今天: 0,
    今日: 0,
  };
  for (const [kw, offset] of Object.entries(relativeMap)) {
    if (input.includes(kw)) {
      const d = new Date(today);
      d.setDate(d.getDate() + offset);
      return formatDate(d);
    }
  }

  const weekdayMatch = input.match(/(?:周|星期|礼拜)([一二三四五六日天])/);
  if (weekdayMatch) {
    const wdMap: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    const targetWd = wdMap[weekdayMatch[1]];
    let diff = targetWd - today.getDay();
    if (diff < 0) diff += 7;
    if (/下(?:周|星期|礼拜)/.test(input)) diff += 7;
    const d = new Date(today);
    d.setDate(d.getDate() + diff);
    return formatDate(d);
  }

  const cnDate = input.match(/(\d{1,2})月(\d{1,2})日?/);
  if (cnDate) {
    const d = new Date(today.getFullYear(), parseInt(cnDate[1]) - 1, parseInt(cnDate[2]));
    if (d.getTime() < today.getTime()) d.setFullYear(d.getFullYear() + 1);
    return formatDate(d);
  }

  const iso = input.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  }

  return null;
}

/** 天气工具入参。 */
const WeatherArgs = z.object({
  date: z.string().describe('日期,支持 YYYY-MM-DD 或今天/明天/周X 等相对日期'),
});

/** 天气工具:mock,仅支持未来 5 天内日期,async 返回。 */
const weatherTool: ChatTool<typeof WeatherArgs> = {
  name: 'get_weather',
  description: '查询石家庄未来 5 天内指定日期的天气情况。',
  argsSchema: WeatherArgs,
  run: async (args) => {
    // LLM 可能传相对日期(如"明天"),统一归一化为 YYYY-MM-DD
    const date = extractDate(args.date) ?? args.date.trim();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(date);
    target.setHours(0, 0, 0, 0);
    const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);
    if (!date || Number.isNaN(diffDays) || diffDays < 0 || diffDays > 5) {
      return {
        text: `无法查询 ${date || '(未提供日期)'} 的天气:仅支持未来 5 天内的日期。`,
      };
    }
    const weathers = ['晴', '多云', '阴', '小雨', '晴转多云'];
    const highs = [22, 24, 20, 18, 23];
    const idx = diffDays % weathers.length;
    return {
      text: `石家庄 ${date} 天气:${weathers[idx]},气温 ${highs[idx] - 5}~${highs[idx]}°C,湿度 45%,微风,适合出行。`,
    };
  },
};

/** 景点信息工具入参。 */
const ScenicSpotArgs = z.object({
  name: z.string().describe('景点名称,如"正定古城"'),
});

/** 景点信息工具:按景点名走 RAG 检索,返回命中 docs。 */
const scenicSpotTool: ChatTool<typeof ScenicSpotArgs> = {
  name: 'scenic_spot_info',
  description: '查询指定景点的详细信息(介绍、门票、开放时间、交通等)。',
  argsSchema: ScenicSpotArgs,
  run: async (args, deps) => {
    const name = args.name.trim();
    if (!name) return { text: '未提供景点名称,无法查询。' };
    const docs = await deps.retrieve(`${name} 石家庄 景点`, deps.config.rag.topK);
    const text = docs.length
      ? docs.map((d) => `## ${d.meta.title}\n${d.text}`).join('\n\n')
      : `未检索到"${name}"的相关本地资料。`;
    return { text, docs };
  },
};

const TOOLS: Record<string, ChatTool> = {
  get_weather: weatherTool,
  scenic_spot_info: scenicSpotTool,
};

// ────────────────────────────────────────────────────────────
// 状态通道:在原 ChatState 基础上增加 toolResults / pendingTools
// ────────────────────────────────────────────────────────────
const ChatAnnotation = Annotation.Root({
  question: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  sessionId: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  history: Annotation<Msg[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
  docs: Annotation<RetrievedDoc[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
  answer: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  // 阈值全过滤标记(issue #89),retrieve → generate 传递
  filteredEmpty: Annotation<boolean | undefined>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  // 已执行的工具结果
  toolResults: Annotation<ToolResult[]>({
    reducer: (prev, next) => [...(prev ?? []), ...(next ?? [])],
    default: () => [],
  }),
  // agent 决策出的待执行工具调用(支持一次多个);执行后由 tools 节点清空
  pendingTools: Annotation<ToolCall[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
});

// ────────────────────────────────────────────────────────────
// draft 节点:非流式生成草稿答案,供 agent 判断是否需要工具
// ────────────────────────────────────────────────────────────
function draftNode(deps: GraphDeps) {
  return async (state: typeof ChatAnnotation.State) => {
    const msgs = buildChatMessages(state, deps.config.chat.historyTurns);
    const answer = await deps.llm.chat(msgs, {
      temperature: deps.config.chat.temperature,
      maxTokens: deps.config.chat.maxTokens,
    });
    return { answer };
  };
}

// ────────────────────────────────────────────────────────────
// agent 节点:草稿生成后,LLM 统一决策是否调用天气/景点工具
//  - 天气:用户问题涉及出行日期且草稿未覆盖天气
//  - 景点:草稿提到用户未问及的景点且描述不具体
// 可同时决策多个工具。
// ────────────────────────────────────────────────────────────
function buildAgentPrompt(question: string, answer: string): string {
  const toolLines = Object.values(TOOLS).map((t) => {
    const props = (z.toJSONSchema(t.argsSchema) as any)?.properties ?? {};
    return `- ${t.name}: ${t.description} 参数:${JSON.stringify(props)}`;
  });
  return [
    '你是石家庄旅游助手的工具决策环节。根据用户问题和助手的草稿回答,判断是否需要调用工具补充信息。',
    '',
    '可用工具:',
    ...toolLines,
    '',
    `用户问题: ${question}`,
    `助手草稿: ${answer}`,
    '',
    '决策规则:',
    '- get_weather: 问题涉及具体出行日期(今天/明天/周X/M月D日等)且草稿未提及天气时调用;',
    '- scenic_spot_info: 草稿提到了用户问题里没有的具体景点,且描述不够具体(缺门票/开放时间/交通等)时调用;',
    '- 可同时调用多个工具。',
    '',
    '需要调用工具则输出 JSON: {"tools":[{"tool":"工具名","args":{...}}]}',
    '不需要则输出: {"tools":[]}',
    '只输出 JSON,不要解释。',
  ].join('\n');
}

/** 解析模型输出的工具调用列表。 */
function parseAgentOutputs(raw: string): ToolCall[] {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    const arr = Array.isArray(obj?.tools) ? obj.tools : [];
    return arr
      .filter((c: any) => c && typeof c.tool === 'string')
      .map((c: any) => ({ tool: c.tool, args: c.args ?? {} }));
  } catch {
    return [];
  }
}

function agentNode(deps: GraphDeps) {
  return async (state: typeof ChatAnnotation.State) => {
    const system = buildAgentPrompt(state.question, state.answer ?? '');
    const raw = await deps.llm.chat([{ role: 'system', content: system }], {
      temperature: 0,
      maxTokens: 300,
    });
    const calls = parseAgentOutputs(raw).filter((c) => TOOLS[c.tool]);
    return { pendingTools: calls };
  };
}

// ────────────────────────────────────────────────────────────
// tools 节点:批量执行 pendingTools,结果并入 state.docs
// ────────────────────────────────────────────────────────────
function toolsNode(deps: GraphDeps) {
  return async (state: typeof ChatAnnotation.State) => {
    const calls = state.pendingTools;
    if (!calls.length) return { pendingTools: [] };

    const results: ToolResult[] = [];
    const extraDocs: RetrievedDoc[] = [];

    for (const call of calls) {
      const tool = TOOLS[call.tool];
      const parsed = tool.argsSchema.safeParse(call.args);
      if (!parsed.success) {
        results.push({
          tool: call.tool,
          args: call.args,
          text: `工具 ${call.tool} 入参校验失败:${parsed.error.message}`,
        });
        continue;
      }
      const { text, docs } = await tool.run(parsed.data, deps);
      results.push({ tool: call.tool, args: call.args, text });
      if (docs?.length) {
        extraDocs.push(...docs);
      } else {
        // 无 docs 时(如天气)把 text 包装成合成 RetrievedDoc,供 generate 纳入上下文
        extraDocs.push({
          text,
          source: `tool:${call.tool}`,
          score: 1,
          meta: { title: `${call.tool} 结果`, tags: [], source: `tool:${call.tool}` },
        });
      }
    }

    return {
      docs: [...state.docs, ...extraDocs],
      toolResults: results,
      pendingTools: [],
    };
  };
}

// ────────────────────────────────────────────────────────────
// finalize 节点:最终流式输出
//  - 用了任意工具:调用 nodes.generate 真实流式(上下文含工具补充的 docs)
//  - 没用工具:把草稿答案分块流式 emit,省一次 LLM 调用
// ────────────────────────────────────────────────────────────
function appendRagNotes(answer: string, state: typeof ChatAnnotation.State, deps: GraphDeps): string {
  if (!state.docs.length && state.filteredEmpty) {
    return answer + '\n(注:未检索到本地资料,以上回答基于模型常识)';
  }
  if (!state.docs.length && deps.ragDegraded) {
    return answer + '\n(注:本地资料检索暂不可用,以上回答基于模型常识)';
  }
  return answer;
}

/** 把文本按小块流式 emit,模拟打字机效果。 */
async function streamText(deps: GraphDeps, sessionId: string, text: string): Promise<void> {
  const chunkSize = 2;
  for (let i = 0; i < text.length; i += chunkSize) {
    deps.emit(AgentEvents.CHAT_TOKEN, {
      requestId: deps.requestId,
      sessionId,
      token: text.slice(i, i + chunkSize),
    });
  }
}

function finalizeNode(deps: GraphDeps) {
  return async (state: typeof ChatAnnotation.State) => {
    const usedAnyTool = state.toolResults.length > 0;
    if (usedAnyTool) {
      // 工具已补充 docs(天气/景点),走真实流式生成(节点内部 emit chat:token + chat:done)
      return nodes.generate(deps)(state);
    }
    // 无工具:直接流式输出草稿答案,避免重复 LLM 调用
    const answer = appendRagNotes(state.answer ?? '', state, deps);
    await streamText(deps, state.sessionId, answer);
    deps.emit(AgentEvents.CHAT_DONE, {
      requestId: deps.requestId,
      sessionId: state.sessionId,
      answer,
      sources: uniqueSources(state.docs),
    });
    return { answer };
  };
}

// ────────────────────────────────────────────────────────────
// 图:retrieve → draft → agent → [tools →] finalize → END
// ────────────────────────────────────────────────────────────
function buildChatGraph(deps: GraphDeps) {
  return new StateGraph(ChatAnnotation)
    .addNode('retrieve', nodes.retrieve(deps, { emitProgress: false }) as never)
    .addNode('draft', draftNode(deps) as never)
    .addNode('agent', agentNode(deps) as never)
    .addNode('tools', toolsNode(deps) as never)
    .addNode('finalize', finalizeNode(deps) as never)
    .addEdge(START, 'retrieve')
    .addEdge('retrieve', 'draft')
    .addEdge('draft', 'agent')
    .addConditionalEdges('agent', (state) => (state.pendingTools.length ? 'tools' : 'finalize'))
    .addEdge('tools', 'finalize')
    .addEdge('finalize', END)
    .compile();
}

export interface ChatGraphInput {
  question: string;
  sessionId: string;
  history: Msg[];
}

/**
 * 运行问答图。token 与 chat:done 由 finalize 节点推送。
 * 流程:retrieve → draft(非流式草稿) → agent(LLM 决策工具) → [tools] → finalize(流式输出)。
 */
export async function runChatGraph(
  deps: GraphDeps,
  input: ChatGraphInput,
): Promise<string | undefined> {
  const graph = buildChatGraph(deps);
  const final = await graph.invoke(input as Partial<ChatState>);
  return final?.answer as string | undefined;
}
