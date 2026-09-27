import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CaseOutcome, EvalReport } from './eval.types';

/**
 * 基线快照与回归对比(issue #58 PR3)。
 * 基线 = 某次完整评估的 EvalReport 快照,存放于 server/src/eval/baseline/;
 * 之后每轮实跑与基线逐题 diff:PASS→FAIL 为回归,FAIL→PASS 为修复。
 */

/** 基线存放于源码树(非 dist),便于 --update-baseline 产物直接 git 提交;ts-jest 与编译后路径均锚定到 src/eval。 */
export const BASELINE_DIR = join(__dirname, '..', '..', 'src', 'eval', 'baseline');

/** 组装一轮报告。 */
export function buildReport(
  outcomes: CaseOutcome[],
  meta: { url: string; provider?: string; datasetVersion: number },
): EvalReport {
  const byCategory: EvalReport['byCategory'] = {};
  for (const o of outcomes) {
    const c = (byCategory[o.category] ??= { total: 0, pass: 0 });
    c.total++;
    if (o.pass) c.pass++;
  }
  return {
    generatedAt: new Date().toISOString(),
    url: meta.url,
    provider: meta.provider,
    datasetVersion: meta.datasetVersion,
    total: outcomes.length,
    pass: outcomes.filter((o) => o.pass).length,
    byCategory,
    outcomes,
  };
}

export function writeReport(file: string, report: EvalReport): void {
  writeFileSync(file, JSON.stringify(report, null, 2));
}

export function readReport(file: string): EvalReport {
  return JSON.parse(readFileSync(file, 'utf8')) as EvalReport;
}

/** 默认基线路径;不存在(尚未生成)时返回 undefined。多个文件时取字典序最新。 */
export function findBaseline(): string | undefined {
  if (!existsSync(BASELINE_DIR)) return undefined;
  const files = readdirSync(BASELINE_DIR).filter((f) => f.endsWith('.json')).sort();
  return files.length > 0 ? join(BASELINE_DIR, files[files.length - 1]) : undefined;
}

export interface BaselineDiff {
  regressions: { id: string; reasons: string[] }[];
  fixes: string[];
  added: string[];
  removed: string[];
  passDelta: number;
}

/** 与基线逐题对比;数据集版本不一致时抛错提醒重新出基线。 */
export function compareToBaseline(report: EvalReport, baseline: EvalReport): BaselineDiff {
  if (report.datasetVersion !== baseline.datasetVersion) {
    throw new Error(`数据集版本不一致:基线 v${baseline.datasetVersion} vs 本轮 v${report.datasetVersion},请先更新基线`);
  }
  const before = new Map(baseline.outcomes.map((o) => [o.id, o]));
  const now = new Map(report.outcomes.map((o) => [o.id, o]));
  const diff: BaselineDiff = { regressions: [], fixes: [], added: [], removed: [], passDelta: report.pass - baseline.pass };
  for (const [id, o] of now) {
    const b = before.get(id);
    if (!b) {
      diff.added.push(id);
      continue;
    }
    if (b.pass && !o.pass) diff.regressions.push({ id, reasons: o.reasons });
    if (!b.pass && o.pass) diff.fixes.push(id);
  }
  for (const id of before.keys()) if (!now.has(id)) diff.removed.push(id);
  return diff;
}

/** 人读对比摘要(一行结论 + 回归明细)。 */
export function formatDiff(report: EvalReport, diff: BaselineDiff): string {
  const lines = [
    `本轮 ${report.pass}/${report.total} PASS(基线差 ${diff.passDelta >= 0 ? '+' : ''}${diff.passDelta})`,
    `回归 ${diff.regressions.length},修复 ${diff.fixes.length},新增题 ${diff.added.length},删除题 ${diff.removed.length}`,
  ];
  for (const r of diff.regressions) lines.push(`REGRESSION ${r.id}: ${r.reasons.join('; ')}`);
  return lines.join('\n');
}
