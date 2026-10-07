/** LLM Provider 抽象。业务层只依赖此接口,不感知具体厂商。 */

export type Role = 'system' | 'user' | 'assistant';

export interface Msg {
  role: Role;
  content: string;
}

/**
 * token 用量:真实 provider 从响应 usage 字段回填;mock 以字符数估算。
 * 各字段均可缺省(部分厂商流式末帧不返回完整 usage)。
 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 取消/超时信号:真实 provider 用于中断在途 HTTP 流;mock 用于提前停止回放 */
  signal?: AbortSignal;
  /**
   * token 用量回调(观测用):provider 在拿到响应 usage 后回调一次。
   * 仅在传入时才让 API 额外返回 usage(如 OpenAI 兼容流式的 stream_options),
   * 缺省不改变请求体与既有行为。
   */
  onUsage?: (usage: TokenUsage) => void;
  /**
   * JSON 强约束(issue #87):非流式请求体带 response_format/format,
   * 由 API 侧保证输出可解析。流式场景不生效;语义合法性仍靠 #59 的 schema 校验兜底。
   */
  jsonMode?: boolean;
}

export interface LLMProvider {
  /** 厂商标识,如 'mock' | 'siliconflow' | 'ollama' */
  readonly name: string;

  /** 非流式对话,返回完整文本。 */
  chat(messages: Msg[], options?: ChatOptions): Promise<string>;

  /** 流式对话:每个 token 回调一次,resolve 为完整文本。 */
  stream(
    messages: Msg[],
    onToken: (token: string) => void,
    options?: ChatOptions,
  ): Promise<string>;

  /** 批量向量化,用于 RAG。 */
  embed(texts: string[]): Promise<number[][]>;
}
