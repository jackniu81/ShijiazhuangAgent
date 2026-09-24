import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { LLM_PROVIDER } from '../llm/llm.factory';
import { LLMProvider } from '../llm/llm.types';
import { buildIndexFromDir } from './indexer';
import { RetrievedDoc } from './rag.types';
import { InMemoryVectorStore } from './store';

/** 内存 RAG 服务:启动时建索引,提供向量检索。 */
@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);
  private store: InMemoryVectorStore = new InMemoryVectorStore();

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reindex();
  }

  /** 重建索引(启动时或知识库变更后调用)。 */
  async reindex(): Promise<void> {
    const { dataDir, chunkSize, chunkOverlap } = this.config.rag;
    const embedder = (texts: string[]) => this.llm.embed(texts);
    this.store = await buildIndexFromDir(dataDir, embedder, { chunkSize, chunkOverlap });
    this.logger.log(`RAG 索引就绪:${this.store.size} 个切块(来自 ${dataDir})`);
  }

  async retrieve(query: string, k = this.config.rag.topK): Promise<RetrievedDoc[]> {
    if (this.store.size === 0) return [];
    const embedder = (texts: string[]) => this.llm.embed(texts);
    return this.store.searchByText(query, embedder, k);
  }
}
