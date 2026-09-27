import { LLMError } from './llm/http';
import { SessionStore } from './chat/session.store';
import { AgentService } from './agent.service';
import { CancelledSignal } from './graph/graph.types';
import { runPlanGraph } from './graph/plan.graph';
import { runChatGraph } from './graph/chat.graph';
import type { GraphDeps } from './graph/graph.types';
import type { AppConfig } from '../config/configuration';
import type { RagService } from './rag/rag.service';
import {
  AgentEvents,
  type AppErrorEvent,
} from '@shijiazhuang-agent/shared';

// jest-runtime 无法 require 纯 ESM 的 @nestjs/common;service 仅需其装饰器/Logger。
jest.mock('@nestjs/common', () => ({
  Injectable: () => () => {},
  Inject: () => () => {},
  Logger: class {
    log(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  },
}));
// 图执行由 nodes.spec(#54)覆盖;service 单测隔离 LangGraph,仅验证编排/错误收敛。
jest.mock('./graph/plan.graph', () => ({ runPlanGraph: jest.fn() }));
jest.mock('./graph/chat.graph', () => ({ runChatGraph: jest.fn() }));

/**
 * AgentService 单测(issue #51):入参校验、deps 编排、会话历史写入、
 * 错误收敛(LLM_ERROR/INTERNAL)、取消收敛(CANCELLED 只报一次)、超时兜底。
 */

type EventName = (typeof AgentEvents)[keyof typeof AgentEvents];
type Emit = (event: string, data: unknown) => void;

function makeConfig(over: Partial<AppConfig['llm']> & Partial<AppConfig['chat']> = {}): AppConfig {
  return {
    llm: {
      provider: 'mock',
      timeoutMs: over.timeoutMs ?? 5000,
      fallback: { enabled: true, circuitFailures: 3, circuitCooldownMs: 60_000 },
      siliconflow: { apiKey: '', baseUrl: '', chatModel: '', embedModel: '' },
      ollama: { baseUrl: '', chatModel: '', embedModel: '' },
    },
    rag: {
      dataDir: 'data',
      topK: 5,
      chunkSize: 500,
      chunkOverlap: 50,
      hybrid: false,
      backend: 'memory',
      databaseUrl: '',
      vectorDim: 1024,
      vectorTable: 'rag_chunks',
    },
    chat: { historyTurns: 6, sessionTtlMs: 30 * 60_000, questionMaxLen: over.questionMaxLen ?? 500 },
    rateLimit: { maxConcurrentPerSession: 1, perWindow: 30, windowMs: 60_000 },
    wsAuth: { token: '' },
  };
}

const stubRag = (): RagService =>
  ({ retrieve: async () => [], isDegraded: false }) as unknown as RagService;

function makeSessions(): SessionStore {
  return new SessionStore({ maxTurns: 6, ttlMs: 60 * 60_000, sweepIntervalMs: 60 * 60_000 });
}

const fakeLlm = (): import('./llm/llm.types').LLMProvider =>
  ({ name: 'test', chat: async () => '{}', stream: async () => '', embed: async () => [] }) as import('./llm/llm.types').LLMProvider;

interface Harness {
  service: AgentService;
  emits: { event: EventName; data: unknown }[];
  types: EventName[];
  sessions: SessionStore;
  emit: Emit;
}

function harness(opts: { config?: AppConfig; sessions?: SessionStore } = {}): Harness {
  const sessions = opts.sessions ?? makeSessions();
  const service = new AgentService(fakeLlm(), opts.config ?? makeConfig(), sessions, stubRag());
  const emits: { event: EventName; data: unknown }[] = [];
  const emit: Emit = (event, data) => {
    emits.push({ event: event as EventName, data });
  };
  return { service, emits, sessions, emit, get types() { return emits.map((e) => e.event); } };
}

const NO_CANCEL = () => false;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AgentService — generatePlan', () => {
  it('非法 input(days=0)→ 仅 app:error INVALID_INPUT,不跑图', async () => {
    const h = harness();
    await h.service.generatePlan({ requestId: 'r1', input: { days: 0, interests: [] } }, h.emit, NO_CANCEL, new AbortController().signal);
    expect(runPlanGraph).not.toHaveBeenCalled();
    expect(h.types).toEqual([AgentEvents.APP_ERROR]);
    expect((h.emits[0].data as AppErrorEvent).code).toBe('INVALID_INPUT');
  });

  it('把注入的 emit 经 deps 透传给图,并带 requestId/isCancelled/signal', async () => {
    let seen: GraphDeps | undefined;
    (runPlanGraph as jest.Mock).mockImplementation(async (deps: GraphDeps) => {
      seen = deps;
      deps.emit(AgentEvents.PLAN_RESULT, { requestId: deps.requestId, plan: { title: 'T', days: [] } });
      return undefined;
    });
    const h = harness();
    const cancelled = () => false;
    await h.service.generatePlan({ requestId: 'r9', input: { days: 2, interests: ['文化'] } }, h.emit, cancelled, new AbortController().signal);
    expect(seen?.requestId).toBe('r9');
    expect(seen?.isCancelled).toBe(cancelled);
    expect(typeof seen?.emit).toBe('function');
    expect(h.emits.find((e) => e.event === AgentEvents.PLAN_RESULT)).toBeTruthy();
  });

  it('图内取消(节点抛 CancelledSignal)→ 仅一次 CANCELLED,service 不再补发', async () => {
    (runPlanGraph as jest.Mock).mockImplementation(async (deps: GraphDeps) => {
      deps.emit(AgentEvents.APP_ERROR, { requestId: deps.requestId, code: 'CANCELLED', message: '已取消' } as AppErrorEvent);
      throw new CancelledSignal();
    });
    const h = harness();
    await h.service.generatePlan({ requestId: 'r1', input: { days: 2, interests: [] } }, h.emit, NO_CANCEL, new AbortController().signal);
    const errors = h.emits.filter((e) => e.event === AgentEvents.APP_ERROR);
    expect(errors).toHaveLength(1);
    expect((errors[0].data as AppErrorEvent).code).toBe('CANCELLED');
  });

  it('图抛 LLMError → app:error LLM_ERROR,不冒泡', async () => {
    (runPlanGraph as jest.Mock).mockRejectedValue(new LLMError('生成失败'));
    const h = harness();
    await h.service.generatePlan({ requestId: 'r1', input: { days: 1, interests: [] } }, h.emit, NO_CANCEL, new AbortController().signal);
    const err = h.emits.find((e) => e.event === AgentEvents.APP_ERROR)?.data as AppErrorEvent;
    expect(err.code).toBe('LLM_ERROR');
  });

  it('图抛未知错误 → app:error INTERNAL', async () => {
    (runPlanGraph as jest.Mock).mockRejectedValue(new Error('kaboom'));
    const h = harness();
    await h.service.generatePlan({ requestId: 'r1', input: { days: 1, interests: [] } }, h.emit, NO_CANCEL, new AbortController().signal);
    const err = h.emits.find((e) => e.event === AgentEvents.APP_ERROR)?.data as AppErrorEvent;
    expect(err.code).toBe('INTERNAL');
  });
});

