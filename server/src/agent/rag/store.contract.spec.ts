import { Chunk, Embedder, RetrievedDoc, VectorStore } from './rag.types';
import { InMemoryVectorStore } from './store';

/**
 * issue #29 一阶段契约测试:固化 VectorStore 接缝。
 * 目的:证明内存实现符合接口,且调用方(RagService 等)只依赖接口即可,
 * 后续 PgVectorStore 只要实现同一接口即可无缝替换(开关对比)。
 */
describe('VectorStore 接口契约', () => {
  it('InMemoryVectorStore 满足 VectorStore 接口', () => {
    const store: VectorStore = new InMemoryVectorStore();
    expect(typeof store.add).toBe('function');
    expect(typeof store.searchByText).toBe('function');
    expect(store.size).toBe(0);
  });

  it('任意 VectorStore 实现都能通过接口被消费(多态)', async () => {
    const fake: RetrievedDoc = {
      text: 'x',
      source: 'fake.md',
      score: 1,
      meta: { title: 'fake', tags: [], source: 'fake.md' },
    };
    const fakeStore: VectorStore = {
      size: 1,
      add(_chunk: Chunk, _vector: number[]) {
        /* no-op */
      },
      async searchByText(_q: string, _embedder: Embedder, _k?: number) {
        return [fake];
      },
    };

    const store: VectorStore = fakeStore;
    const hits = await store.searchByText('任意', async (t) => t.map(() => [1, 0]), 3);
    expect(store.size).toBe(1);
    expect(hits).toEqual([fake]);
  });
});
