import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cosineSimilarity } from './math';
import { PgQueryable, PgVectorStore } from './pg-vector.store';
import { Embedder } from './rag.types';

/** 模拟 pgvector 的内存假库:落地 INSERT/DELETE/SELECT,并用 TS 余弦还原 `<=>` 排序。 */
interface FakeRow {
  id: number;
  source: string;
  chunk_index: number;
  text: string;
  meta: Record<string, unknown>;
  embedding: number[];
}

class FakePg implements PgQueryable {
  rows: FakeRow[] = [];
  private nextId = 1;
  readonly sqls: string[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: FakeRow[] }> {
    this.sqls.push(sql);
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE/i.test(s)) return { rows: [] };
    if (/^INSERT INTO/i.test(s)) {
      const [source, chunk_index, text, metaJson, vecLit] = params as [
        string,
        number,
        string,
        string,
        string,
      ];
      this.rows.push({
        id: this.nextId++,
        source,
        chunk_index,
        text,
        meta: JSON.parse(metaJson),
        embedding: JSON.parse(vecLit),
      });
      return { rows: [] };
    }
    if (/DELETE FROM \S+ WHERE source = ANY/i.test(s)) {
      const srcs = params[0] as string[];
      this.rows = this.rows.filter((r) => !srcs.includes(r.source));
      return { rows: [] };
    }
    if (/DELETE FROM \S+ WHERE NOT \(source = ANY/i.test(s)) {
      const srcs = params[0] as string[];
      this.rows = this.rows.filter((r) => srcs.includes(r.source));
      return { rows: [] };
    }
    if (/SELECT id, source, chunk_index, text, meta/i.test(s)) {
      return { rows: [...this.rows].sort((a, b) => a.id - b.id) };
    }
    if (/SELECT source, text, meta, 1 - \(embedding/i.test(s)) {
      const qv = JSON.parse(params[0] as string);
      const k = params[1] as number;
      return {
        rows: this.ranked(qv)
          .slice(0, k)
          .map((r) => ({ ...r, score: cosineSimilarity(qv, r.embedding) } as unknown as FakeRow)),
      };
    }
    if (/SELECT id FROM \S+ ORDER BY embedding/i.test(s)) {
      const qv = JSON.parse(params[0] as string);
      const k = params[1] as number;
      return { rows: this.ranked(qv).slice(0, k) };
    }
    throw new Error('unexpected sql: ' + s);
  }

  private ranked(qv: number[]): FakeRow[] {
    return [...this.rows].sort(
      (a, b) => cosineSimilarity(qv, b.embedding) - cosineSimilarity(qv, a.embedding),
    );
  }
}

/** 含「甲」→ [1,0],否则 [0,1]:给向量路可预期的区分度。query 与文档共用此函数。 */
const semantic: Embedder = async (texts) => texts.map((t) => (t.includes('甲') ? [1, 0] : [0, 1]));
const flat: Embedder = async (texts) => texts.map(() => [1, 0]);

let dir: string;

function writeDoc(rel: string, body: string, tags = ''): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `---\ntitle: ${rel}\ntags: [${tags}]\n---\n\n${body}`, 'utf-8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rag-pg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PgVectorStore', () => {
  it('syncFromDir:建 schema + 落库 + 回填内存,size 与切块数一致', async () => {
    writeDoc('attractions/a.md', '牛肉板面甲', '美食');
    writeDoc('attractions/b.md', '正定古城乙', '古城');
    const db = new FakePg();
    const store = new PgVectorStore(db, { dimensions: 2, hybrid: true });
    await store.syncFromDir(dir, semantic);

    expect(db.sqls.some((x) => /CREATE EXTENSION IF NOT EXISTS vector/i.test(x))).toBe(true);
    expect(db.sqls.some((x) => /CREATE TABLE/i.test(x))).toBe(true);
    expect(store.size).toBe(2);
    expect(db.rows).toHaveLength(2);
  });

  it('hybrid=false:searchByText 退化为纯向量,按余弦降序', async () => {
    writeDoc('attractions/a.md', '文档甲');
    writeDoc('attractions/b.md', '文档乙');
    const db = new FakePg();
    const store = new PgVectorStore(db, { dimensions: 2, hybrid: false });
    await store.syncFromDir(dir, semantic);

    const hits = await store.searchByText('甲', semantic, 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].source).toBe('attractions/a.md'); // 甲 与 [1,0] 向量一致
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
  });

  it('hybrid=true:同向量下靠 BM25 关键词区分', async () => {
    writeDoc('attractions/plain.md', '牛肉板面做法');
    writeDoc('attractions/tagged.md', '特色板面小店', '板面');
    const db = new FakePg();
    const store = new PgVectorStore(db, { dimensions: 2, hybrid: true });
    await store.syncFromDir(dir, flat); // 向量无区分度,结果完全由关键词 + rerank 决定

    const hits = await store.searchByText('板面', flat, 2);
    expect(hits.map((d) => d.source).sort()).toEqual(['attractions/plain.md', 'attractions/tagged.md']);
    expect(hits[0].source).toBe('attractions/tagged.md'); // tag「板面」加权反超
  });

  it('重建幂等:重复 syncFromDir 不产生重复行(先删后插)', async () => {
    writeDoc('attractions/a.md', '文档甲');
    const db = new FakePg();
    const store = new PgVectorStore(db, { dimensions: 2, hybrid: true });
    await store.syncFromDir(dir, semantic);
    await store.syncFromDir(dir, semantic);
    expect(store.size).toBe(1);
    expect(db.rows).toHaveLength(1);
  });

  it('删除磁盘文件后重建:残留行被清理', async () => {
    writeDoc('attractions/a.md', '文档甲');
    writeDoc('attractions/gone.md', '文档丙');
    const db = new FakePg();
    const store = new PgVectorStore(db, { dimensions: 2, hybrid: true });
    await store.syncFromDir(dir, semantic);
    expect(store.size).toBe(2);

    rmSync(join(dir, 'attractions', 'gone.md'));
    await store.syncFromDir(dir, semantic);
    expect(store.size).toBe(1);
    expect(db.rows.map((r) => r.source)).toEqual(['attractions/a.md']);
  });

  it('空目录:清空全表不抛错', async () => {
    const db = new FakePg();
    const store = new PgVectorStore(db, { dimensions: 2 });
    await store.syncFromDir(join(dir, 'nope'), semantic);
    expect(store.size).toBe(0);
    await expect(store.searchByText('任意', semantic, 3)).resolves.toEqual([]);
  });

  it('非法表名回退默认 rag_chunks', async () => {
    const db = new FakePg();
    const store = new PgVectorStore(db, { dimensions: 2, table: 'bad; DROP TABLE' });
    await store.syncFromDir(dir, semantic);
    expect(db.sqls.some((x) => /CREATE TABLE IF NOT EXISTS rag_chunks/i.test(x))).toBe(true);
  });
});
