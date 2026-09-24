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
