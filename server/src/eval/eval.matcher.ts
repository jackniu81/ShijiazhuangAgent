import { ChatCase, EvalCase, PlanCase } from './eval.types';
/**
 * 金标判分器(issue #58 PR2):纯函数,输入"实际回答文本 + 来源列表",
 * 输出失败原因列表(空数组 = PASS)。不含任何 IO,可单测。
 */

/** 归一化:小写 + 去掉全部半角/全角空白,使 "2元"/"2 元"、"10:00"/"10：00" 等价。 */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\u3000]+/g, '');
}

function hit(text: string, norm: string, kw: string): boolean {
  const n = normalize(kw);
  return n !== '' && (text.includes(kw.toLowerCase()) || norm.includes(n));
}

/** chat 判分:keywords_all 全含 / keywords_any 至少一含 / forbid 任一含即错 / sources 任一命中。 */
export function judgeChat(c: ChatCase, answer: string, sources?: string[]): string[] {
  const reasons: string[] = [];
  const norm = normalize(answer);
  for (const kw of c.expect.keywords_all ?? []) {
    if (!hit(answer, norm, kw)) reasons.push(`缺关键词「${kw}」`);
  }
  const anyList = c.expect.keywords_any ?? [];
  if (anyList.length > 0 && !anyList.some((kw) => hit(answer, norm, kw))) {
    reasons.push(`未命中任一关键词「${anyList.join('/')}」`);
  }
  for (const kw of c.expect.forbid ?? []) {
    if (hit(answer, norm, kw)) reasons.push(`命中禁用词「${kw}」(疑似编造/附和错误前提)`);
  }
  const srcList = c.expect.sources_any ?? [];
  if (srcList.length > 0) {
    const actual = (sources ?? []).map((s) => normalize(s.replace(/\\/g, '/')));
    const matched = srcList.some((want) => actual.some((a) => a.includes(normalize(want))));
    if (!matched) reasons.push(`RAG 来源未命中任一「${srcList.join('/')}」(实际:${(sources ?? []).join(', ') || '无'}})`);
  }
  return reasons;
}

/** plan 判分:天数结构 + 全文关键词断言。text 为 transport 层拼合的 plan 全文(JSON 化即可,关键词为子串匹配)。 */
export function judgePlan(c: PlanCase, text: string, dayCount: number, minItemsPerDay?: number[]): string[] {
  const reasons: string[] = [];
  if (dayCount !== c.expect.days) reasons.push(`天数 ${dayCount} != 期望 ${c.expect.days}`);
  if (c.expect.minItemsPerDay) {
    (minItemsPerDay ?? []).forEach((n, i) => {
      if (n < c.expect.minItemsPerDay!) reasons.push(`第 ${i + 1} 天仅 ${n} 个安排项(<${c.expect.minItemsPerDay})`);
    });
  }
  const virtual: ChatCase = { ...c, kind: 'chat', question: '' } as never;
  reasons.push(...judgeChat(virtual, text));
  return reasons;
}

/** 按 case 类型分发判分。answer/sources 仅 chat 用。 */
export function judgeCase(
  c: EvalCase,
  actual: { answer?: string; sources?: string[]; planText?: string; dayCount: number; itemsPerDay?: number[] },
): string[] {
  if (c.kind === 'chat') return judgeChat(c, actual.answer ?? '', actual.sources);
  return judgePlan(c, actual.planText ?? '', actual.dayCount, actual.itemsPerDay);
}
