import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CaseOutcome, EvalReport } from './eval.types';
import { buildReport, compareToBaseline, formatDiff, readReport, writeReport } from './eval.baseline';

const outcome = (id: string, pass: boolean, reasons: string[] = []): CaseOutcome => ({
  id,
  kind: 'chat',
  category: pass ? 'ticket' : 'food',
  question: 'q',
  pass,
  reasons,
  latencyMs: 100,
});

const report = (outcomes: CaseOutcome[], datasetVersion = 1): EvalReport =>
  buildReport(outcomes, { url: 'http://x/agent', provider: 'mock', datasetVersion });

describe('金标基线与回归对比(issue #58 PR3)', () => {
  it('buildReport 汇总 pass/total/byCategory 正确', () => {
    const r = report([outcome('T1', true), outcome('F1', false, ['缺关键词']), outcome('T2', true)]);
    expect(r.total).toBe(3);
    expect(r.pass).toBe(2);
    expect(r.byCategory.ticket).toEqual({ total: 2, pass: 2 });
    expect(r.byCategory.food).toEqual({ total: 1, pass: 0 });
    expect(r.provider).toBe('mock');
  });

  it('writeReport/readReport 落盘回读无损', () => {
    const r = report([outcome('T1', true)]);
    const file = join(tmpdir(), `qoder-eval-baseline-${Date.now()}.json`);
    writeReport(file, r);
    const back = readReport(file);
    expect(back.outcomes[0].id).toBe('T1');
    rmSync(file, { force: true });
    expect(existsSync(file)).toBe(false);
  });

  it('compareToBaseline 识别回归/修复/新增/删除', () => {
    const base = report([outcome('A', true), outcome('B', false), outcome('C', true), outcome('D', true)]);
    const now = report([outcome('A', true), outcome('B', true), outcome('C', false, ['超时']), outcome('E', true)]);
    const diff = compareToBaseline(now, base);
    expect(diff.regressions.map((x) => x.id)).toEqual(['C']);
    expect(diff.fixes).toEqual(['B']);
    expect(diff.added).toEqual(['E']);
    expect(diff.removed).toEqual(['D']);
    expect(diff.passDelta).toBe(0);
  });

  it('数据集版本不一致时拒绝对比', () => {
    const base = report([], 1);
    const now = report([], 2);
    expect(() => compareToBaseline(now, base)).toThrow('数据集版本不一致');
  });

  it('formatDiff 输出含回归明细行', () => {
    const base = report([outcome('T01', true)]);
    const now = report([outcome('T01', false, ['缺关键词「40」'])]);
    const text = formatDiff(now, compareToBaseline(now, base));
    expect(text).toContain('回归 1');
    expect(text).toContain('REGRESSION T01: 缺关键词「40」');
  });
});
