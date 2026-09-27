/** RAG 相关类型。与 LLMProvider 解耦:embedding 通过 Embedder 函数注入。 */

/** 文档级元数据(来自 md front-matter)。 */
export interface DocMeta {
  title: string;
  tags: string[];
  region?: string;
  /** 相对 data/ 的路径,如 "attractions/正定古城.md",用于 sources 回填 */
  source: string;
}

/** 切块后的最小检索单元。 */
export interface Chunk {
  text: string;
  source: string;
  meta: DocMeta;
}

/** 检索命中结果。 */
export interface RetrievedDoc {
  text: string;
  source: string;
  score: number;
  meta: DocMeta;
}

/** 文本批量向量化函数,由 LLMProvider.embed 提供。 */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/**
 * 向量存储抽象接口(issue #29 一阶段)。
 * 内存实现(InMemoryVectorStore)与持久化实现(PgVectorStore)均遵循此契约,
 * RagService 仅依赖该接口,便于通过配置开关对比两种后端而不改动调用方签名。
 */
export interface VectorStore {
  /** 已索引切块数(观测/降级判断用)。 */
  readonly size: number;
  /** 写入一个切块及其向量。 */
  add(chunk: Chunk, vector: number[]): void;
  /** 用自然语言文本检索:向量 +(可选)关键词混合,签名与纯向量版保持一致。 */
  searchByText(query: string, embedder: Embedder, k?: number): Promise<RetrievedDoc[]>;
}
