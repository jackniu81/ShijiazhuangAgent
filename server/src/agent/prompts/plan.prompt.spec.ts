import { RetrievedDoc } from '../rag/rag.types';
import { uniqueSources, uniqueTitles } from './util';
import {
  buildPlanMessages,
  buildPlanRepairMessages,
  PLAN_SCHEMA_HINT,
  PLAN_SYSTEM_PROMPT,
} from './plan.prompt';

const doc = (title: string, source: string, text = 'x'): RetrievedDoc => ({
  text,
  source,
  score: 1,
  meta: { title, tags: [], source },
});

describe('plan.prompt', () => {
  it('system 人设 + schema 保持,并追加防幻觉事实性约束(issue #90)', () => {
    expect(PLAN_SYSTEM_PROMPT.startsWith('你是石家庄旅游规划助手。只输出符合给定 JSON schema 的行程,不要多余文字。')).toBe(true);
    expect(PLAN_SYSTEM_PROMPT).toContain('不得出现参考资料未给出的票价、开放时间或交通班次断言');
    expect(PLAN_SYSTEM_PROMPT).toContain('资料未提及,建议出行前核实');
    expect(PLAN_SYSTEM_PROMPT).toContain('禁止编造数字');
    expect(PLAN_SYSTEM_PROMPT.endsWith(PLAN_SCHEMA_HINT)).toBe(true);
    expect(PLAN_SCHEMA_HINT.startsWith('schema: ')).toBe(true);
  });

  it('user 消息包含全部需求字段与默认值', () => {
    const msgs = buildPlanMessages({ days: 2 }, []);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toContain('需求:天数=2,人数=1,预算=comfort,兴趣=不限,偏好=无');
    expect(msgs[1].content).toContain('参考本地资料:\n(无)');
  });

  it('兴趣/偏好/资料按格式渲染,单条资料截 120 字', () => {
    const long = '山'.repeat(200);
    const msgs = buildPlanMessages(
      { days: 3, travelers: 2, budget: 'low', interests: ['山水', '红色'], preferences: '慢行' },
      [doc('苍岩山', 'attractions/苍岩山.md', long)],
    );
    const user = msgs[1].content;
    expect(user).toContain('兴趣=山水/红色');
    expect(user).toContain('- 苍岩山:' + '山'.repeat(120));
    expect(user).not.toContain('山'.repeat(121));
  });

  it('回炉 messages:原需求 + 上次脏输出 + 具体错误清单(issue #59)', () => {
    const msgs = buildPlanMessages({ days: 2 }, []);
    const repair = buildPlanRepairMessages({ days: 2 }, [], '坏输出', [
      'days: 期望数组',
      'title: 缺少标题',
    ]);

    // 前两轮与原对话一致,模型仍看得到完整需求
    expect(repair.slice(0, 2)).toEqual(msgs);
    expect(repair[2]).toEqual({ role: 'assistant', content: '坏输出' });
    const feedback = repair[3].content;
    expect(repair[3].role).toBe('user');
    expect(feedback).toContain('未通过结构校验');
    expect(feedback).toContain('- days: 期望数组');
    expect(feedback).toContain('- title: 缺少标题');
    expect(repair).toHaveLength(4);
  });

  it('回炉时超长脏输出截 1500 字,避免把上下文撑爆', () => {
    const msgs = buildPlanRepairMessages({ days: 1 }, [], '脏'.repeat(2000), ['x']);
    expect(msgs[2].content).toBe('脏'.repeat(1500));
    expect(msgs[3].content).toContain('上次输出(节选)');
  });
});

describe('prompts/util', () => {
  it('uniqueTitles/uniqueSources 保序去重并过滤空值', () => {
    const docs = [doc('A', 'a.md'), doc('A', 'a.md'), doc('B', 'b.md'), doc('', 'c.md')];
    expect(uniqueTitles(docs)).toEqual(['A', 'B']);
    expect(uniqueSources(docs)).toEqual(['a.md', 'b.md', 'c.md']);
  });
});
