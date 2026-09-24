import { join } from 'path';

/** 供 NestJS 依赖注入使用的类型化配置 token。 */
export const APP_CONFIG = Symbol('APP_CONFIG');

export type LlmProviderName = 'mock' | 'siliconflow' | 'ollama';

/** 集中式、带默认值与类型转换的应用配置。 */
export interface AppConfig {
  llm: {
    provider: LlmProviderName;
    timeoutMs: number;
    siliconflow: {
      apiKey: string;
      baseUrl: string;
      chatModel: string;
      embedModel: string;
    };
    ollama: {
      baseUrl: string;
      chatModel: string;
      embedModel: string;
    };
  };
  rag: {
    dataDir: string;
    topK: number;
    chunkSize: number;
    chunkOverlap: number;
  };
  chat: {
    historyTurns: number;
  };
}

const int = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const provider = (v: string | undefined): LlmProviderName =>
  v === 'siliconflow' || v === 'ollama' ? v : 'mock';

export function buildAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    llm: {
      provider: provider(env.LLM_PROVIDER),
      timeoutMs: int(env.LLM_TIMEOUT_MS, 60000),
      siliconflow: {
        apiKey: env.SILICONFLOW_API_KEY ?? '',
        baseUrl: env.SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1',
        chatModel: env.SILICONFLOW_CHAT_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct',
        embedModel: env.SILICONFLOW_EMBED_MODEL ?? 'BAAI/bge-m3',
      },
      ollama: {
        baseUrl: env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
        chatModel: env.OLLAMA_CHAT_MODEL ?? 'qwen2.5:7b',
        embedModel: env.OLLAMA_EMBED_MODEL ?? 'bge-m3',
      },
    },
    rag: {
      // dev/start 的工作目录均为 server/,故默认指向仓库根的 data/
      dataDir: env.DATA_DIR ?? join(process.cwd(), '..', 'data'),
      topK: int(env.RAG_TOPK, 5),
      chunkSize: int(env.RAG_CHUNK_SIZE, 500),
      chunkOverlap: int(env.RAG_CHUNK_OVERLAP, 50),
    },
    chat: {
      historyTurns: int(env.CHAT_HISTORY_TURNS, 6),
    },
  };
}

/** @nestjs/config 的 load 入口。 */
export default () => buildAppConfig();
