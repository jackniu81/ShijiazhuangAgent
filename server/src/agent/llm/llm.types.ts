/** LLM Provider 抽象。业务层只依赖此接口,不感知具体厂商。 */

export type Role = 'system' | 'user' | 'assistant';

export interface Msg {
  role: Role;
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 预留:接入方用于中断流式生成 */
  signal?: AbortSignal;
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
