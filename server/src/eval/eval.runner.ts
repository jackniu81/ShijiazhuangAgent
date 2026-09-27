import { AgentEvents, AppErrorEvent, ChatDoneEvent, PlanResultEvent } from '@shijiazhuang-agent/shared';
import { CaseOutcome, EvalCase, loadDataset } from './eval.types';

export type { CaseOutcome } from './eval.types';

/**
 * 金标评估执行器(issue #58 PR2):通过 WebSocket 对运行中的 server 逐题实跑。
 * 仅依赖 EvalSocket 结构性接口(on/off/emit),便于单测注入 fake,无需真实网络。
 */

export interface EvalSocket {
  on(event: string, handler: (d: unknown) => void): void;
  off(event: string, handler: (d: unknown) => void): void;
  emit(event: string, payload?: unknown): void;
}

const newReqId = (prefix: string) => `${prefix}-eval-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function once<T>(sock: EvalSocket, event: string, reqId: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      sock.off(event, handler);
      sock.off(AgentEvents.APP_ERROR, errHandler);
      fn();
    };
    const handler = (d: unknown) => {
      const evt = d as { requestId?: string };
      if (evt?.requestId !== reqId) return;
      finish(() => resolve(d as T));
    };
    const errHandler = (d: unknown) => {
      const evt = d as AppErrorEvent;
      if (evt.requestId && evt.requestId !== reqId) return;
      finish(() => reject(new Error(`app:error ${evt.code}: ${evt.message}`)));
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`等待 ${event} 超时(${timeoutMs}ms)`))), timeoutMs);
    sock.on(event, handler);
    sock.on(AgentEvents.APP_ERROR, errHandler);
  });
}

/** 跑一道 chat 题:发送问题,聚合流式 token,等待 chat:done。 */
export async function runChatCase(sock: EvalSocket, question: string, timeoutMs: number): Promise<{ answer: string; sources: string[] }> {
  const requestId = newReqId('chat');
  const sessionId = `eval-${requestId}`;
  const doneP = once<ChatDoneEvent>(sock, AgentEvents.CHAT_DONE, requestId, timeoutMs);
  const chunks: string[] = [];
  const tokHandler = (d: unknown) => {
    const t = d as { requestId?: string; token?: string };
    if (t.requestId === requestId && typeof t.token === 'string') chunks.push(t.token);
  };
  sock.on(AgentEvents.CHAT_TOKEN, tokHandler);
  try {
    sock.emit(AgentEvents.CHAT_ASK, { requestId, sessionId, question });
    const done = await doneP;
    return { answer: done.answer || chunks.join(''), sources: done.sources ?? [] };
  } finally {
    sock.off(AgentEvents.CHAT_TOKEN, tokHandler);
  }
}

/** 跑一道 plan 题:等待 plan:result,返回全文与逐日条目数。 */
export async function runPlanCase(
  sock: EvalSocket,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ planText: string; dayCount: number; itemsPerDay: number[] }> {
  const requestId = newReqId('plan');
  const doneP = once<PlanResultEvent>(sock, AgentEvents.PLAN_RESULT, requestId, timeoutMs);
  sock.emit(AgentEvents.PLAN_CREATE, { requestId, input });
  const res = await doneP;
  const days = res.plan?.days ?? [];
  return {
    planText: JSON.stringify(res.plan),
    dayCount: days.length,
    itemsPerDay: days.map((d) => d.items?.length ?? 0),
  };
}

/** 串行执行数据集全部题目;judge 注入判分函数以保持纯函数边界。 */
export async function runDataset(
  sock: EvalSocket,
  timeoutMs: number,
  judge: (c: EvalCase, actual: { answer?: string; sources?: string[]; planText?: string; dayCount: number; itemsPerDay?: number[] }) => string[],
  log: (line: string) => void = () => undefined,
): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];
  for (const c of loadDataset().cases) {
    const t0 = Date.now();
    let reasons: string[];
    try {
      if (c.kind === 'chat') {
        const r = await runChatCase(sock, c.question, timeoutMs);
        reasons = judge(c, { answer: r.answer, sources: r.sources, dayCount: 1 });
      } else {
        const r = await runPlanCase(sock, c.input as unknown as Record<string, unknown>, timeoutMs);
        reasons = judge(c, { planText: r.planText, dayCount: r.dayCount, itemsPerDay: r.itemsPerDay });
      }
    } catch (e) {
      reasons = [(e as Error).message];
    }
    const latencyMs = Date.now() - t0;
    const outcome: CaseOutcome = {
      id: c.id,
      kind: c.kind,
      category: c.category,
      question: c.kind === 'chat' ? c.question : JSON.stringify(c.input),
      pass: reasons.length === 0,
      reasons,
      latencyMs,
    };
    outcomes.push(outcome);
    log(`${outcome.pass ? 'PASS' : 'FAIL'} ${c.id}(${c.category}) ${Math.round(latencyMs / 100) / 10}s${outcome.pass ? '' : ' ' + reasons.join('; ')}`);
  }
  return outcomes;
}
