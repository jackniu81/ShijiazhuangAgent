import { Chunk, Embedder, RetrievedDoc, VectorStore, WritableVectorStore } from './rag.types';
import { InMemoryVectorStore } from './store';

/**
 * issue #29 抽象接缝契约测试。
 * - InMemoryVectorStore 同时满足消费侧(VectorStore)与可写侧(WritableVectorStore);
 * - PgVectorStore 只需满足消费侧(add 走 syncFromDir 批量入库,不实现 add)。
 * 该测试固化两半接口的形状,防止后续 PR 破坏可替换性。
 */
describe('VectorStore / WritableVectorStore 接口契约', () => {
  it('InMemoryVectorStore 同时满足可写侧与消费侧接口', () => {
    const writable: WritableVectorStore = new InMemoryVectorStore();
    const consumer: VectorStore = writable; // 可写侧向上转型为消费侧
    expect(typeof writable.add).toBe('function');
    expect(typeof consumer.searchByText).toBe('function');
    expect(consumer.size).toBe(0);
  });

  it('仅实现消费侧的 store 也能被检索流程使用(pgvector 后端形态)', async () => {
    const fake: RetrievedDoc = {
      text: 'x',
      source: 'fake.md',
      score: 1,
      meta: { title: 'fake', tags: [], source: 'fake.md' },
    };
    // 只有 size + searchByText,不含 add —— 模拟 PgVectorStore 的公开契约
    const pgLike: VectorStore = {
      size: 1,
      async searchByText(_q: string, _embedder: Embedder, _k?: number) {
        return [fake];
      },
    };

    const store: VectorStore = pgLike;
    const hits = await store.searchByText('任意', async (t) => t.map(() => [1, 0]), 3);
    expect(store.size).toBe(1);
    expect(hits).toEqual([fake]);
  });

  it('WritableVectorStore.add 写入后可被 size/searchByText 观测', async () => {
    const store: WritableVectorStore = new InMemoryVectorStore();
    const chunk: Chunk = { text: '牛肉板面', source: 'a.md', meta: { title: 'a', tags: [], source: 'a.md' } };
    store.add(chunk, [1, 0]);
    expect(store.size).toBe(1);
  });
});
