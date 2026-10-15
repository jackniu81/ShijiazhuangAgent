import { duckduckgoWebSearch, parseDuckDuckGoHtml } from './duckduckgo.web';

// jest-runtime 无法 require 纯 ESM 的 @nestjs/common;仅需 Logger。
jest.mock('@nestjs/common', () => ({
  Logger: class {
    log(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  },
}));

/** DDG HTML 结果页节选:两条结果,链接为重定向 uddg,摘要含内嵌标签与实体。 */
const FIXTURE = `
<div class="result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sjz.com%2Fgucheng&rut=aaa">正定古城_官网</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sjz.com%2Fgucheng">正定古城位于<b>石家庄</b>,夜景很美&hellip;</a>
</div>
<div class="result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.sjz.com%2Fp%3Fid%3D1&rut=bbb">门票&amp;开放时间</a>
  </h2>
  <a class="result__snippet" href="#">隆兴寺门票 50 元,开放 08:30 至 17:00</a>
</div>
`;

describe('parseDuckDuckGoHtml', () => {
  it('解析标题/真实 URL(uddg 解码)/摘要,并去内嵌标签与反转义实体', () => {
    const results = parseDuckDuckGoHtml(FIXTURE);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: '正定古城_官网',
      url: 'https://www.sjz.com/gucheng',
      snippet: '正定古城位于石家庄,夜景很美…',
    });
    expect(results[1].title).toBe('门票&开放时间');
    expect(results[1].url).toBe('https://news.sjz.com/p?id=1');
  });

  it('空 HTML 返回空数组', () => {
    expect(parseDuckDuckGoHtml('')).toEqual([]);
  });
});

describe('duckduckgoWebSearch', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('2xx 时把结果格式化为文本块,并受 topK 截断', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, text: async () => FIXTURE }) as unknown as typeof fetch;
    const out = await duckduckgoWebSearch('正定古城', { topK: 1, timeoutMs: 8000 });
    expect(out).toContain('【网站查询】关于「正定古城」');
    expect(out).toContain('正定古城_官网 (https://www.sjz.com/gucheng)');
    // topK=1 只保留首条,第二条 URL 不应出现
    expect(out).not.toContain('news.sjz.com');
  });

  it('非 2xx 降级为"未找到"文案,不抛错', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 418, text: async () => '' }) as unknown as typeof fetch;
    const out = await duckduckgoWebSearch('q', { topK: 3, timeoutMs: 8000 });
    expect(out).toBe('未找到关于「q」的联网信息。');
  });

  it('fetch 抛错(网络/超时)降级为"未找到"文案,不向上抛', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const out = await duckduckgoWebSearch('q', { topK: 3, timeoutMs: 8000 });
    expect(out).toBe('未找到关于「q」的联网信息。');
  });

  it('解析到 0 条结果时降级为"未找到"文案', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, text: async () => '<div>无结果</div>' }) as unknown as typeof fetch;
    const out = await duckduckgoWebSearch('q', { topK: 3, timeoutMs: 8000 });
    expect(out).toBe('未找到关于「q」的联网信息。');
  });

  it('空 query 或 topK<=0 直接返回"未找到",不发请求', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await duckduckgoWebSearch('   ', { topK: 3, timeoutMs: 8000 })).toContain('未找到');
    expect(await duckduckgoWebSearch('q', { topK: 0, timeoutMs: 8000 })).toContain('未找到');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// live 冒烟(默认跳过):WEB_SEARCH_LIVE_TEST=1 时真实连 DuckDuckGo 断言解析生效
(process.env.WEB_SEARCH_LIVE_TEST === '1' ? describe : describe.skip)(
  'duckduckgoWebSearch — live',
  () => {
    it('真实网络返回含结果的文本', async () => {
      const out = await duckduckgoWebSearch('石家庄 正定古城', { topK: 3, timeoutMs: 10000 });
      expect(out).toContain('【网站查询】');
    }, 15000);
  },
);
