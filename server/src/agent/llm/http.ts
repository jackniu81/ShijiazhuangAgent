import { Msg } from './llm.types';

/**
 * LLM 供应商调用层共享工具:错误类型、重试、超时/取消信号、流式按行解析。
 * 错误信息均为可直接展示给用户的中文文案(spec §8)。
 */

/** 供应商调用失败(网络/超时/非 2xx/解析),retryable 决定是否值得重试一次。 */
export class LLMError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/** 外部取消(AbortSignal)触发的中断,不应被翻译为 LLM_ERROR。 */
export class AbortedError extends Error {
  constructor() {
    super('request aborted');
    this.name = 'AbortedError';
  }
}

export interface HttpRequestOptions {
  timeoutMs: number;
  /** 客户端取消/上层超时信号 */
  signal?: AbortSignal;
}

/** 组合"超时 + 外部取消"信号;超时与取消可通过返回的 timedOut() 区分。 */
export function composeSignal(
  opts: HttpRequestOptions,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), opts.timeoutMs);
  const onExternalAbort = () => ctrl.abort(new AbortedError());
  if (opts.signal) {
    if (opts.signal.aborted) onExternalAbort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    timedOut: () => !opts.signal?.aborted, // 外部未取消而 abort ⇒ 超时
    dispose: () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** 网络层异常 → 统一 LLMError(可重试);取消透传 AbortedError。 */
export function toLlmError(err: unknown, baseUrl: string): Error {
  if (err instanceof AbortedError) return err;
  if (err instanceof LLMError) return err;
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new LLMError('LLM 服务响应超时,请稍后重试。');
  }
  return new LLMError(`无法连接 LLM 服务(${baseUrl}),请检查 provider 配置与网络。`);
}

/** POST JSON 并校验状态码,返回解析后的 JSON。非 2xx → LLMError(5xx 可重试)。 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: HttpRequestOptions,
): Promise<any> {
  const { signal, timedOut, dispose } = composeSignal(opts);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      const retryable = res.status >= 500;
      throw new LLMError(`LLM 服务返回错误(${res.status}),请稍后重试。${retryable ? '' : ''} ${text}`.trim(), retryable);
    }
    return await res.json();
  } catch (err) {
    if (signal.aborted && timedOut()) throw new LLMError('LLM 服务响应超时,请稍后重试。');
    throw toLlmError(err, url);
  } finally {
    dispose();
  }
}

/** 执行 fn,LLMError 且 retryable 时重试 1 次(spec §8)。 */
export async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (err instanceof AbortedError) throw err;
      if (!(err instanceof LLMError) || !err.retryable) throw err;
    }
  }
  throw last;
}

/** 逐行读取响应体(SSE 的 "data: ..." 与 NDJSON 均按行处理);回调返回 false 提前终止。 */
export async function readLines(
  res: Response,
  onLine: (line: string) => boolean | void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line && onLine(line) === false) {
        reader.cancel().catch(() => undefined);
        return;
      }
    }
  }
}

/** 把 Msg[] 转成 OpenAI/Ollama 通用 message 结构(两者字段一致)。 */
export function toProviderMessages(messages: Msg[]): Array<{ role: string; content: string }> {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}
