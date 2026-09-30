import { RetrievedDoc } from '../rag/rag.types';
import { fitDocsToBudget, truncateAtBoundary, uniqueSources, uniqueTitles } from './util';
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

  it('兴趣/偏好/资料按格式渲染,单条 120 字截断带边界收尾(issue #91)', () => {
    const long = '山'.repeat(200);
    const msgs = buildPlanMessages(
      { days: 3, travelers: 2, budget: 'low', interests: ['山水', '红色'], preferences: '慢行' },
      [doc('苍岩山', 'attractions/苍岩山.md', long)],
    );
    const user = msgs[1].content;
    expect(user).toContain('兴趣=山水/红色');
    // 无标点长串:退化硬截并加省略号标记,不冒充完整句
    expect(user).toContain('- 苍岩山:' + '山'.repeat(120) + '…');
    expect(user).not.toContain('山'.repeat(121));
  });

  it('单条资料有句边界时按句收尾,不落在半句(issue #91)', () => {
    const sentence = '苍岩山桥楼殿横跨两崖之间,是央视取景地。'; // 20 字
    const text = sentence.repeat(7); // 140 字 > 120
    const msgs = buildPlanMessages({ days: 1 }, [doc('苍岩山', 'attractions/苍岩山.md', text)]);
    const line = msgs[1].content.split('\n').find((l) => l.startsWith('- 苍岩山:'))!;
    const body = line.slice('- 苍岩山:'.length);
    // 140 字截到 120:恰落在句末,省略号标记"后文有省略",正文不半句
    expect(body.endsWith('。…')).toBe(true);
    expect(body.length).toBeLessThanOrEqual(121);
    expect(text.startsWith(body.slice(0, -1))).toBe(true);
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

  it('truncateAtBoundary:不超长时原样返回,空预算返回空串', () => {
    expect(truncateAtBoundary('完整一句。', 100)).toBe('完整一句。');
    expect(truncateAtBoundary('任意', 0)).toBe('');
  });

  it('truncateAtBoundary:优先句末标点,其次逗号级弱边界(issue #91)', () => {
    // 5+5+5 三句,句末分别在 5/10/15
    const text = 'AAAAA。BBBBB。CCCCC。';
    // max=12 → 阈值 ≥8,取最近句末 10,残句以省略号标记
    expect(truncateAtBoundary(text, 12)).toBe('AAAAA。BBBBB。…');
    // 句末边界优先于逗号级弱边界
    expect(truncateAtBoundary('AAA,BBB。CCC,DDD。E', 13)).toBe('AAA,BBB。…');
    expect(truncateAtBoundary('甲乙丙,丁戊己庚辛壬癸子丑', 8)).toBe('甲乙丙,丁戊己庚…');
  });

  it('truncateAtBoundary:无标点退化为字符截断加省略号,绝不落在半词(issue #91)', () => {
    const out = truncateAtBoundary('山'.repeat(300), 120);
    expect(out).toBe('山'.repeat(120) + '…');
    // 对任意含标点文本,截断输出必以省略号或标点收尾
    const mixed = '正定古城,隆兴寺. 荣国府! 宁国府? 苍岩山; 嶂石岩';
    for (let max = 4; max < mixed.length; max++) {
      const t = truncateAtBoundary(mixed, max);
      expect(/[，,。;；!！?？…]$/.test(t)).toBe(true);
    }
  });

  it('fitDocsToBudget:预算内的块原样装入,末条越界按边界截,余量过小整条舍弃', () => {
    const short1 = 'AAAAA。BBBBB'; // 11
    const short2 = 'CCCCCC'; // 6
    expect(fitDocsToBudget([short1, short2], 30)).toBe(`${short1}\n\n${short2}`);
    // 末条越界:11+2=13 已用,余 17 → 句末在 31 超出预算,退化为硬截 + 省略号
    const long = 'D'.repeat(30) + '。' + 'E'.repeat(30);
    expect(fitDocsToBudget([short1, long], 30, 10)).toBe(`${short1}\n\n${'D'.repeat(17)}…`);
    // 余量 17 < minKeep 20 → 末条整条舍弃
    expect(fitDocsToBudget([short1, long], 30, 20)).toBe(short1);
  });
});
