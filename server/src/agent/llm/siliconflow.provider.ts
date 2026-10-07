import { ChatOptions, LLMProvider, Msg, TokenUsage } from './llm.types';
import { LLMError, postJson, readLines, toProviderMessages, withRetry } from './http';

export interface SiliconFlowOptions {
  apiKey: string;
  baseUrl: string;
  chatModel: string;
  embedModel: string;
  timeoutMs: number;
}

/**
 * SiliconFlow —— OpenAI 兼容 HTTP API(api.siliconflow.cn/v1)。
 * chat/stream 走 /chat/completions(SSE),embed 走 /embeddings。
 */
export class SiliconFlowProvider implements LLMProvider {
  readonly name = 'siliconflow';

  constructor(private readonly opts: SiliconFlowOptions) {
    if (!opts.apiKey) {
      throw new Error('LLM_PROVIDER=siliconflow 需要配置 SILICONFLOW_API_KEY,请参考 server/.env.example。');
    }
  }

  async chat(messages: Msg[], options?: ChatOptions): Promise<string> {
    return withRetry(async () => {
      const json = await postJson(
        `${this.opts.baseUrl}/chat/completions`,
        this.chatBody(messages, false, options),
        this.headers(),
        { timeoutMs: this.opts.timeoutMs, signal: options?.signal },
      );
      this.emitUsage(json?.usage, options);
      return (json?.choices?.[0]?.message?.content as string) ?? '';
    });
  }

  async stream(
    messages: Msg[],
    onToken: (token: string) => void,
    options?: ChatOptions,
  ): Promise<string> {
    let emitted = false;
    // 仅在尚未产出任何 token 时重试(避免前端重复内容)
    return withRetry(async () => {
      let full = '';
      const { signal, dispose } = this.composedSignal(options);
      try {
        const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.headers() },
          body: JSON.stringify(this.chatBody(messages, true, options)),
          signal,
        });
        if (!res.ok || !res.body) {
          const retryable = res.status >= 500;
          throw new LLMError(`LLM 服务返回错误(${res.status}),请稍后重试。`, retryable);
        }
        await readLines(res, (line) => {
          if (!line.startsWith('data:')) return;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return false;
          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            return; // 忽略心跳/半行
          }
          const token = chunk?.choices?.[0]?.delta?.content as string | undefined;
          if (token) {
            emitted = true;
            full += token;
            onToken(token);
          }
          // 开启 stream_options.include_usage 后,末帧携带 usage(choices 为空)。
          if (chunk?.usage) this.emitUsage(chunk.usage, options);
        });
        return full;
      } catch (err) {
        if (emitted) throw err; // 已输出过半程,不重试
        if (err instanceof LLMError) throw err;
        throw new LLMError('无法连接 LLM 服务,请检查网络或稍后重试。');
      } finally {
        dispose();
      }
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    return withRetry(async () => {
      const json = await postJson(
        `${this.opts.baseUrl}/embeddings`,
        { model: this.opts.embedModel, input: texts, encoding_format: 'float' },
        this.headers(),
        { timeoutMs: this.opts.timeoutMs },
      );
      const data = json?.data as Array<{ embedding: number[] }> | undefined;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new LLMError('embedding 返回结构异常。', false);
      }
      return data.map((d) => d.embedding);
    });
  }

  // ---------- internals ----------

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.apiKey}` };
  }

  private chatBody(messages: Msg[], stream: boolean, options?: ChatOptions): unknown {
    return {
      model: this.opts.chatModel,
      messages: toProviderMessages(messages),
      stream,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      // JSON 强约束只对非流式生效(issue #87):流式下 response_format 会破坏增量返回
      ...(!stream && options?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      // 仅在需要观测 token 时让末帧额外返回 usage,缺省不改变请求体
      ...(stream && options?.onUsage ? { stream_options: { include_usage: true } } : {}),
    };
  }

  /** 将 OpenAI 兼容的 usage 字段归一后回调(无 onUsage 或未返回 usage 时静默跳过)。 */
  private emitUsage(usage: any, options?: ChatOptions): void {
    if (!options?.onUsage || !usage) return;
    const u: TokenUsage = {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    };
    options.onUsage(u);
  }

  private composedSignal(options?: ChatOptions): { signal: AbortSignal; dispose: () => void } {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    const onAbort = () => ctrl.abort();
    if (options?.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    return {
      signal: ctrl.signal,
      dispose: () => {
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
      },
    };
  }
}
