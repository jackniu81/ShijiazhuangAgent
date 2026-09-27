import { Bm25Index } from './bm25';
import { metaBoostScore, rrfFuse } from './fusion';
import { cosineSimilarity } from './math';
import { Chunk, Embedder, RetrievedDoc, WritableVectorStore } from './rag.types';

interface IndexedChunk extends Chunk {
  vector: number[];
}

export interface VectorStoreOptions {
  /** 是否启用 BM25 + 向量混合检索(RRF 融合),默认 true(issue #9) */
  hybrid?: boolean;
}

/**
 * 内存索引:向量(纯 TS 余弦相似度)+ BM25 关键词,双路 RRF 融合 + tag/region 规则 rerank。
 * 持久化后端见 PgVectorStore(issue #29),两者均满足 VectorStore 消费侧契约,可按配置切换。
 */
export class InMemoryVectorStore implements WritableVectorStore {
  private readonly items: IndexedChunk[] = [];
  private readonly bm25 = new Bm25Index();
  private readonly hybrid: boolean;

  constructor(options: VectorStoreOptions = {}) {
    this.hybrid = options.hybrid ?? true;
  }

  add(chunk: Chunk, vector: number[]): void {
    this.items.push({ ...chunk, vector });
    this.bm25.add(chunk.text);
  }

  get size(): number {
    return this.items.length;
  }

  /** 用文本检索:向量 + (可选)BM25 混合。签名与纯向量版保持一致。 */
  async searchByText(query: string, embedder: Embedder, k = 5): Promise<RetrievedDoc[]> {
    if (!this.items.length) return [];
    const [queryVec] = await embedder([query]);
    if (!this.hybrid) return this.searchByVector(queryVec, k);

    // 混合:两路各取候选,RRF 按名次融合,再叠加 tag/region 加权
    const pool = Math.min(this.items.length, Math.max(k * 3, 10));
    const vectorIds = this.rankByVector(queryVec, pool);
    const keywordIds = this.bm25.search(query, pool).map((hit) => hit.id);

    const fused = rrfFuse([vectorIds, keywordIds]);
    const results: RetrievedDoc[] = [];
    for (const [id, score] of fused) {
      const it = this.items[id];
      if (!it) continue;
      results.push({
        text: it.text,
        source: it.source,
        meta: it.meta,
        score: score + metaBoostScore(query, it.meta),
      });
    }
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k));
  }

  searchByVector(queryVec: number[], k = 5): RetrievedDoc[] {
    return this.rankByVector(queryVec, k).map((id) => ({
      text: this.items[id].text,
      source: this.items[id].source,
      meta: this.items[id].meta,
      score: cosineSimilarity(queryVec, this.items[id].vector),
    }));
  }

  /** 向量一路的候选 id(按余弦降序)。 */
  private rankByVector(queryVec: number[], pool: number): number[] {
    return this.items
      .map((it, id) => ({ id, score: cosineSimilarity(queryVec, it.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, pool))
      .map((x) => x.id);
  }
}
