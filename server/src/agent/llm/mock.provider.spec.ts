import { Msg } from './llm.types';
import { MockProvider } from './mock.provider';
import { PLAN_SYSTEM_PROMPT, buildPlanMessages } from '../prompts/plan.prompt';

const provider = new MockProvider({ streamDelayMs: 0 });

describe('MockProvider 行程请求回放 JSON (#60)', () => {
  it('命中行程 prompt 时输出可解析的 plan JSON,天数按需求给足', async () => {
    const raw = await provider.chat(buildPlanMessages({ days: 3 }, []));
    const plan = JSON.parse(raw);
    expect(plan.days).toHaveLength(3);
    expect(plan.days[0].items.length).toBeGreaterThan(0);
    expect(typeof plan.title).toBe('string');
    expect(typeof plan.summary).toBe('string');
  });

  it('读不到天数时兜底 1 天,不吐空 days', async () => {
    const msgs: Msg[] = [
      { role: 'system', content: PLAN_SYSTEM_PROMPT },
      { role: 'user', content: '需求里没有天数字段' },
    ];
    expect(JSON.parse(await provider.chat(msgs)).days).toHaveLength(1);
  });

  it('问答请求仍走模板回答,不变成 JSON', async () => {
    const answer = await provider.chat([{ role: 'user', content: 'Q:石家庄有什么好玩的' }]);
    expect(answer).not.toMatch(/^\s*[\[{]/);
    expect(answer).toContain('石家庄');
  });

  it('stream 分片拼回与 chat 一致', async () => {
    const msgs = buildPlanMessages({ days: 2 }, []);
    let emitted = '';
    const full = await provider.stream(msgs, (t) => {
      emitted += t;
    });
    expect(emitted).toBe(full);
    expect(JSON.parse(full).days).toHaveLength(2);
  });
});
