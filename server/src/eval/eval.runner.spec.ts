import { AgentEvents } from '@shijiazhuang-agent/shared';
import { ChatCase, PlanCase } from './eval.types';
import { judgeCase, judgeChat, normalize } from './eval.matcher';
import { EvalSocket, runChatCase, runDataset } from './eval.runner';

const chat = (over: Partial<ChatCase> = {}): ChatCase => ({
  id: 'T99',
  kind: 'chat',
  category: 'ticket',
  question: 'q?',
  expect: {},
  ...over,
});

describe('normalize / judgeChat 判分规则(issue #58)', () => {
  it('空白与大小写不敏感:2元 == 2 元', () => {
    expect(normalize('门票 2元')).toBe(normalize('门票2元'));
    const c = chat({ expect: { keywords_any: ['2元'] } });
    expect(judgeChat(c, '起步价为 2 元')).toEqual([]);
  });

  it('keywords_all 缺一即败,keywords_any 全缺即败', () => {
    const c = chat({ expect: { keywords_all: ['扣肉', '肘子'], keywords_any: ['鸡肉', '丸子'] } });
    expect(judgeChat(c, '有扣肉和肘子,还有丸子')).toEqual([]);
    expect(judgeChat(c, '只有扣肉和肘子')).toHaveLength(1); // 缺 any 组
    expect(judgeChat(c, '只有扣肉')).toHaveLength(2);
  });

  it('forbid 命中即败(防附和错误前提)', () => {
    const c = chat({ category: 'robustness', expect: { forbid: ['是的 80', '没错'] } });
    expect(judgeChat(c, '您记得没错,就是 80 元')).not.toEqual([]);
    expect(judgeChat(c, '语料中没有该票价信息')).toEqual([]);
  });

  it('sources_any 路径任一命中(容 backslash/前缀)', () => {
    const c = chat({ expect: { keywords_any: ['40'], sources_any: ['attractions/荣国府.md'] } });
    expect(judgeChat(c, '40 元', ['attractions\\荣国府.md'])).toEqual([]);
    expect(judgeChat(c, '40 元', ['food/牛肉板面.md'])).toHaveLength(1);
    expect(judgeChat(c, '40 元', [])).toHaveLength(1);
  });

  it('judgeCase 分发 plan:天数结构 + forbid', () => {
    const p: PlanCase = {
      id: 'PL99', kind: 'plan', category: 'advice',
      input: { days: 2 }, expect: { days: 2, keywords_any: ['正定'], forbid: ['驼梁'] },
    };
    expect(judgeCase(p, { planText: '{"days":[{},{}],"t":"正定两日"}', dayCount: 2 })).toEqual([]);
    expect(judgeCase(p, { planText: '正定', dayCount: 1 })).toHaveLength(1);
    expect(judgeCase(p, { planText: '正定与驼梁', dayCount: 2 })).toHaveLength(1);
  });
});

/** 内存 fake socket:按预设脚本回应 chat:ask / plan:create。 */
function fakeSocket(handler: (payload: Record<string, unknown>, fire: (e: string, d: unknown) => void) => void): EvalSocket {
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const fire = (e: string, d: unknown) => listeners.get(e)?.forEach((h) => h(d));
  const sock: EvalSocket = {
    on: (e, h) => (listeners.get(e) ?? listeners.set(e, new Set()).get(e)!).add(h),
    off: (e, h) => listeners.get(e)?.delete(h),
    emit: (e, payload) => setTimeout(() => handler((payload ?? {}) as Record<string, unknown>, fire), 0),
  };
  return sock;
}

describe('eval.runner 传输层(注入 fake socket)', () => {
  it('runChatCase 聚合 token 并在 chat:done 落定', async () => {
    const sock = fakeSocket((p, fire) => {
      const rid = p.requestId as string;
      fire(AgentEvents.CHAT_TOKEN, { requestId: rid, sessionId: p.sessionId, token: '门' });
      fire(AgentEvents.CHAT_TOKEN, { requestId: rid, sessionId: p.sessionId, token: '票40' });
      fire(AgentEvents.CHAT_DONE, { requestId: rid, sessionId: p.sessionId, answer: '门票40元', sources: ['attractions/荣国府.md'] });
    });
    const r = await runChatCase(sock, '荣国府门票?', 2000);
    expect(r.answer).toBe('门票40元');
    expect(r.sources).toEqual(['attractions/荣国府.md']);
  });

  it('app:error 使当题以失败原因落定', async () => {
    const sock = fakeSocket((p, fire) => {
      fire(AgentEvents.APP_ERROR, { requestId: p.requestId, code: 'LLM_ERROR', message: '响应超时' });
    });
    await expect(runChatCase(sock, 'q', 2000)).rejects.toThrow('LLM_ERROR');
  });

  it('无响应时按超时失败', async () => {
    const sock = fakeSocket(() => undefined);
    await expect(runChatCase(sock, 'q', 50)).rejects.toThrow('超时');
  });

  it('runDataset 串行跑完整数据集并判分(模拟服务全部答对)', async () => {
    const sock = fakeSocket((p, fire) => {
      const rid = p.requestId as string;
      if (rid.startsWith('chat')) {
        // 回答复述题目 + 常见关键词,由真实 dataset 的 judge 决定通过情况
        fire(AgentEvents.CHAT_DONE, { requestId: rid, sessionId: p.sessionId, answer: JSON.stringify(p.question), sources: [] });
      } else {
        // 覆盖 plan 金标断言的景点(避开被 forbid 的驼梁/嶂石岩),保证结构+关键词断言全中
        const items = ['河北博物院', '正定古城', '隆兴寺', '荣国府', '西柏坡', '苍岩山', '牛肉板面'].map((t) => ({ title: t }));
        fire(AgentEvents.PLAN_RESULT, { requestId: rid, plan: { title: '石家庄之旅', days: Array.from({ length: (p.input as { days: number }).days }, (_, i) => ({ day: i + 1, items })) } });
      }
    });
    const outcomes = await runDataset(sock, 2000, judgeCase);
    expect(outcomes.length).toBeGreaterThanOrEqual(30);
    expect(outcomes.every((o) => typeof o.latencyMs === 'number')).toBe(true);
    // chat 题仅复述问题,关键词断言必不全中;plan 题结构断言应通过
    expect(outcomes.some((o) => o.kind === 'chat' && !o.pass)).toBe(true);
    expect(outcomes.filter((o) => o.kind === 'plan').every((o) => o.pass)).toBe(true);
  });
});
