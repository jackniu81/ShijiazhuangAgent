/** jest-runtime 无法 require @nestjs/* 纯 ESM 包(同 nodes.spec.ts),故打桩 Logger。 */
const warns: string[] = [];
jest.mock('@nestjs/common', () => ({
  Logger: class {
    log(): void {}
    warn(msg: string): void {
      warns.push(msg);
    }
  },
  Inject: () => () => {},
  Injectable: () => () => {},
}));

import { LLMProvider } from '../llm/llm.types';
import { AppConfig } from '../../config/configuration';
import { RetrievedDoc, VectorStore } from './rag.types';
import { RagService } from './rag.service';

/** 显式向量表:未登记的文本一律 [1,0](与 query 同向,cos=1)。 */
const VECS: Record<string, number[]> = {
  正定古城: [1, 0],
  完全无关的内容: [0, 1],
};
const llm = {
  name: 'fake',
  embed: async (texts: string[]) => texts.map((t) => VECS[t] ?? [1, 0]),
} as unknown as LLMProvider;

const doc = (title: string, text: string): RetrievedDoc => ({
  text,
  source: `${title}.md`,
  score: 0.03,
  meta: { title, tags: [], source: `${title}.md` },
});

class FakeStore implements VectorStore {
  size = 2;
  async searchByText(
    _query: string,
    _embedder?: (texts: string[]) => Promise<number[][]>,
    _k?: number,
  ): Promise<RetrievedDoc[]> {
    return [doc('正定古城', '正定古城'), doc('无关', '完全无关的内容')];
  }
}

const makeService = (minScore: number): RagService => {
  const config = { rag: { minScore, topK: 5 } } as unknown as AppConfig;
  const service = new RagService(llm, config);
  (service as unknown as { store: VectorStore }).store = new FakeStore();
  return service;
};

describe('RagService.retrieve 相关度阈值过滤 (issue #89)', () => {
  it('低分文档被过滤,相关文档保留', async () => {
    const docs = await makeService(0.2).retrieve('正定古城怎么玩');
    expect(docs.map((d) => d.meta.title)).toEqual(['正定古城']);
  });

  it('边界:cos 恰等于 minScore 保留', async () => {
    const docs = await makeService(1).retrieve('正定古城怎么玩');
    expect(docs.map((d) => d.meta.title)).toEqual(['正定古城']);
  });

  it('全部被过滤 → 返回空且不算降级(ragDegraded 不变),走"无资料"提示路径', async () => {
    const service = makeService(0.9);
    // 唯一候选与 query 正交 → 全过滤
    (service as unknown as { store: VectorStore }).store = {
      size: 1,
      searchByText: async () => [doc('无关', '完全无关的内容')],
    };
    const docs = await service.retrieve('今天股票涨了吗');
    expect(docs).toEqual([]);
    expect(service.isDegraded).toBe(false);
    expect(warns).toHaveLength(0);
  });

  it('minScore=0 关闭阈值:不重算候选向量,结果原样返回', async () => {
    const embedCalls: string[][] = [];
    const spy = {
      name: 'fake',
      embed: async (texts: string[]) => {
        embedCalls.push(texts);
        return texts.map(() => [1, 0]);
      },
    } as unknown as LLMProvider;
    const config = { rag: { minScore: 0, topK: 5 } } as unknown as AppConfig;
    const service = new RagService(spy, config);
    const store = new FakeStore();
    store.searchByText = async (_q, embedder) => {
      await embedder?.(['正定古城']); // 模拟真实 store 的 query/候选 embed
      return [doc('正定古城', '正定古城'), doc('无关', '完全无关的内容')];
    };
    (service as unknown as { store: VectorStore }).store = store;

    const docs = await service.retrieve('任意问题');
    expect(docs).toHaveLength(2);
    // 关闭时服务层不再批量 embed 候选文本
    expect(embedCalls).toEqual([['正定古城']]);
  });

  it('重算向量失败 → 按既有逻辑降级返回空', async () => {
    const failing: Partial<LLMProvider> = {
      name: 'fake',
      embed: async (texts: string[]) => {
        if (texts.length > 1) throw new Error('embed down');
        return texts.map(() => [1, 0]);
      },
    };
    const config = { rag: { minScore: 0.2, topK: 5 } } as unknown as AppConfig;
    const service = new RagService(failing as LLMProvider, config);
    (service as unknown as { store: VectorStore }).store = new FakeStore();

    expect(await service.retrieve('正定古城怎么玩')).toEqual([]);
    expect(service.isDegraded).toBe(true);
  });
});
