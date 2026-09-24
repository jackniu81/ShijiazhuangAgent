import { InMemoryVectorStore } from './store';
import { Chunk, Embedder } from './rag.types';

const chunk = (text: string, source: string, tags: string[] = []): Chunk => ({
  text,
  source,
  meta: { title: source, tags, source },
});

/** embedder:任何文本都向量化为 [1,0](让向量路结果可控) */
const flatEmbedder: Embedder = async (texts) => texts.map(() => [1, 0]);

const semanticFirst: Embedder = async (texts) =>
  texts.map((t) => (t.startsWith('向量') || t.includes('甲') ? [1, 0] : [0, 1]));

describe('InMemoryVectorStore 混合检索', () => {
  it('空索引检索返回空', async () => {
    const store = new InMemoryVectorStore();
    expect(store.size).toBe(0);
    await expect(store.searchByText('任意', flatEmbedder, 3)).resolves.toEqual([]);
  });

  it('hybrid(默认):关键词独有的文档能被召回,纯向量则漏掉', async () => {
    const store = new InMemoryVectorStore();
    store.add(chunk('无关内容甲', 'a.md'), [1, 0]); // 向量与 query 完全一致
    store.add(chunk('牛肉板面真好吃', 'b.md'), [0, 1]); // 向量与 query 正交

    const vectorOnly = store.searchByVector([1, 0], 1);
    expect(vectorOnly.map((d) => d.source)).toEqual(['a.md']); // k=1 时 b.md 被漏掉

    const hybrid = await store.searchByText('向量 牛肉板面', semanticFirst, 2);
    expect(hybrid.map((d) => d.source).sort()).toEqual(['a.md', 'b.md']); // 两路都能进结果
    expect(hybrid[0].source).toBe('b.md'); // 关键词第一 + 向量榜尾 的融合分高于 向量第一
  });

  it('hybrid=false:searchByText 退化为纯向量', async () => {
    const store = new InMemoryVectorStore({ hybrid: false });
    store.add(chunk('无关内容甲', 'a.md'), [1, 0]);
    store.add(chunk('牛肉板面真好吃', 'b.md'), [0, 1]);

    const hits = await store.searchByText('牛肉板面', flatEmbedder, 1);
    expect(hits.map((d) => d.source)).toEqual(['a.md']); // 只看向量,关键词无效
  });

  it('tag 命中的文档经 rerank 加权后可反超同名次对手', async () => {
    const store = new InMemoryVectorStore();
    store.add(chunk('板面做法传承百年', 'plain.md'), [0, 1]); // 关键词命中,无 tag
    store.add(chunk('特色板面小店推荐', 'tagged.md', ['美食', '板面']), [0, 1]);

    const hits = await store.searchByText('板面', flatEmbedder, 2);
    // 两者向量分相同、关键词名次相近,tag「板面」加分让 tagged 置顶
    expect(hits[0].source).toBe('tagged.md');
  });

  it('k 限制结果条数', async () => {
    const store = new InMemoryVectorStore();
    for (let i = 0; i < 5; i++) store.add(chunk(`文档${i}`, `d${i}.md`), [1, 0]);
    const hits = await store.searchByText('文档1', flatEmbedder, 2);
    expect(hits).toHaveLength(2);
  });

  it('score 为融合分且降序排列', async () => {
    const store = new InMemoryVectorStore();
    store.add(chunk('正定古城墙', 'zhengding.md', ['古城']), [1, 0]);
    store.add(chunk('河北博物院', 'museum.md'), [0.5, 0.5]);
    const hits = await store.searchByText('正定古城', flatEmbedder, 2);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
    expect(hits[0].source).toBe('zhengding.md');
  });
});