describe('AgentService — answerQuestion', () => {
  it('空问题 → INVALID_INPUT,不跑图', async () => {
    const h = harness();
    await h.service.answerQuestion({ requestId: 'r1', sessionId: 's', question: '   ' }, h.emit, NO_CANCEL, new AbortController().signal);
    expect(runChatGraph).not.toHaveBeenCalled();
    expect(h.types).toEqual([AgentEvents.APP_ERROR]);
    expect((h.emits[0].data as AppErrorEvent).code).toBe('INVALID_INPUT');
  });

  it('超长问题(> questionMaxLen)→ INVALID_INPUT', async () => {
    const h = harness({ config: makeConfig({ questionMaxLen: 5 }) });
    await h.service.answerQuestion({ requestId: 'r1', sessionId: 's', question: '一二三四五六七八九十' }, h.emit, NO_CANCEL, new AbortController().signal);
    expect((h.emits[0].data as AppErrorEvent).code).toBe('INVALID_INPUT');
  });

  it('正常问答:图返回答案后写入会话历史(一轮 user+assistant)', async () => {
    (runChatGraph as jest.Mock).mockResolvedValue('推荐正定八大碗');
    const h = harness();
    await h.service.answerQuestion({ requestId: 'r1', sessionId: 'sess-1', question: '正定有什么吃的' }, h.emit, NO_CANCEL, new AbortController().signal);
    expect(runChatGraph).toHaveBeenCalled();
    const history = h.sessions.getHistory('sess-1');
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: '正定有什么吃的' });
    expect(history[1]).toEqual({ role: 'assistant', content: '推荐正定八大碗' });
  });

  it('图抛错 → app:error LLM_ERROR,且不写会话历史', async () => {
    (runChatGraph as jest.Mock).mockRejectedValue(new LLMError('超时'));
    const h = harness();
    await h.service.answerQuestion({ requestId: 'r1', sessionId: 's', question: '你好' }, h.emit, NO_CANCEL, new AbortController().signal);
    const err = h.emits.find((e) => e.event === AgentEvents.APP_ERROR)?.data as AppErrorEvent;
    expect(err.code).toBe('LLM_ERROR');
    expect(h.sessions.getHistory('s')).toEqual([]);
  });

  it('超时兜底:图不 resolve 时 timeoutMs 到点后 abort 传入图的 signal 并发 LLM_ERROR', async () => {
    let graphSignal: AbortSignal | undefined;
    (runChatGraph as jest.Mock).mockImplementation((deps: GraphDeps) => {
      graphSignal = deps.signal;
      return new Promise<string>(() => {}); // 永不 resolve
    });
    const h = harness({ config: makeConfig({ timeoutMs: 15 }) });
    await h.service.answerQuestion({ requestId: 'r1', sessionId: 's', question: '你好' }, h.emit, NO_CANCEL, new AbortController().signal);
    const err = h.emits.find((e) => e.event === AgentEvents.APP_ERROR)?.data as AppErrorEvent;
    expect(err.code).toBe('LLM_ERROR');
    expect(graphSignal?.aborted).toBe(true);
  });
});
