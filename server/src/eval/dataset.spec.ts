import { existsSync } from 'fs';
import { join } from 'path';
import { datasetStats, loadDataset, validateDataset, ChatCase } from './eval.types';

/** data/ 目录:spec 运行时 __dirname=server/src/eval;兜底 cwd=server。 */
function dataDir(): string {
  for (const p of [join(__dirname, '..', '..', '..', 'data'), join(process.cwd(), '..', 'data')]) {
    if (existsSync(p)) return p;
  }
  return '';
}

describe('金标评估集 dataset/questions.json (issue #58)', () => {
  const ds = loadDataset();

  it('通过 schema 校验,零错误', () => {
    expect(validateDataset(ds)).toEqual([]);
  });

  it('题量在 30-50 之间,含 chat 与 plan 两类', () => {
    const stats = datasetStats(ds);
    expect(stats.total).toBeGreaterThanOrEqual(30);
    expect(stats.total).toBeLessThanOrEqual(50);
    expect(stats['kind:chat']).toBeGreaterThanOrEqual(25);
    expect(stats['kind:plan']).toBeGreaterThanOrEqual(3);
  });

  it('八个类目全覆盖且各 >=3 题', () => {
    const stats = datasetStats(ds);
    for (const category of ['ticket', 'hours', 'transport', 'food', 'sight', 'specialty', 'advice', 'robustness']) {
      expect(stats[`category:${category}`]).toBeGreaterThanOrEqual(3);
    }
  });

  it('sources_any 引用的语料文件必须真实存在(题-料联动)', () => {
    const dir = dataDir();
    expect(dir).not.toBe('');
    const missing: string[] = [];
    for (const c of ds.cases) {
      for (const src of (c as ChatCase).expect?.sources_any ?? []) {
        if (!existsSync(join(dir, src))) missing.push(`${c.id} -> ${src}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('id 全局唯一且形如前缀+序号', () => {
    const ids = ds.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^(?:PL|T|H|R|F|S|P|A|B)\d+$/);
  });

  it('每题 note 出处非空(便于人工核对)', () => {
    const missing = ds.cases.filter((c) => !c.note).map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it('事实题(ticket/hours/transport)关键词包含具体数字或专有名词', () => {
    const factCases = ds.cases.filter((c) => ['ticket', 'hours', 'transport'].includes(c.category)) as ChatCase[];
    const noAssertion = factCases
      .filter((c) => (c.expect.keywords_all?.length ?? 0) + (c.expect.keywords_any?.length ?? 0) === 0)
      .map((c) => c.id);
    expect(noAssertion).toEqual([]);
  });
});

describe('validateDataset 拒绝坏数据', () => {
  it('id 重复/无断言/plan days 不一致均报错', () => {
    const bad = {
      version: 1,
      corpus: 'x',
      cases: [
        { id: 'A1', kind: 'chat', category: 'food', question: 'q', expect: {} },
        { id: 'A1', kind: 'chat', category: 'food', question: 'q', expect: { keywords_any: ['a'] } },
        {
          id: 'B1', kind: 'plan', category: 'advice',
          input: { days: 2 }, expect: { days: 3, keywords_any: ['x'] },
        },
      ],
    };
    const errors = validateDataset(bad as never);
    expect(errors.some((e) => e.includes('id 重复'))).toBe(true);
    expect(errors.some((e) => e.includes('至少需要一个'))).toBe(true);
    expect(errors.some((e) => e.includes('应与 input.days'))).toBe(true);
  });

  it('robustness 类目允许仅 forbid 断言', () => {
    const ok = {
      version: 1,
      corpus: 'x',
      cases: [{ id: 'B1', kind: 'chat', category: 'robustness', question: 'q', expect: { forbid: ['编造'] } }],
    };
    expect(validateDataset(ok as never)).toEqual([]);
  });
});
