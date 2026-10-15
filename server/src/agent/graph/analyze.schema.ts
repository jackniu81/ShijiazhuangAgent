import type { ToolCall } from './graph.types';

/**
 * analyze LLM 输出的结构解析与语义校验(chat-tools-spec P4)。
 * 结构漂移(代码块包裹/前后多余文字)容错提取;语义合法性(日期范围/重复调用/资料覆盖)
 * 由 server 侧强制,不信任模型自判(§10:LLM 输出 ISO 日期,server 仅做范围校验)。
 */

/** 解析 YYYY-MM-DD,返回距今天数(本地日历,东八区安全);非法/缺失返回 null。 */
export function daysFromToday(date: unknown, now: Date = new Date()): number | null {
  if (typeof date !== 'string') return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date.trim());
  if (!m) return null;
  const [, y, mo, da] = m.map(Number);
  const target = new Date(y, mo - 1, da);
  // 拒绝溢出日期(如 2026-13-40 会被 Date 规整为 2027-02-09):分量必须回读一致
  if (target.getFullYear() !== y || target.getMonth() !== mo - 1 || target.getDate() !== da) {
    return null;
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** 本地日历的 YYYY-MM-DD(避免 toISOString 在 UTC 凌晨差一天)。 */
export function localDateStr(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 从模型输出中提取 JSON:去 ```json 代码块,退而截取首个花括号对象。 */
function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced) return fenced[1].trim();
  const brace = /\{[\s\S]*\}/.exec(raw);
  return (brace ? brace[0] : raw).trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 宽松结构解析:非 JSON/缺 toolCalls → [];逐项丢弃 name 非法或 params 非对象的调用。 */
export function parseAnalyzeToolCalls(raw: string): ToolCall[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return [];
  }
  const arr = (parsed as { toolCalls?: unknown } | null)?.toolCalls;
  if (!Array.isArray(arr)) return [];
  const out: ToolCall[] = [];
  for (const item of arr) {
    if (!isRecord(item) || !isRecord(item.params)) continue;
    if (item.name === 'weather' || item.name === 'rag_attraction' || item.name === 'web_search') {
      out.push({ name: item.name, params: item.params });
    }
  }
  return out;
}

export interface AnalyzeSelectionContext {
  /** weather 灰度开关,关时即使模型要求也不调用 */
  weatherEnabled: boolean;
  /** web_search 灰度开关,关时即使模型要求也不调用 */
  webSearchEnabled: boolean;
  /** baseline + rag_tool 已覆盖的景点标题集合 */
  docTitles: Set<string>;
  weatherDone: boolean;
  ragDone: Set<string>;
  /** 已执行过网站查询的 query 集合,避免重复检索 */
  webDone: Set<string>;
  /** 基准"今天"(测试注入用),默认取系统当前日期 */
  now?: Date;
}

/**
 * 语义校验后选出本轮唯一可执行调用(串行调度,§3):
 * - weather:开关开、日期 0~5 天内、未查过;
 * - rag_attraction:景点名非空、未被 docs 覆盖、未查过;
 * - web_search:开关开、query 非空、未查过。
 * 全部不合法 → undefined(直接进入 generate)。
 */
export function selectAnalyzeToolCall(
  calls: ToolCall[],
  ctx: AnalyzeSelectionContext,
): ToolCall | undefined {
  for (const call of calls) {
    if (call.name === 'weather') {
      if (!ctx.weatherEnabled || ctx.weatherDone) continue;
      const diff = daysFromToday(call.params.date, ctx.now);
      if (diff === null || diff < 0 || diff > 5) continue;
      return call;
    }
    if (call.name === 'web_search') {
      if (!ctx.webSearchEnabled) continue;
      const query = String(call.params.query ?? '').trim();
      if (!query || ctx.webDone.has(query)) continue;
      return { name: 'web_search', params: { query } };
    }
    const attraction = String(call.params.attraction ?? '').trim();
    if (!attraction || ctx.docTitles.has(attraction) || ctx.ragDone.has(attraction)) continue;
    return { name: 'rag_attraction', params: { attraction } };
  }
  return undefined;
}
