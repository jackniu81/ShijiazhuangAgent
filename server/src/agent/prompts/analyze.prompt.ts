import { Msg } from '../llm/llm.types';
import { ToolResult } from '../graph/graph.types';

/** 拼入 analyze 的历史对话条数(最近 2 轮),用于消解追问指代。 */
const ANALYZE_HISTORY_MSGS = 4;

/** analyze 节点工具调度 prompt(chat-tools-spec §5.2/P4):LLM 只输出 JSON 决策,不执行工具。 */
export const ANALYZE_SYSTEM_PROMPT =
  '你是石家庄旅游问答助手的工具调度器。根据用户问题、已覆盖景点和已执行工具,' +
  '判断本轮是否需要调用工具补充信息。只输出符合 schema 的 JSON,不要任何解释或多余文字。\n' +
  '可用工具:\n' +
  '- weather: 查询天气。仅当问题询问天气/出行穿着且含今天起 0~5 天内的明确日期时调用,' +
  'params:{"date":"YYYY-MM-DD","city"?:string}。相对日期(今天/明天/后天/下周二等)需换算为绝对日期。\n' +
  '- rag_attraction: 补充检索景点资料。仅当问题提到的景点不在"已覆盖景点"中、且需要其资料才能回答时调用,' +
  'params:{"attraction":string}。\n' +
  '- web_search: 网站查询实时信息。仅当本地资料未覆盖、且问题需要最新的开放时间/票价/预约/活动/政策等实时信息时调用,' +
  'params:{"query":string}。query 应为简洁的检索关键词。\n' +
  '规则:每轮最多返回 1 个工具调用;已执行过的工具不要重复;都不需要时返回 {"toolCalls":[]}。\n' +
  'schema: {"toolCalls":[{"name":"weather"|"rag_attraction"|"web_search","params":object}]}';

export interface AnalyzePromptInput {
  question: string;
  /** 今天日期 YYYY-MM-DD(本地),模型据此把相对日期换算为绝对日期 */
  today: string;
  /** baseline + 工具检索已覆盖的景点标题 */
  docTitles: string[];
  /** 已执行工具及参数,供模型去重 */
  toolResults: ToolResult[];
  /** 近期对话(spec §5.2):追问"它门票多少""那里天气呢"需据此消解指代 */
  history?: Msg[];
}

export function buildAnalyzeMessages(input: AnalyzePromptInput): Msg[] {
  const executed = input.toolResults.length
    ? input.toolResults
        .map((r) =>
          r.name === 'rag_attraction'
            ? `rag_attraction(attraction=${String(r.params.attraction ?? '')})`
            : r.name === 'web_search'
              ? `web_search(query=${String(r.params.query ?? '')})`
              : `weather(date=${String(r.params.date ?? '')})`,
        )
        .join('、')
    : '无';
  const history = (input.history ?? []).slice(-ANALYZE_HISTORY_MSGS);
  const historyBlock = history.length
    ? '\n近期对话:\n' +
      history.map((m) => `- ${m.role === 'user' ? '用户' : '助手'}:${m.content}`).join('\n')
    : '';
  const content =
    `今天:${input.today}\n` +
    `已覆盖景点:${input.docTitles.join('、') || '无'}\n` +
    `已执行工具:${executed}` +
    historyBlock +
    `\n用户问题:${input.question}`;
  return [
    { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
    { role: 'user', content },
  ];
}
