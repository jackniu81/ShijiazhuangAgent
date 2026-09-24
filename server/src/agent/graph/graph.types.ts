import type { Msg } from '../llm/llm.types';
import type { PlanCreatePayload } from '../agent.types';
import type { RetrievedDoc } from '../rag/rag.types';
import type { TravelPlan } from '../agent.types';
import type { Emit, IsCancelled } from '../agent.service';
import type { LLMProvider } from '../llm/llm.types';
import type { AppConfig } from '../../config/configuration';

/** 图运行依赖。requestId 维度的 emit / 取消信号在每次请求时注入。 */
export interface GraphDeps {
  llm: LLMProvider;
  /** 已绑定数据源的检索函数 */
  retrieve: (query: string, k?: number) => Promise<RetrievedDoc[]>;
  config: AppConfig;
  emit: Emit;
  requestId: string;
  isCancelled: IsCancelled;
}

/** 行程图状态值。 */
export interface PlanState {
  input: PlanCreatePayload['input'];
  docs: RetrievedDoc[];
  plan?: TravelPlan;
}

/** 问答图状态值。 */
export interface ChatState {
  question: string;
  sessionId: string;
  history: Msg[];
  docs: RetrievedDoc[];
  answer?: string;
}

/** 节点边界检测到取消时抛出,用于中断 LangGraph 执行。 */
export class CancelledSignal extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledSignal';
  }
}
