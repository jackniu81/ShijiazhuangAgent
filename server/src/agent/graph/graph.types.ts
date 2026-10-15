import type { Msg } from '../llm/llm.types';
import type { PlanCreatePayload, TravelPlan } from '@shijiazhuang-agent/shared';
import type { RetrievedDoc } from '../rag/rag.types';
import type { Emit, IsCancelled } from '../agent.service';
import type { LLMProvider } from '../llm/llm.types';
import type { AppConfig } from '../../config/configuration';

/** 图运行依赖。requestId 维度的 emit / 取消信号在每次请求时注入。 */
export interface GraphDeps {
  llm: LLMProvider;
  /** 已绑定数据源的检索函数 */
  retrieve: (query: string, k?: number) => Promise<RetrievedDoc[]>;
  /** 天气查询函数,由 AgentService 注入;缺省时 weather 工具返回"不可用" */
  weather?: (date: string, city?: string) => Promise<string>;
  /** 网站查询函数(实时信息),由 AgentService 注入;缺省时 web_search 工具返回"未找到" */
  webSearch?: (query: string) => Promise<string>;
  config: AppConfig;
  emit: Emit;
  requestId: string;
  isCancelled: IsCancelled;
  /** 取消/超时联动信号,传给 provider 中断在途 HTTP 流(issue #7/#8) */
  signal?: AbortSignal;
  /** RAG 索引降级(构建失败)时为 true,回答中会注明未检索到本地资料 */
  ragDegraded: boolean;
}

/** 行程图状态值。 */
export interface PlanState {
  input: PlanCreatePayload['input'];
  docs: RetrievedDoc[];
  plan?: TravelPlan;
}

export interface ToolCall {
  name: 'weather' | 'rag_attraction' | 'web_search';
  params: Record<string, unknown>;
}

export interface ToolResult {
  name: ToolCall['name'];
  params: Record<string, unknown>;
  output: string;
  docs?: RetrievedDoc[];
}

/** 问答图状态值。 */
export interface ChatState {
  question: string;
  sessionId: string;
  history: Msg[];
  docs: RetrievedDoc[];          // baseline retrieve 结果(不变)
  answer?: string;
  filteredEmpty?: boolean;       // 现有阈值全过滤标记(不变)
  toolCalls: ToolCall[];         // analyze 产出的本轮待执行工具
  toolResults: ToolResult[];     // 各工具累计执行结果
}

/** 节点边界检测到取消时抛出,用于中断 LangGraph 执行。 */
export class CancelledSignal extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledSignal';
  }
}
