import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildIndexFromDir } from './indexer';
import { Embedder } from './rag.types';

/** 所有文本同一向量:向量路无区分度,检索结果完全由 BM25 + rerank 决定 */
const flatEmbedder: Embedder = async (texts) => texts.map(() => [1, 0]);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rag-index-'));
  mkdirSync(join(dir, 'attractions'), { recursive: true });
  mkdirSync(join(dir, 'routes'), { recursive: true });
  writeFileSync(
    join(dir, 'attractions', '正定古城.md'),
    '---\ntitle: 正定古城\ntags: [古城, 夜景]\nregion: 正定县\n---\n\n# 正定古城\n\n夜游古城墙,看灯光秀。',
    'utf-8',
  );
  writeFileSync(
    join(dir, 'routes', '市区两日游.md'),
    '---\ntitle: 市区两日游\ntags: [博物馆, 两日]\nregion: 市区\n---\n\n# 市区两日游\n\n河北博物院加正定古城。',
    'utf-8',
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildIndexFromDir', () => {
  it('递归收录子目录(含 routes/),source 为相对正斜杠路径', async () => {
    const store = await buildIndexFromDir(dir, flatEmbedder);
    const sources = (await store.searchByText('古城', flatEmbedder, 10)).map((d) => d.source);
    expect(sources).toContain('attractions/正定古城.md');
    expect(sources).toContain('routes/市区两日游.md');
  });

  it('解析 front-matter 到 meta(title/tags/region)', async () => {
    const store = await buildIndexFromDir(dir, flatEmbedder);
    const hits = await store.searchByText('夜游古城墙', flatEmbedder, 1);
    expect(hits).toHaveLength(1);
    const meta = hits[0].meta;
    expect(meta.title).toBe('正定古城');
    expect(meta.tags).toContain('古城');
    expect(meta.region).toBe('正定县');
  });

  it('目录不存在:返回空索引不抛错(降级)', async () => {
    const embed = jest.fn(flatEmbedder);
    const store = await buildIndexFromDir(join(dir, 'nope'), embed);
    expect(store.size).toBe(0);
    expect(embed).not.toHaveBeenCalled(); // 无切块时不应调用 embedding
  });

  it('hybrid 生效:同向量下靠关键词排序', async () => {
    const store = await buildIndexFromDir(dir, flatEmbedder);
    const hits = await store.searchByText('博物馆', flatEmbedder, 2);
    expect(hits[0].source).toBe('routes/市区两日游.md');
  });

  it('chunkSize 透传:超长文档被切为多块', async () => {
    const long = '山'.repeat(1200);
    writeFileSync(join(dir, 'attractions', 'long.md'), `---\ntitle: 长文\n---\n\n${long}`, 'utf-8');
    const store = await buildIndexFromDir(dir, flatEmbedder, { chunkSize: 500, chunkOverlap: 50 });
    const longChunks = (await store.searchByText('山', flatEmbedder, 20)).filter((d) =>
      d.source.endsWith('long.md'),
    );
    expect(longChunks.length).toBeGreaterThan(1);
  });
});
