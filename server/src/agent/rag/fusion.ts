import { DocMeta } from './rag.types';

/**
 * 混合检索融合与规则 rerank(issue #9)。
 * 融合用 RRF(Reciprocal Rank Fusion):不依赖两路得分的尺度,只看名次,
 * 简单稳定;再叠加 tag/region 命中加权的轻量 rerank。
 */

/** RRF 平滑常数,业界惯用 60。 */
export const RRF_K = 60;

/**
 * 多路名次列表融合:rankLists[i][d] = 文档 d 在第 i 路结果中的名次(0 起)。
 * 返回 docId -> 融合分 = Σ 1 / (RRF_K + rank + 1)。
 */
export function rrfFuse(rankLists: number[][]): Map<number, number> {
  const fused = new Map<number, number>();
  for (const ranks of rankLists) {
    ranks.forEach((docId, rank) => {
      fused.set(docId, (fused.get(docId) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return fused;
}

/**
 * 规则 rerank 加分:query 中每命中一个 tag 加 TAG_BONUS,命中 region 加 REGION_BONUS。
 * 用于"带老人/爬山/正定"这类含明确标签意图的查询置顶语料。
 */
export function metaBoostScore(query: string, meta: DocMeta): number {
  const TAG_BONUS = 0.015;
  const REGION_BONUS = 0.01;
  let boost = 0;
  for (const tag of meta.tags ?? []) {
    if (tag && query.includes(tag)) boost += TAG_BONUS;
  }
  if (meta.region && query.includes(meta.region)) boost += REGION_BONUS;
  return boost;
}
