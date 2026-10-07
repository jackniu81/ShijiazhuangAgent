import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { LLM_PROVIDER } from '../llm/llm.factory';
import { LLMProvider } from '../llm/llm.types';
import { buildIndexFromDir } from './indexer';
import { filterByCosine } from './fusion';
import { PgVectorStore, PgQueryable } from './pg-vector.store';
import { RetrievedDoc, VectorStore } from './rag.types';
import { InMemoryVectorStore } from './store';

/** RAG 服务:启动时按配置构建内存或 pgvector 索引,提供混合检索;失败时降级为无检索(issue #8 spec §8 / #29)。 */
@Injectable()
export class RagService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RagService.name);
  private store: VectorStore = new InMemoryVectorStore();
  /** pgvector 后端连接池(memory 后端为 null),销毁时关闭。 */
  private pool: Pool | null = null;
  /** 索引构建/embedding 不可用时为 true,服务仍可提供 LLM 回答,但无本地资料。 */
  private degraded = false;

  get isDegraded(): boolean {
    return this.degraded;
  }

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reindex();
  }

  onModuleDestroy(): void {
    void this.pool?.end();
    this.pool = null;
  }

  /**
   * 重建索引(启动时或知识库变更后调用);异常不阻断启动,降级为无检索。
   * @param dbOverride 测试注入的 fake pg 客户端(仅 pgvector 后端生效),生产省略。
   */
  async reindex(dbOverride?: PgQueryable): Promise<void> {
    const { dataDir, chunkSize, chunkOverlap, hybrid, backend, databaseUrl, vectorDim, vectorTable } =
      this.config.rag;
    const embedder = (texts: string[]) => this.llm.embed(texts);
    const indexOptions = { chunkSize, chunkOverlap, hybrid };
    try {
      if (backend === 'pgvector') {
        const db = dbOverride ?? this.createPool(databaseUrl);
        const store = new PgVectorStore(db, { dimensions: vectorDim, hybrid, table: vectorTable });
        await store.syncFromDir(dataDir, embedder, indexOptions);
        this.store = store;
      } else {
        this.store = await buildIndexFromDir(dataDir, embedder, indexOptions);
      }
      this.degraded = false;
      this.logger.log(`RAG 索引就绪(${backend}):${this.store.size} 个切块(来自 ${dataDir})`);
    } catch (err) {
      this.store = new InMemoryVectorStore();
      this.degraded = true;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`RAG 索引构建失败(${backend}),降级为无检索模式:${message}`);
    }
  }

  /** 包装 pg.Pool 为结构化 PgQueryable。 */
  private createPool(connectionString: string): PgQueryable {
    const pool = new Pool({ connectionString });
    this.pool = pool;
    return {
      query: async (sql: string, params?: unknown[]) => {
        const res = await pool.query(sql, params as unknown[]);
        return { rows: res.rows };
      },
    };
  }

  async retrieve(query: string, k = this.config.rag.topK): Promise<RetrievedDoc[]> {
    if (this.store.size === 0) return [];
    const embedder = (texts: string[]) => this.llm.embed(texts);
    const { minScore } = this.config.rag;
    try {
      const docs = await this.store.searchByText(query, embedder, k);
      docs.map((d) => this.logger.log(`RAG 检索结果:${d.source}, ${d.score}`));
      if (!(minScore > 0) || !docs.length) return docs;
      // 相关度阈值过滤(issue #89):一次批量向量化,按余弦分剔除低分文档
      const vectors = await embedder([query, ...docs.map((d) => d.text)]);
      const [queryVec, ...docVecs] = vectors;
      return filterByCosine(docs, queryVec, docVecs, minScore);
    } catch (err) {
      // 查询期 embedding 失败:降级返回空结果,不阻断回答
      this.degraded = true;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`RAG 检索失败,本次回答不带参考资料:${message}`);
      return [];
    }
  }
}
