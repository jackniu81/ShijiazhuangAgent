/**
 * BM25 关键词检索(纯 TS,无分词依赖)。
 * 中文按"单字 + 字符 bigram"切分:无需词典即可捕获词组信号,
 * 与向量检索形成语义/字面的互补。
 */

const K1 = 1.5;
const B = 0.75;

/** 归一化后切为单字 + bigram 序列。 */
export function tokenize(text: string): string[] {
  const s = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!s.length) return [];
  const grams: string[] = [];
  for (let i = 0; i < s.length; i++) {
    grams.push(s[i]);
    if (i + 1 < s.length) grams.push(s.slice(i, i + 2));
  }
  return grams;
}

interface Bm25Doc {
  tf: Map<string, number>;
  len: number;
}

export class Bm25Index {
  private readonly docs: Bm25Doc[] = [];
  /** term -> 包含该 term 的文档数 */
  private readonly df = new Map<string, number>();
  private totalLen = 0;

  /** 添加文档,返回文档 id(add 顺序)。 */
  add(text: string): number {
    const tf = new Map<string, number>();
    const dfSeen = new Set<string>();
    for (const g of tokenize(text)) {
      tf.set(g, (tf.get(g) ?? 0) + 1);
      if (!dfSeen.has(g)) {
        this.df.set(g, (this.df.get(g) ?? 0) + 1);
        dfSeen.add(g);
      }
    }
    this.docs.push({ tf, len: tf.size ? text.length : 0 });
    this.totalLen += this.docs[this.docs.length - 1].len;
    return this.docs.length - 1;
  }

  get size(): number {
    return this.docs.length;
  }

  /** 返回按 BM25 得分降序的前 k 条(得分 > 0 才参与排序)。 */
  search(query: string, k: number): Array<{ id: number; score: number }> {
    const n = this.docs.length;
    if (!n || k <= 0) return [];
    const avgdl = this.totalLen / n || 1;
    const scores = new Map<number, number>();
    for (const term of new Set(tokenize(query))) {
      const df = this.df.get(term);
      if (!df) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (let id = 0; id < n; id++) {
        const f = this.docs[id].tf.get(term);
        if (!f) continue;
        const norm = f * (K1 + 1) * (1 - B + (B * this.docs[id].len) / avgdl);
        const score = (idf * norm) / (f + K1 * (1 - B + (B * this.docs[id].len) / avgdl));
        scores.set(id, (scores.get(id) ?? 0) + score);
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
