import { Logger } from '@nestjs/common';

/**
 * 真实网站查询数据源(chat-tools-spec web_search 工具,P5):DuckDuckGo HTML 版,免 API Key。
 * 端点:GET https://html.duckduckgo.com/html/?q=<query>
 * 用 Node 内置 fetch + 正则解析,不引入 HTML 解析依赖。
 * 契约与 deps.webSearch 对齐:返回可直接拼入 prompt 的纯文本;
 * 任意异常(网络/非 2xx/超时/解析)均内部消化打 warn,降级为"未找到"文案,不向上抛。
 */

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export interface WebSearchOptions {
  topK: number;
  timeoutMs: number;
  /** 取消/超时联动信号,中断在途 fetch */
  signal?: AbortSignal;
}

/** 单条在线结果。 */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const NO_RESULT = (query: string): string => `未找到关于「${query}」的联网信息。`;

export async function duckduckgoWebSearch(
  query: string,
  opts: WebSearchOptions,
): Promise<string> {
  const q = query.trim();
  if (!q || opts.topK <= 0) return NO_RESULT(q);

  const url = `${DDG_ENDPOINT}?q=${encodeURIComponent(q)}`;
  const logger = new Logger('DuckDuckGoWebSearch');
  let html: string;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: composeSignal(opts),
    });
    if (!res.ok) {
      logger.warn(`web 搜索返回错误(${res.status}),降级为无在线结果。`);
      return NO_RESULT(q);
    }
    html = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`web 搜索失败(${msg}),降级为无在线结果。`);
    return NO_RESULT(q);
  }

  const results = parseDuckDuckGoHtml(html).slice(0, opts.topK);
  if (!results.length) return NO_RESULT(q);
  return formatResults(q, results);
}

/** 组合"外部取消 + 自身超时"信号;任一触发即中断 fetch。外部缺省时仅用超时。 */
function composeSignal(opts: WebSearchOptions): AbortSignal {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  return opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
}

/** 把在线结果格式化为多行文本块,供 generate 作为"工具查询结果"注入 prompt。 */
function formatResults(query: string, results: WebSearchResult[]): string {
  const lines = results.map((r) => {
    const snip = r.snippet ? `\n  ${r.snippet}` : '';
    return `- ${r.title} (${r.url})${snip}`;
  });
  return `【网站查询】关于「${query}」的联网结果:\n${lines.join('\n')}`;
}

/**
 * 解析 DDG HTML 结果页。每条结果形如:
 *   <a class="result__a" href="//duckduckgo.com/l/?uddg=<encUrl>">标题</a>
 *   <a class="result__snippet">摘要</a>
 * 以 result__a 锚点取标题与链接(真实 URL 从 uddg 参数解码),摘要按出现顺序与标题配对。
 */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html)) !== null) {
    const url = decodeRedirect(m[1]);
    const title = stripTags(m[2]);
    if (url && title) out.push({ title, url, snippet: snippets[i] ?? '' });
    i++;
  }
  return out;
}

/** DDG 结果为重定向链接 //duckduckgo.com/l/?uddg=<encUrl>&rut=...,取 uddg 解码回真实 URL。 */
function decodeRedirect(href: string): string {
  const raw = href.replace(/&amp;/g, '&');
  try {
    const uddg = new URL(raw, DDG_ENDPOINT).searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : raw;
  } catch {
    return raw;
  }
}

/** 去除内嵌 HTML 标签并反转义常见实体,得到纯文本。 */
function stripTags(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&')
    .trim();
}
