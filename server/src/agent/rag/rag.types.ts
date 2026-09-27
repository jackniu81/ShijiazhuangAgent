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
 * RagService 仅依赖该消费侧契约,便于通过配置开关对比内存与 pgvector 两种后端。
 */
export interface VectorStore {
  /** 已索引切块数(观测/降级判断用)。 */
  readonly size: number;
  /** 用自然语言文本检索:向量 +(可选)关键词混合,签名与纯向量版保持一致。 */
  searchByText(query: string, embedder: Embedder, k?: number): Promise<RetrievedDoc[]>;
}

/**
 * 可写侧接口:支持逐条 add 的内存后端专用(供 buildIndexFromDir 冷启动写入)。
 * pgvector 后端不实现此接口——其入库通过批量 upsert(见 PgVectorStore.syncFromDir),
 * 因 add 为同步语义,不适合作为持久化后端的公开契约。
 */
export interface WritableVectorStore extends VectorStore {
  /** 写入一个切块及其向量。 */
  add(chunk: Chunk, vector: number[]): void;
}
