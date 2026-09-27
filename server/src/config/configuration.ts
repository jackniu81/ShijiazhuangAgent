import { join } from 'path';

/** 供 NestJS 依赖注入使用的类型化配置 token。 */
export const APP_CONFIG = Symbol('APP_CONFIG');

export type LlmProviderName = 'mock' | 'siliconflow' | 'ollama';

/** RAG 向量存储后端(issue #29):内存 or pgvector 持久化。 */
export type RagBackend = 'memory' | 'pgvector';

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
    /** BM25 + 向量混合检索(RRF 融合),issue #9,默认开 */
    hybrid: boolean;
    /** 向量存储后端:memory(默认) | pgvector(issue #29) */
    backend: RagBackend;
    /** pgvector 连接串(DATABASE_URL),backend=pgvector 时必填 */
    databaseUrl: string;
    /** 向量维度,须与 embedder 输出一致(bge-m3=1024,mock=256) */
    vectorDim: number;
    /** 向量表名,默认 rag_chunks */
    vectorTable: string;
  };
  chat: {
    historyTurns: number;
    /** 闲置超过该毫秒数的会话被回收 */
    sessionTtlMs: number;
    /** question 最大长度,超出报 INVALID_INPUT */
    questionMaxLen: number;
  };
  /** WebSocket 请求限流(issue #62):IP + 会话双维度 */
  rateLimit: {
    /** 同一会话允许同时进行的活跃请求数 */
    maxConcurrentPerSession: number;
    /** 滑动窗口内每个 IP / 每个会话允许的最大请求数 */
    perWindow: number;
    /** 滑动窗口长度(毫秒) */
    windowMs: number;
  };
}

const bool = (v: string | undefined, def: boolean): boolean =>
  v === undefined || v === '' ? def : v !== '0' && v.toLowerCase() !== 'false';

const int = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const provider = (v: string | undefined): LlmProviderName =>
  v === 'siliconflow' || v === 'ollama' ? v : 'mock';

const ragBackend = (v: string | undefined): RagBackend => (v === 'pgvector' ? 'pgvector' : 'memory');

export function buildAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    llm: {
      provider: provider(env.LLM_PROVIDER),
      timeoutMs: int(env.LLM_TIMEOUT_MS, 180000),
      siliconflow: {
        apiKey: env.SILICONFLOW_API_KEY ?? '',
        baseUrl: env.SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn/v1',
        chatModel: env.SILICONFLOW_CHAT_MODEL ?? 'THUDM/GLM-4-9B-0414',
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
      hybrid: bool(env.RAG_HYBRID, true),
      backend: ragBackend(env.RAG_STORE_BACKEND),
      databaseUrl: env.DATABASE_URL ?? '',
      vectorDim: int(env.RAG_VECTOR_DIM, 1024),
      vectorTable: env.RAG_VECTOR_TABLE ?? 'rag_chunks',
    },
    chat: {
      historyTurns: int(env.CHAT_HISTORY_TURNS, 6),
      sessionTtlMs: int(env.CHAT_SESSION_TTL_MS, 30 * 60_000),
      questionMaxLen: int(env.CHAT_QUESTION_MAX, 500),
    },
    rateLimit: {
      maxConcurrentPerSession: int(env.WS_MAX_CONCURRENT_PER_SESSION, 1),
      perWindow: int(env.WS_RATE_LIMIT_PER_WINDOW, 30),
      windowMs: int(env.WS_RATE_LIMIT_WINDOW_MS, 60_000),
    },
  };
}

/** @nestjs/config 的 load 入口。 */
export default () => buildAppConfig();
