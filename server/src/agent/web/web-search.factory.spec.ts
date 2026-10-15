import { createWebSearch } from './web-search.factory';
import type { AppConfig } from '../../config/configuration';

// 真实引擎经 mock fetch 驱动,不断言解析细节(见 duckduckgo.web.spec)。
jest.mock('./duckduckgo.web', () => ({
  duckduckgoWebSearch: jest.fn(async (q: string) => `DDG:${q}`),
}));

const webCfg = (over: Partial<AppConfig['web']> = {}): AppConfig['web'] => ({
  provider: 'mock',
  topK: 3,
  timeoutMs: 8000,
  ...over,
});

describe('createWebSearch', () => {
  it('provider=mock 走占位数据源,含"示例数据"文案', async () => {
    const search = createWebSearch(webCfg({ provider: 'mock' }));
    const out = await search('正定古城');
    expect(out).toContain('示例数据');
  });

  it('provider=duckduckgo 委托真实引擎', async () => {
    const search = createWebSearch(webCfg({ provider: 'duckduckgo' }));
    const out = await search('正定古城');
    expect(out).toBe('DDG:正定古城');
  });
});
