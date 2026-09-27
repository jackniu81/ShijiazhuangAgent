import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * 金标评估集类型定义与装载(issue #58)。
 * 评估思路:断言"答案要点"(关键词集合/来源命中)而非全文 diff,
 * 兼容 LLM 输出的不确定性,同时可对回归结果量化。
 */

export type EvalCategory =
  | 'ticket'      // 票价/消费类事实
  | 'hours'       // 开放时间/闭馆/季节性
  | 'transport'   // 地铁/公交/距离车程
  | 'food'        // 美食事实
  | 'sight'       // 景点亮点/历史知识
  | 'specialty'   // 特产
  | 'advice'      // 行程建议/约束推理
  | 'robustness'; // 语料外问题,防幻觉

/** chat 类评估条目:一问一答,断言关键词与 RAG 来源。 */
export interface ChatCase {
  id: string;
  kind: 'chat';
  category: EvalCategory;
  question: string;
  expect: {
    /** 答案须全含(AND),每项小写无关 */
    keywords_all?: string[];
    /** 答案至少含其一(OR) */
    keywords_any?: string[];
    /** 答案若含其中任一项即判错(防编造具体数字/张冠李戴) */
    forbid?: string[];
    /** chat:done.sources 期望命中的语料路径(相对 data/,任一命中即算 source 命中) */
    sources_any?: string[];
  };
  /** 出题依据(语料出处),便于人工核对 */
  note?: string;
}

/** plan 类评估条目:一次行程规划,断言结构与内容要点。 */
export interface PlanCase {
  id: string;
  kind: 'plan';
  category: EvalCategory;
  input: {
    days: number;
    travelers?: number;
    budget?: 'economy' | 'comfort' | 'luxury';
    interests?: string[];
    preferences?: string;
  };
  expect: {
    /** plan.days 长度须等于 */
    days: number;
    /** 每天至少多少个安排项 */
    minItemsPerDay?: number;
    /** 全文(标题+各 items 拼接)关键词断言,同 ChatCase */
    keywords_all?: string[];
    keywords_any?: string[];
    forbid?: string[];
  };
  note?: string;
}

export type EvalCase = ChatCase | PlanCase;

/** 单题实跑结果(PR2 runner 产出,PR3 基线/对比消费)。 */
export interface CaseOutcome {
  id: string;
  kind: EvalCase['kind'];
  category: string;
  question: string;
  pass: boolean;
  reasons: string[];
  latencyMs: number;
}

/** 一轮完整评估报告;基线文件即此结构快照(server/src/eval/baseline/*.json)。 */
export interface EvalReport {
  generatedAt: string;
  url: string;
  /** 跑分时生效的 provider,便于区分基线来源 */
  provider?: string;
  datasetVersion: number;
  total: number;
  pass: number;
  byCategory: Record<string, { total: number; pass: number }>;
  outcomes: CaseOutcome[];
}

export interface EvalDataset {
  version: number;
  /** 语料快照说明,提醒维护者题目与 data/ 联动 */
  corpus: string;
  cases: EvalCase[];
}

/** 数据文件相对本模块的候选位置:ts-jest(src 下)与编译后(dist 需回指 src)。 */
function datasetCandidates(): string[] {
  return [
    join(__dirname, 'dataset/questions.json'),
    join(__dirname, '..', '..', 'src', 'eval', 'dataset', 'questions.json'),
    join(__dirname, '..', '..', '..', '..', 'server', 'src', 'eval', 'dataset', 'questions.json'),
  ];
}

export function loadDataset(): EvalDataset {
  for (const p of datasetCandidates()) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as EvalDataset;
  }
  throw new Error(`金标数据集未找到,候选路径:${datasetCandidates().join(' , ')}`);
}

/** 校验数据集完整性,返回错误列表(空数组 = 通过)。 */
export function validateDataset(ds: EvalDataset): string[] {
  const errors: string[] = [];
  if (!ds || typeof ds !== 'object') return ['dataset 不是对象'];
  if (typeof ds.version !== 'number') errors.push('缺少 version');
  if (!Array.isArray(ds.cases) || ds.cases.length === 0) errors.push('cases 为空');

  const seen = new Set<string>();
  for (const c of ds.cases ?? []) {
    const at = `case ${c.id ?? '(无id)'}`;
    if (!c.id) errors.push(`${at} 缺少 id`);
    else if (seen.has(c.id)) errors.push(`${at} id 重复`);
    seen.add(c.id);

    if (!/^[a-z]+$/.test(c.category ?? '')) errors.push(`${at} category 非法:${c.category}`);

    const expect = (c as ChatCase | PlanCase).expect ?? ({} as never);
    const hasAssertion =
      (expect.keywords_all?.length ?? 0) + (expect.keywords_any?.length ?? 0) > 0;
    // robustness 题允许仅用 forbid 断言(防附和错误前提类,无法预设正面关键词)
    const forbidOnly = c.category === 'robustness' && (expect.forbid?.length ?? 0) > 0;
    if (!hasAssertion && !forbidOnly) errors.push(`${at} 至少需要一个 keywords_all/keywords_any 断言(robustness 可仅 forbid)`);
    for (const list of [expect.keywords_all, expect.keywords_any, expect.forbid]) {
      for (const kw of list ?? []) {
        if (typeof kw !== 'string' || kw.trim() === '') errors.push(`${at} 关键词必须为非空字符串`);
      }
    }

    if (c.kind === 'chat') {
      if (!c.question || c.question.trim() === '') errors.push(`${at} question 为空`);
    } else if (c.kind === 'plan') {
      const pe = (c as PlanCase).expect;
      if (!c.input || c.input.days < 1) errors.push(`${at} plan.input.days 须 >=1`);
      if (pe.days !== c.input?.days) errors.push(`${at} expect.days(${pe.days}) 应与 input.days(${c.input?.days}) 一致`);
    } else {
      errors.push(`${at} kind 须为 chat|plan,实际:${(c as { kind: string }).kind}`);
    }
  }
  return errors;
}

/** 数据集统计:各类目/各 kind 的题量,供 spec 与报告使用。 */
export function datasetStats(ds: EvalDataset): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const c of ds.cases ?? []) {
    stats[`category:${c.category}`] = (stats[`category:${c.category}`] ?? 0) + 1;
    stats[`kind:${c.kind}`] = (stats[`kind:${c.kind}`] ?? 0) + 1;
  }
  stats.total = ds.cases?.length ?? 0;
  return stats;
}
