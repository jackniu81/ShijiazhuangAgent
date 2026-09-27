import { Bm25Index } from './bm25';
import { collectChunksFromDir, IndexOptions } from './indexer';
import { metaBoostScore, rrfFuse } from './fusion';
import { Chunk, DocMeta, Embedder, RetrievedDoc, VectorStore } from './rag.types';

/** pg 查询结果的窄化结构(方便注入 fake 做离线单测)。 */
export interface PgQueryResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[];
}

/**
 * pg 客户端的结构化最小契约:只需 async query(sql, params)。
 * 生产用 pg.Pool(经工厂包一层),测试注入内存 fake —— 与 eval runner 的
 * EvalSocket 结构化注入同思路,让持久化逻辑无需真实数据库即可单测。
 */
export interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
}

export interface PgVectorOptions {
  /** 向量维度,须与 embedder 输出一致(bge-m3=1024,mock=256)。 */
  dimensions: number;
  /** 是否启用 BM25 + 向量混合检索(RRF 融合)。BM25 常驻内存,向量一路走 SQL。 */
  hybrid?: boolean;
  /** 表名,默认 rag_chunks(仅允许合法标识符)。 */
  table?: string;
}

interface StoredChunk {
  id: number;
  source: string;
  chunkIndex: number;
  text: string;
  meta: DocMeta;
}

const DEFAULT_TABLE = 'rag_chunks';

/** 表名防注入:仅允许小写字母/下划线开头的标识符,否则回退默认。 */
function safeTable(table?: string): string {
  return table && /^[a-z_][a-z0-9_]*$/i.test(table) ? table : DEFAULT_TABLE;
}

