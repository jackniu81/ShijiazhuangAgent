import { ChatOptions, LLMProvider, Msg } from './llm.types';

/**
 * MockProvider —— 无外部依赖的假实现,用于在接入真实 LLM 前跑通全链路。
 * - embed:字符 bigram 哈希投影为固定维向量并做 L2 归一化,
 *   使文本重叠度越高、余弦相似度越大,给 RAG 提供真实可用的排序信号。
 * - chat/stream:回放模板化中文回答(可流式),不依赖模型。
 * 行程生成的结构化对象由图节点在 mock 模式下用代码组装(见 graph/),
 * 真模型接入后改由 chat 返回 JSON,MockProvider 无需改动。
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock';

  private readonly dim: number;
  private readonly streamDelayMs: number;

  constructor(options: { dim?: number; streamDelayMs?: number } = {}) {
    this.dim = options.dim ?? 256;
    this.streamDelayMs = options.streamDelayMs ?? 150;
  }

  async chat(messages: Msg[], _options?: ChatOptions): Promise<string> {
    return this.composeAnswer(messages);
  }

  async stream(
    messages: Msg[],
    onToken: (token: string) => void,
    options?: ChatOptions,
  ): Promise<string> {
    const answer = this.composeAnswer(messages);
    let emitted = '';
    for (const token of tokenize(answer)) {
      if (options?.signal?.aborted) return emitted; // 取消/超时中断回放
      emitted += token;
      onToken(token);
      await sleep(this.streamDelayMs);
    }
    return answer;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  // ---------- internals ----------

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    const s = normalize(text);
    for (let i = 0; i < s.length; i++) {
      addFeature(vec, this.dim, s[i]);
      if (i + 1 < s.length) addFeature(vec, this.dim, s.slice(i, i + 2));
    }
    return l2normalize(vec);
  }

  /** 从对话里抽取问题与检索上下文,拼一段模板化回答。 */
  private composeAnswer(messages: Msg[]): string {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const content = lastUser?.content ?? '';
    const question = extractBetween(content, 'Q:', '\n') ?? content.trim();
    const docs = (extractBetween(content, 'CONTEXT:', '\n') ?? '')
      .split(/[;；|、]/)
      .map((s) => s.trim())
      .filter(Boolean);

    return buildAnswer(question, docs);
  }
}

function buildAnswer(question: string, docs: string[]): string {
  const list = docs.slice(0, 4).join('、');
  const head = question ? `关于「${question}」:` : '石家庄之旅:';
  const middle = list
    ? `结合本地资料,推荐重点关注 ${list}。市区可安排人文博物馆与正定古城一线,`
    : '石家庄是一座被低估的宝藏城市,';
  return (
    head +
    middle +
    '周边则有苍岩山、嶂石岩、西柏坡等山水与红色线路。告诉我出行天数与兴趣,可为你排一份详细行程。(Mock 回答,接入真实 LLM 后由模型生成)'
  );
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

function addFeature(vec: number[], dim: number, gram: string): void {
  // FNV-1a 32bit
  let h = 2166136261;
  for (let i = 0; i < gram.length; i++) {
    h ^= gram.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = Math.abs(h) % dim;
  vec[idx] += 1;
}

function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

function extractBetween(text: string, start: string, end: string): string | undefined {
  const si = text.indexOf(start);
  if (si === -1) return undefined;
  const from = si + start.length;
  const ei = text.indexOf(end, from);
  return text.slice(from, ei === -1 ? text.length : ei).trim();
}

function tokenize(text: string): string[] {
  return text.match(/[^，。；：、！？\s]+[，。；：、！？]?|\s+/g) ?? [text];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
