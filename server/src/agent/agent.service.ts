import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AgentEvents,
  AppErrorEvent,
  ChatAskPayload,
  PlanCreatePayload,
} from '@shijiazhuang-agent/shared';
import { CancelledSignal } from './graph/graph.types';
import { GraphDeps } from './graph/graph.types';
import { runChatGraph } from './graph/chat.graph';
import { runPlanGraph } from './graph/plan.graph';
import { SESSION_STORE, SessionStore } from './chat/session.store';
import { LLMError } from './llm/http';
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
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
    private readonly rag: RagService,
  ) {}

  async generatePlan(
    payload: PlanCreatePayload,
    emit: Emit,
    isCancelled: IsCancelled,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const { requestId, input } = payload;

    if (!input || !Number.isInteger(input.days) || input.days < 1 || input.days > 7) {
      emitError(emit, requestId, 'INVALID_INPUT', '行程天数需为 1-7 的整数。');
      return;
    }

    const ctrl = new AbortController();
    const deps = this.buildDeps(requestId, emit, isCancelled, ctrl, externalSignal);
    try {
      await this.withTimeout(runPlanGraph(deps, input), ctrl);
    } catch (err) {
      this.handleError(err, emit, requestId, isCancelled, '生成行程时出现错误,请稍后重试。');
    }
  }

  async answerQuestion(
    payload: ChatAskPayload,
    emit: Emit,
    isCancelled: IsCancelled,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const { requestId, sessionId, question } = payload;

    const trimmed = question?.trim();
    if (!trimmed) {
      emitError(emit, requestId, 'INVALID_INPUT', '问题不能为空。');
      return;
    }
    if (trimmed.length > this.config.chat.questionMaxLen) {
      emitError(
        emit,
        requestId,
        'INVALID_INPUT',
        `问题过长(最多 ${this.config.chat.questionMaxLen} 字),请精简后再问。`,
      );
      return;
    }

    const ctrl = new AbortController();
    const deps = this.buildDeps(requestId, emit, isCancelled, ctrl, externalSignal);
    const history = this.sessions.getHistory(sessionId);
    try {
      const answer = await this.withTimeout(
        runChatGraph(deps, { question: trimmed, sessionId, history }),
        ctrl,
      );
      if (answer) this.sessions.appendTurn(sessionId, trimmed, answer);
    } catch (err) {
      this.handleError(err, emit, requestId, isCancelled, '回答问题时出现错误,请稍后重试。');
    }
  }

  /**
   * 单请求超时兜底(spec §8 LLM_TIMEOUT_MS):
   * 超时后 abort 内部信号,中断在途的 provider HTTP 流,并抛可读 LLMError。
   */
  private withTimeout<T>(task: Promise<T>, ctrl: AbortController): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new LLMError('响应超时,请稍后重试。', false));
      }, this.config.llm.timeoutMs);
    });
    return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
  }

  private buildDeps(
    requestId: string,
    emit: Emit,
    isCancelled: IsCancelled,
    ctrl: AbortController,
    externalSignal?: AbortSignal,
  ): GraphDeps {
    // 联动"请求内超时 abort"与"gateway 取消 abort",传给 provider 中断在途流
    const signal = externalSignal
      ? AbortSignal.any([ctrl.signal, externalSignal])
      : ctrl.signal;
    return {
      llm: this.llm,
      retrieve: (query, k) => this.rag.retrieve(query, k ?? this.config.rag.topK),
      config: this.config,
      emit,
      requestId,
      isCancelled,
      signal,
      ragDegraded: this.rag.isDegraded,
    };
  }

  private handleError(
    err: unknown,
    emit: Emit,
    requestId: string,
    isCancelled: IsCancelled,
    fallback: string,
  ): void {
    if (err instanceof CancelledSignal) return; // 节点边界取消,已单独上报
    if (isCancelled()) return; // provider 因取消 abort 的连带异常,静默
    if (err instanceof LLMError) {
      this.logger.warn(`llm error: ${err.message}`);
      emitError(emit, requestId, 'LLM_ERROR', err.message);
      return;
    }
    this.logger.error(err instanceof Error ? err.stack : String(err));
    emitError(emit, requestId, 'INTERNAL', fallback);
  }
}

function emitError(emit: Emit, requestId: string, code: AppErrorEvent['code'], message: string): void {
  emit(AgentEvents.APP_ERROR, { requestId, code, message } as AppErrorEvent);
}