/** 向量 → pgvector 文本字面量 [v1,v2,...]。 */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * pgvector 持久化后端(issue #29 二阶段)。
 * - 语料切片、元数据与向量落库(Postgres + pgvector),重启不失效;
 * - 向量一路相似度由 SQL `embedding <=> $1`(余弦距离)承担,BM25 关键词路常驻内存,
 *   两路仍用现有 RRF 融合 + tag/region rerank,与内存后端行为对齐;
 * - 消费侧实现 VectorStore(size/searchByText);入库由 syncFromDir 批量 upsert 完成。
 */
export class PgVectorStore implements VectorStore {
  private readonly db: PgQueryable;
  private readonly dimensions: number;
  private readonly hybrid: boolean;
  private readonly table: string;

  /** 从库加载到内存的语料:数组下标即 bm25 doc id,posById 映射库内 id → 下标。 */
  private chunks: StoredChunk[] = [];
  private bm25 = new Bm25Index();
  private posById = new Map<number, number>();

  constructor(db: PgQueryable, options: PgVectorOptions) {
    this.db = db;
    this.dimensions = options.dimensions;
    this.hybrid = options.hybrid ?? true;
    this.table = safeTable(options.table);
  }

  get size(): number {
    return this.chunks.length;
  }

  /** 建扩展 + 表 + ANN 索引(幂等)。 */
  async ensureSchema(): Promise<void> {
    const t = this.table;
    await this.db.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS ${t} (
         id BIGSERIAL PRIMARY KEY,
         source TEXT NOT NULL,
         chunk_index INT NOT NULL,
         text TEXT NOT NULL,
         meta JSONB NOT NULL,
         embedding vector(${this.dimensions}) NOT NULL,
         UNIQUE (source, chunk_index)
       )`,
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${t}_embedding_idx ON ${t} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );
  }

  /**
   * 从目录重建/增量更新索引:
   * ensureSchema → 收集切块 + 批量向量化 → 按当前文件集清空并 upsert(处理文件内切块收缩)
   * → 删除磁盘已移除文件残留 → 重新加载内存语料。异常向上抛出由 RagService 降级。
   */
  async syncFromDir(
    dataDir: string,
    embedder: Embedder,
    indexOptions: IndexOptions = {},
  ): Promise<void> {
    await this.ensureSchema();
    const pieces = collectChunksFromDir(dataDir, indexOptions);
    const sources = [...new Set(pieces.map((p) => p.source))];

    if (sources.length) {
      // 先删当前文件集旧行(含收缩后多余的 chunk_index),再全新写入
      await this.db.query(`DELETE FROM ${this.table} WHERE source = ANY($1::text[])`, [sources]);
    }
    // 删除磁盘已移除文件的残留
    await this.db.query(
      `DELETE FROM ${this.table} WHERE NOT (source = ANY($1::text[]))`,
      [sources],
    );

    if (pieces.length) {
      const vectors = await embedder(pieces.map((p) => p.text));
      // 按 source 分组顺序分配 chunk_index(与 collectChunksFromDir 的稳定文件序一致)
      const seqBySource = new Map<string, number>();
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        const idx = seqBySource.get(p.source) ?? 0;
        seqBySource.set(p.source, idx + 1);
        await this.upsert(p, idx, vectors[i] ?? []);
      }
    }

    await this.load();
  }

  /** 单条幂等写入(ON CONFLICT 更新);chunkIndex 由调用方给定,支撑重建与增量。 */
  async upsert(chunk: Chunk, chunkIndex: number, vector: number[]): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.table} (source, chunk_index, text, meta, embedding)
       VALUES ($1, $2, $3, $4::jsonb, $5::vector)
       ON CONFLICT (source, chunk_index) DO UPDATE
         SET text = EXCLUDED.text, meta = EXCLUDED.meta, embedding = EXCLUDED.embedding`,
      [chunk.source, chunkIndex, chunk.text, JSON.stringify(chunk.meta), toVectorLiteral(vector)],
    );
  }

  /** 从库全量加载语料到内存,重建 bm25 与 id→pos 映射。 */
  async load(): Promise<void> {
    const { rows } = await this.db.query(
      `SELECT id, source, chunk_index, text, meta FROM ${this.table} ORDER BY id`,
    );
    this.chunks = [];
    this.bm25 = new Bm25Index();
    this.posById = new Map();
    rows.forEach((r, pos) => {
      const id = Number(r.id);
      this.chunks.push({
        id,
        source: String(r.source),
        chunkIndex: Number(r.chunk_index),
        text: String(r.text),
        meta: r.meta as DocMeta,
      });
      this.bm25.add(String(r.text));
      this.posById.set(id, pos);
    });
  }

  async searchByText(query: string, embedder: Embedder, k = 5): Promise<RetrievedDoc[]> {
    if (!this.chunks.length) return [];
    const [qvec] = await embedder([query]);
    const vecStr = toVectorLiteral(qvec);
    const limit = Math.max(0, k);

    if (!this.hybrid) {
      const { rows } = await this.db.query(
        `SELECT source, text, meta, 1 - (embedding <=> $1::vector) AS score
           FROM ${this.table} ORDER BY embedding <=> $1::vector LIMIT $2`,
        [vecStr, limit],
      );
      return rows.map((r) => ({
        text: String(r.text),
        source: String(r.source),
        meta: r.meta as DocMeta,
        score: Number(r.score),
      }));
    }

    // 混合:向量一路从 SQL 取候选 id,关键词一路从内存 bm25 取候选下标,RRF 融合再 rerank
    const pool = Math.min(this.chunks.length, Math.max(limit * 3, 10));
    const { rows } = await this.db.query(
      `SELECT id FROM ${this.table} ORDER BY embedding <=> $1::vector LIMIT $2`,
      [vecStr, pool],
    );
    const vectorIds = rows
      .map((r) => this.posById.get(Number(r.id)))
      .filter((p): p is number => p !== undefined);
    const keywordIds = this.bm25.search(query, pool).map((hit) => hit.id);

    const fused = rrfFuse([vectorIds, keywordIds]);
    const results: RetrievedDoc[] = [];
    for (const [pos, score] of fused) {
      const c = this.chunks[pos];
      if (!c) continue;
      results.push({
        text: c.text,
        source: c.source,
        meta: c.meta,
        score: score + metaBoostScore(query, c.meta),
      });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
