import { RetrievedDoc } from '../rag/rag.types';
import { uniqueSources, uniqueTitles } from './util';
import { buildPlanMessages, isPlanPrompt, PLAN_SCHEMA_HINT, PLAN_SYSTEM_PROMPT, planRequestedDays } from './plan.prompt';

const doc = (title: string, source: string, text = 'x'): RetrievedDoc => ({
  text,
  source,
  score: 1,
  meta: { title, tags: [], source },
});

describe('plan.prompt', () => {
  it('system 人设 + schema 与抽出前逐字一致(回归锚点)', () => {
    expect(PLAN_SYSTEM_PROMPT).toBe(
      '你是石家庄旅游规划助手。只输出符合给定 JSON schema 的行程,不要多余文字。' +
        'schema: {"title":string,"days":[{"day":int,"items":[{"time":string,"title":string,"place":string,"description":string}]}],"summary":string,"tips":[string]}',
    );
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
});

describe('plan.prompt 行程请求识别 (#60)', () => {
  it('命中 PLAN_SYSTEM_PROMPT 即判定为行程请求,问答模板不误判', () => {
    expect(isPlanPrompt(buildPlanMessages({ days: 2 }, []))).toBe(true);
    expect(isPlanPrompt([{ role: 'system', content: '你是问答助手' }, { role: 'user', content: '天数=3' }])).toBe(false);
    expect(isPlanPrompt([])).toBe(false);
  });

  it('从需求行读回天数;缺失或非法按 1 天保守处理', () => {
    expect(planRequestedDays(buildPlanMessages({ days: 4 }, []))).toBe(4);
    expect(planRequestedDays([{ role: 'user', content: '需求:天数=7,人数=2' }])).toBe(7);
    expect(planRequestedDays([{ role: 'user', content: '没有天数字段' }])).toBe(1);
    expect(planRequestedDays([{ role: 'user', content: '天数=0' }])).toBe(1);
    expect(planRequestedDays([])).toBe(1);
  });
});

describe('prompts/util', () => {
  it('uniqueTitles/uniqueSources 保序去重并过滤空值', () => {
    const docs = [doc('A', 'a.md'), doc('A', 'a.md'), doc('B', 'b.md'), doc('', 'c.md')];
    expect(uniqueTitles(docs)).toEqual(['A', 'B']);
    expect(uniqueSources(docs)).toEqual(['a.md', 'b.md', 'c.md']);
  });
});
