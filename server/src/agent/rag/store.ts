import { cosineSimilarity } from './math';
import { Chunk, Embedder, RetrievedDoc } from './rag.types';

interface IndexedChunk extends Chunk {
  vector: number[];
}

/**
 * 内存向量索引(纯 TS 余弦相似度)。
 * 语料变大或冷启动变慢时,可替换为持久化实现,search 接口不变。
 */
export class InMemoryVectorStore {
  private readonly items: IndexedChunk[] = [];

  add(chunk: Chunk, vector: number[]): void {
    this.items.push({ ...chunk, vector });
  }

  get size(): number {
    return this.items.length;
  }

  /** 用文本检索:先把 query 向量化,再比对。 */
  async searchByText(query: string, embedder: Embedder, k = 5): Promise<RetrievedDoc[]> {
    if (!this.items.length) return [];
    const [queryVec] = await embedder([query]);
    return this.searchByVector(queryVec, k);
  }

  searchByVector(queryVec: number[], k = 5): RetrievedDoc[] {
    return this.items
      .map((it) => ({
        text: it.text,
        source: it.source,
        meta: it.meta,
        score: cosineSimilarity(queryVec, it.vector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k));
  }
}
