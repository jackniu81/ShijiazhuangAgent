import { Logger } from '@nestjs/common';
import { ChatOptions, LLMProvider, Msg } from './llm.types';
import { LLMError, postJson, readLines, toProviderMessages, withRetry } from './http';

export interface OllamaOptions {
  baseUrl: string;
  chatModel: string;
  embedModel: string;
  timeoutMs: number;
  /** embed 批量接口每批条数(issue #93);≤0 视为未配置,回退默认。 */
  embedBatchSize?: number;
}

/** /api/embed 自 Ollama 0.9.2 起提供,低于该版本视为旧版,404 可安全降级为逐条。 */
const MIN_EMBED_API_VERSION = [0, 9, 2];
/** /api/embed 单请求默认批量上限,避免请求体过大。 */
const DEFAULT_EMBED_BATCH = 64;

/** a<b 返回负数:按段比较语义化版本,非数字段视为 0。 */
function compareVersion(a: string, b: number[]): number {
  const parts = a.split('.').map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(parts.length, b.length); i++) {
    const diff = (parts[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 批量接口不可用(旧版无该接口 404/405,或返回结构不符合预期),触发逐条回退。 */
class EmbedBatchUnavailableError extends LLMError {
  constructor(readonly reason: string) {
    super(`Ollama 批量 embedding 接口不可用:${reason}`, false);
    this.name = 'EmbedBatchUnavailableError';
  }
}

/**
 * Ollama —— 本地 HTTP API(默认 http://localhost:11434),免网免密。
 * chat/stream 走 /api/chat(NDJSON),embed 优先走批量 /api/embed,旧版回退逐条 /api/embeddings。
 */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';

  /** 批量接口不可用(旧版 Ollama)时置位,后续 embed 直接走逐条,不再试批量。 */
  private embedBatchUnsupported = false;
  /** /api/version 探测结果缓存:undefined=未探测。 */
  private legacyServer?: boolean;

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
          // JSON 强约束只对非流式生效(issue #87),与 chatOpts 的 options 字段互不影响
          ...(options?.jsonMode ? { format: 'json' } : {}),
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

  /**
   * 批量向量化(issue #93):走 /api/embed(input 为 string[]),按 embedBatchSize 分块,
   * HTTP 往返从每条一次降为每批一次。旧版 Ollama 无该接口时,从出错的那一批起整体回退
   * 逐条 /api/embeddings,并记住降级避免后续空试。
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    if (this.embedBatchUnsupported) return this.embedLegacy(texts);

    const batchSize = Math.max(1, this.opts.embedBatchSize ?? DEFAULT_EMBED_BATCH);
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      try {
        out.push(...(await this.embedBatch(texts.slice(start, start + batchSize))));
      } catch (err) {
        const reason = await this.batchUnavailableReason(err);
        if (!reason) throw err;
        this.embedBatchUnsupported = true;
        Logger.warn(
          `Ollama 批量接口 /api/embed 不可用(${reason}),已回退逐条 /api/embeddings(升级 Ollama 可恢复批量)。`,
          'OllamaProvider',
        );
        return [...out.slice(0, start), ...(await this.embedLegacy(texts.slice(start)))];
      }
    }
    return out;
  }

  /**
   * 判定是否该走旧版回退,返回降级原因(不降级则返回 null 交由上层抛出)。
   * 404 在本机 Ollama 上既可能是"旧版无此路由",也可能是"模型没 pull"(实测两者都回 404),
   * 故按 /api/version 区分:低于 0.9.2 才降级,否则原样抛出,避免掩盖 OLLAMA_EMBED_MODEL 配错。
   */
  private async batchUnavailableReason(err: unknown): Promise<string | null> {
    if (err instanceof EmbedBatchUnavailableError) return err.reason;
    if (!(err instanceof LLMError)) return null;
    if (err.status === 405) return 'HTTP 405';
    if (err.status === 404) return (await this.isLegacyServer()) ? 'HTTP 404(旧版无 /api/embed)' : null;
    return null;
  }

  /** 服务端版本 < 0.9.2 视为旧版;取不到版本(更老的实现无 /api/version)同样按旧版处理。 */
  private async isLegacyServer(): Promise<boolean> {
    if (this.legacyServer !== undefined) return this.legacyServer;
    let legacy = true;
    try {
      const res = await fetch(`${this.opts.baseUrl}/api/version`, { signal: AbortSignal.timeout(this.opts.timeoutMs) });
      const version = res.ok ? ((await res.json())?.version as string | undefined) : undefined;
      legacy = version ? compareVersion(version, MIN_EMBED_API_VERSION) < 0 : true;
    } catch {
      legacy = true;
    }
    this.legacyServer = legacy;
    return legacy;
  }

  private async embedBatch(chunk: string[]): Promise<number[][]> {
    const embeddings = await withRetry(async () => {
      const json = await postJson(
        `${this.opts.baseUrl}/api/embed`,
        { model: this.opts.embedModel, input: chunk },
        {},
        { timeoutMs: this.opts.timeoutMs },
      );
      if (!Array.isArray(json?.embeddings)) throw new EmbedBatchUnavailableError('返回体缺少 embeddings 字段');
      return json.embeddings as number[][];
    });
    if (embeddings.length !== chunk.length) {
      throw new EmbedBatchUnavailableError(`返回 ${embeddings.length} 条,期望 ${chunk.length} 条`);
    }
    return embeddings;
  }

  /** 旧版 Ollama 路径:/api/embeddings 一次一条。 */
  private async embedLegacy(texts: string[]): Promise<number[][]> {
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
