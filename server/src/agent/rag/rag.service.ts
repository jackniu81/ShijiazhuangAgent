import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { LLM_PROVIDER } from '../llm/llm.factory';
import { LLMProvider } from '../llm/llm.types';
import { buildIndexFromDir } from './indexer';
import { RetrievedDoc } from './rag.types';
import { InMemoryVectorStore } from './store';

/** 内存 RAG 服务:启动时建索引,提供向量检索;失败时降级为无检索(issue #8 spec §8)。 */
@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);
  private store: InMemoryVectorStore = new InMemoryVectorStore();
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

  /** 重建索引(启动时或知识库变更后调用);异常不阻断启动,降级为无检索。 */
  async reindex(): Promise<void> {
    const { dataDir, chunkSize, chunkOverlap } = this.config.rag;
    const embedder = (texts: string[]) => this.llm.embed(texts);
    try {
      this.store = await buildIndexFromDir(dataDir, embedder, { chunkSize, chunkOverlap });
      this.degraded = false;
      this.logger.log(`RAG 索引就绪:${this.store.size} 个切块(来自 ${dataDir})`);
    } catch (err) {
      this.store = new InMemoryVectorStore();
      this.degraded = true;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`RAG 索引构建失败,降级为无检索模式:${message}`);
    }
  }

  async retrieve(query: string, k = this.config.rag.topK): Promise<RetrievedDoc[]> {
    if (this.store.size === 0) return [];
    const embedder = (texts: string[]) => this.llm.embed(texts);
    try {
      return await this.store.searchByText(query, embedder, k);
    } catch (err) {
      // 查询期 embedding 失败:降级返回空结果,不阻断回答
      this.degraded = true;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`RAG 检索失败,本次回答不带参考资料:${message}`);
      return [];
    }
  }
}
