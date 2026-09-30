import { ChatOptions, LLMProvider, Msg } from './llm.types';
import { LLMError, postJson, readLines, toProviderMessages, withRetry } from './http';

export interface OllamaOptions {
  baseUrl: string;
  chatModel: string;
  embedModel: string;
  timeoutMs: number;
}

/**
 * Ollama —— 本地 HTTP API(默认 http://localhost:11434),免网免密。
 * chat/stream 走 /api/chat(NDJSON),embed 走 /api/embeddings(逐条)。
 */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';

  constructor(private readonly opts: OllamaOptions) {}

  async chat(messages: Msg[], options?: ChatOptions): Promise<string> {
    return withRetry(async () => {
      const json = await postJson(
        `${this.opts.baseUrl}/api/chat`,
        {
          model: this.opts.chatModel,
          messages: toProviderMessages(messages),
          stream: false,
          ...this.chatOpts(options),
        },
        {},
        { timeoutMs: this.opts.timeoutMs, signal: options?.signal },
      );
      return (json?.message?.content as string) ?? '';
    });
  }

  async stream(
    messages: Msg[],
    onToken: (token: string) => void,
    options?: ChatOptions,
  ): Promise<string> {
    let emitted = false;
    return withRetry(async () => {
      let full = '';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
      const onAbort = () => ctrl.abort();
      if (options?.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        const res = await fetch(`${this.opts.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.opts.chatModel,
            messages: toProviderMessages(messages),
            stream: true,
            ...this.chatOpts(options),
          }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const retryable = res.status >= 500;
          throw new LLMError(`Ollama 服务返回错误(${res.status}),请确认 ollama serve 已启动。`, retryable);
        }
        // NDJSON:每行一个 JSON chunk,{message:{content},done}
        await readLines(res, (line) => {
          let chunk: any;
          try {
            chunk = JSON.parse(line);
          } catch {
            return;
          }
          const token = chunk?.message?.content as string | undefined;
          if (token) {
            emitted = true;
            full += token;
            onToken(token);
          }
          if (chunk?.done) return false;
        });
        return full;
      } catch (err) {
        if (emitted) throw err;
        if (err instanceof LLMError) throw err;
        throw new LLMError('无法连接 Ollama,请确认本机已运行 `ollama serve`。');
      } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
      }
    });
  }

  /** 生成参数透传(issue #86):Ollama 走请求体 options 字段,maxTokens 映射 num_predict。 */
  private chatOpts(options?: ChatOptions): { options?: Record<string, number> } {
    const o: Record<string, number> = {};
    if (options?.temperature !== undefined) o.temperature = options.temperature;
    if (options?.maxTokens !== undefined) o.num_predict = options.maxTokens;
    return Object.keys(o).length ? { options: o } : {};
  }

  async embed(texts: string[]): Promise<number[][]> {
    // /api/embeddings 一次一条,语料规模小(启动建索引)时可接受
    const out: number[][] = [];
    for (const text of texts) {
      const vec = await withRetry(async () => {
        const json = await postJson(
          `${this.opts.baseUrl}/api/embeddings`,
          { model: this.opts.embedModel, prompt: text },
          {},
          { timeoutMs: this.opts.timeoutMs },
        );
        if (!Array.isArray(json?.embedding)) throw new LLMError('Ollama embedding 返回结构异常。', false);
        return json.embedding as number[];
      });
      out.push(vec);
    }
    return out;
  }
}
