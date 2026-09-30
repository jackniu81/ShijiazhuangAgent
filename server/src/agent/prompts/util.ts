import { RetrievedDoc } from '../rag/rag.types';

/** prompt 模板共享小工具。 */

/** 按出现顺序去重的资料标题。 */
export function uniqueTitles(docs: RetrievedDoc[]): string[] {
  return [...new Set(docs.map((d) => d.meta.title).filter(Boolean))];
}

/** 按出现顺序去重的资料路径(用于 sources 回填)。 */
export function uniqueSources(docs: RetrievedDoc[]): string[] {
  return [...new Set(docs.map((d) => d.source).filter(Boolean))];
}

/** 边界截断的省略号标记(issue #91)。 */
export const TRUNCATE_MARK = '…';

/**
 * 按边界截断(issue #91):优先在最近的句末标点处收尾,
 * 边界须落在 [0.6, max] 区间才采用(过早收尾会浪费预算);
 * 找不到则退化为逗号/顿号级弱边界,再不行硬截断并以省略号标记残句。
 * 输出要么以完整小句结束、要么以省略号结束,不会停在半词。
 */
export function truncateAtBoundary(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const cut = (i: number) => (i === text.length ? text : `${text.slice(0, i)}${TRUNCATE_MARK}`);
  const collect = (re: RegExp) =>
    [...text.slice(0, max).matchAll(re)].map((m) => m.index + 1).filter((i) => i >= Math.ceil(max * 0.6));
  const strong = collect(/[。！？!?；;]/g);
  if (strong.length) return cut(strong[strong.length - 1]);
  const weak = collect(/[,，、;:：]/g);
  return weak.length ? cut(weak[weak.length - 1]) : cut(max);
}

/**
 * 预算内逐条装入资料(issue #91):单条超预算时按句子边界截;
 * 剩余预算不足 minKeep 则整条舍弃,避免最后一条被腰斩成无意义的碎片。
 */
export function fitDocsToBudget(blocks: string[], budget: number, minKeep = 40): string {
  const parts: string[] = [];
  let used = 0;
  for (const b of blocks) {
    if (used >= budget) break;
    const remain = budget - used;
    if (b.length <= remain) {
      parts.push(b);
      used += b.length + 2; // 块间 '\n\n'
      continue;
    }
    if (remain < minKeep) break;
    parts.push(truncateAtBoundary(b, remain));
    used = budget;
    break;
  }
  return parts.join('\n\n');
}
