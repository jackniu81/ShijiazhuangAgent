import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AgentEvents,
  AppErrorEvent,
  ChatAskPayload,
  PlanCreatePayload,
} from './agent.types';
import { CancelledSignal } from './graph/graph.types';
import { GraphDeps } from './graph/graph.types';
import { runChatGraph } from './graph/chat.graph';
import { runPlanGraph } from './graph/plan.graph';
import { LLM_PROVIDER } from './llm/llm.factory';
import { LLMProvider } from './llm/llm.types';
import { RagService } from './rag/rag.service';
import { APP_CONFIG, AppConfig } from '../config/configuration';

/** 向当前连接的 client 发送事件的回调,由 Gateway 注入。 */
export type Emit = (event: string, data: unknown) => void;

/** 返回 true 表示该请求已被 client 取消,应尽快停止。 */
export type IsCancelled = () => boolean;

/**
 * 编排入口:组装 LangGraph 运行依赖,驱动行程/问答图,并把执行异常收敛为
 * api-spec 约定的 app:error 事件。真实数据来自内存 RAG + LLMProvider。
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly rag: RagService,
  ) {}

  async generatePlan(
    payload: PlanCreatePayload,
    emit: Emit,
    isCancelled: IsCancelled,
  ): Promise<void> {
    const { requestId, input } = payload;

    if (!input || !Number.isInteger(input.days) || input.days < 1 || input.days > 7) {
      emitError(emit, requestId, 'INVALID_INPUT', '行程天数需为 1-7 的整数。');
      return;
    }

    const deps = this.buildDeps(requestId, emit, isCancelled);
    try {
      await runPlanGraph(deps, input);
    } catch (err) {
      this.handleError(err, emit, requestId, '生成行程时出现错误,请稍后重试。');
    }
  }

  async answerQuestion(
    payload: ChatAskPayload,
    emit: Emit,
    isCancelled: IsCancelled,
  ): Promise<void> {
    const { requestId, sessionId, question } = payload;

    if (!question || !question.trim()) {
      emitError(emit, requestId, 'INVALID_INPUT', '问题不能为空。');
      return;
    }

    const deps = this.buildDeps(requestId, emit, isCancelled);
    try {
      // history 暂为空;多轮上下文在后续迭代接入
      await runChatGraph(deps, { question, sessionId, history: [] });
    } catch (err) {
      this.handleError(err, emit, requestId, '回答问题时出现错误,请稍后重试。');
    }
  }

  private buildDeps(requestId: string, emit: Emit, isCancelled: IsCancelled): GraphDeps {
    return {
      llm: this.llm,
      retrieve: (query, k) => this.rag.retrieve(query, k ?? this.config.rag.topK),
      config: this.config,
      emit,
      requestId,
      isCancelled,
    };
  }

  private handleError(err: unknown, emit: Emit, requestId: string, fallback: string): void {
    if (err instanceof CancelledSignal) return; // 取消已单独上报
    this.logger.error(err instanceof Error ? err.stack : String(err));
    emitError(emit, requestId, 'INTERNAL', fallback);
  }
}

function emitError(emit: Emit, requestId: string, code: AppErrorEvent['code'], message: string): void {
  emit(AgentEvents.APP_ERROR, { requestId, code, message } as AppErrorEvent);
}
