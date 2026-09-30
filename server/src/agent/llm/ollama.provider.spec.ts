/** jest-runtime 无法 require @nestjs/* 纯 ESM 包(同 llm.factory.spec.ts),故打桩 Logger;本模块走静态调用。 */
const loggerWarns: string[] = [];
jest.mock('@nestjs/common', () => ({
  Logger: class {
    static log(): void {}
    static warn(msg: string): void {
      loggerWarns.push(String(msg));
    }
    log(): void {}
    warn(msg: string): void {
      loggerWarns.push(String(msg));
    }
  },
}));

import { OllamaProvider } from './ollama.provider';

/** 打桩全局 fetch,捕获请求体供断言(issue #86:生成参数透传到 Ollama 请求体)。 */
function mockFetch(responder: (body: any) => Response) {
  const bodies: any[] = [];
  const original = global.fetch;
  global.fetch = (async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    return responder(body);
  }) as typeof fetch;
  return {
    bodies,
    restore: () => {
      global.fetch = original;
    },
  };
}

const opts = { baseUrl: 'http://x', chatModel: 'm', embedModel: 'e', timeoutMs: 1000 };

describe('OllamaProvider 生成参数透传 (issue #86)', () => {
  it('chat 请求体带 options.temperature / options.num_predict', async () => {
    const m = mockFetch(
      () => new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 }),
    );
    try {
      const p = new OllamaProvider(opts);
      const out = await p.chat([{ role: 'user', content: 'hi' }], { temperature: 0.2, maxTokens: 4096 });
      expect(out).toBe('ok');
      expect(m.bodies[0].stream).toBe(false);
      expect(m.bodies[0].options).toEqual({ temperature: 0.2, num_predict: 4096 });
    } finally {
      m.restore();
    }
  });

  it('stream 请求体同样携带 options,且保留 stream: true', async () => {
    const ndjson = '{"message":{"content":"你"},"done":false}\n{"message":{},"done":true}\n';
    const m = mockFetch(() => new Response(ndjson, { status: 200 }));
    try {
      const p = new OllamaProvider(opts);
      const tokens: string[] = [];
      const full = await p.stream([{ role: 'user', content: 'hi' }], (t) => tokens.push(t), {
        temperature: 0.7,
        maxTokens: 2048,
      });
      expect(full).toBe('你');
      expect(m.bodies[0].stream).toBe(true);
      expect(m.bodies[0].options).toEqual({ temperature: 0.7, num_predict: 2048 });
    } finally {
      m.restore();
    }
  });

  it('未传 options 时请求体不含 options 字段(保持旧行为)', async () => {
    const m = mockFetch(
      () => new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 }),
    );
    try {
      const p = new OllamaProvider(opts);
      await p.chat([{ role: 'user', content: 'hi' }]);
      expect(m.bodies[0].options).toBeUndefined();
    } finally {
      m.restore();
    }
  });
});

// ────────────────────────────────────────────────────────────
// JSON 强约束(issue #87):jsonMode → /api/chat 请求体 format: 'json'
// ────────────────────────────────────────────────────────────

describe('OllamaProvider JSON 强约束 (issue #87)', () => {
  it('chat 开启 jsonMode → 请求体带 format: json,且不影响 options 生成参数', async () => {
    const m = mockFetch(
      () => new Response(JSON.stringify({ message: { content: '{"days":[]}' } }), { status: 200 }),
    );
    try {
      const p = new OllamaProvider(opts);
      const out = await p.chat([{ role: 'user', content: 'hi' }], {
        temperature: 0.2,
        maxTokens: 4096,
        jsonMode: true,
      });
      expect(out).toBe('{"days":[]}');
      expect(m.bodies[0].format).toBe('json');
      expect(m.bodies[0].options).toEqual({ temperature: 0.2, num_predict: 4096 });
    } finally {
      m.restore();
    }
  });

  it('stream 即使传 jsonMode 也不注入 format(流式保持纯文本增量)', async () => {
    const ndjson = '{"message":{"content":"你"},"done":false}\n{"message":{},"done":true}\n';
    const m = mockFetch(() => new Response(ndjson, { status: 200 }));
    try {
      const p = new OllamaProvider(opts);
      const tokens: string[] = [];
      await p.stream([{ role: 'user', content: 'hi' }], (t) => tokens.push(t), { jsonMode: true });
      expect(m.bodies[0].stream).toBe(true);
      expect(m.bodies[0].format).toBeUndefined();
    } finally {
      m.restore();
    }
  });

  it('未开启 jsonMode 的 chat 请求体不含 format 字段', async () => {
    const m = mockFetch(
      () => new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 }),
    );
    try {
      const p = new OllamaProvider(opts);
      await p.chat([{ role: 'user', content: 'hi' }], { temperature: 0.7 });
      expect(m.bodies[0].format).toBeUndefined();
    } finally {
      m.restore();
    }
  });
});

// ────────────────────────────────────────────────────────────
// embed 批量调用(issue #93):/api/embed 一次多条,旧版回退逐条 /api/embeddings
// ────────────────────────────────────────────────────────────

/** 打桩 fetch 并记录 (url, body),用于区分批量/逐条两条路径;/api/version 为 GET 无 body。 */
function mockFetchRoutes(responder: (url: string, body: any) => Response) {
  const calls: Array<{ url: string; body: any }> = [];
  const original = global.fetch;
  global.fetch = (async (url: unknown, init: any) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: String(url), body });
    return responder(String(url), body);
  }) as typeof fetch;
  return {
    calls,
    urls: () => calls.map((c) => c.url),
    restore: () => {
      global.fetch = original;
    },
  };
}

const batchOk = (inputs: string[]) =>
  new Response(
    JSON.stringify({ embeddings: inputs.map((t) => [t.length, 0.5]) }),
    { status: 200 },
  );

describe('OllamaProvider embed 批量 (issue #93)', () => {
  beforeEach(() => loggerWarns.splice(0));

  it('多条文本只发一次 /api/embed,input 为完整数组,返回顺序与入参一致', async () => {
    const m = mockFetchRoutes(() => batchOk(['a', 'bb', 'ccc']));
    try {
      const p = new OllamaProvider(opts);
      const vecs = await p.embed(['a', 'bb', 'ccc']);
      expect(m.urls()).toEqual(['http://x/api/embed']);
      expect(m.calls[0].body).toEqual({ model: 'e', input: ['a', 'bb', 'ccc'] });
      expect(vecs).toEqual([[1, 0.5], [2, 0.5], [3, 0.5]]);
    } finally {
      m.restore();
    }
  });

  it('超过 embedBatchSize 时分块,HTTP 往返 = ceil(N/批大小)', async () => {
    const m = mockFetchRoutes((_u, body) => batchOk(body.input as string[]));
    try {
      const p = new OllamaProvider({ ...opts, embedBatchSize: 2 });
      const vecs = await p.embed(['a', 'b', 'c', 'd']);
      expect(m.urls()).toEqual(['http://x/api/embed', 'http://x/api/embed']);
      expect(m.calls.map((c) => c.body.input)).toEqual([['a', 'b'], ['c', 'd']]);
      expect(vecs.length).toBe(4);
    } finally {
      m.restore();
    }
  });

  it('未配置 embedBatchSize 时默认每批 64 条', async () => {
    const m = mockFetchRoutes((_u, body) => batchOk(body.input as string[]));
    try {
      const p = new OllamaProvider(opts);
      const texts = Array.from({ length: 130 }, (_, i) => `t${i}`);
      const vecs = await p.embed(texts);
      expect(m.calls.map((c) => c.body.input.length)).toEqual([64, 64, 2]);
      expect(vecs.length).toBe(texts.length);
    } finally {
      m.restore();
    }
  });

  it('空入参不发起任何请求', async () => {
    const m = mockFetchRoutes(() => batchOk([]));
    try {
      expect(await new OllamaProvider(opts).embed([])).toEqual([]);
      expect(m.calls.length).toBe(0);
    } finally {
      m.restore();
    }
  });

  it('旧版 Ollama(版本 < 0.9.2):批量 404 → 逐条回退,且只试一次批量', async () => {
    const m = mockFetchRoutes((url) =>
      url.endsWith('/api/embed')
        ? new Response('not found', { status: 404 })
        : url.endsWith('/api/version')
          ? new Response(JSON.stringify({ version: '0.9.1' }), { status: 200 })
          : new Response(JSON.stringify({ embedding: [1, 2] }), { status: 200 }),
    );
    try {
      const p = new OllamaProvider({ ...opts, embedBatchSize: 2 });
      expect(await p.embed(['a', 'b', 'c', 'd'])).toEqual([
        [1, 2],
        [1, 2],
        [1, 2],
        [1, 2],
      ]);
      expect(m.urls().filter((u) => u.endsWith('/api/embed'))).toHaveLength(1);
      expect(m.urls().filter((u) => u.endsWith('/api/embeddings'))).toHaveLength(4);
      expect(m.urls().filter((u) => u.endsWith('/api/version'))).toHaveLength(1);
      expect(loggerWarns.join('\n')).toContain('已回退逐条 /api/embeddings');
      // 第二次调用记住降级,不再试批量、也不再探版本
      await p.embed(['e']);
      expect(m.urls().filter((u) => u.endsWith('/api/embed'))).toHaveLength(1);
      expect(m.urls().filter((u) => u.endsWith('/api/version'))).toHaveLength(1);
    } finally {
      m.restore();
    }
  });

  it('新版 Ollama 上的 404(多为模型未 pull)不回退,原样抛出便于定位配置错误', async () => {
    const m = mockFetchRoutes((url) =>
      url.endsWith('/api/version')
        ? new Response(JSON.stringify({ version: '0.12.3' }), { status: 200 })
        : new Response('model not found', { status: 404 }),
    );
    try {
      const p = new OllamaProvider(opts);
      await expect(p.embed(['a', 'b'])).rejects.toThrow(/404/);
      expect(m.urls().filter((u) => u.endsWith('/api/embeddings'))).toHaveLength(0);
      expect(loggerWarns.join('\n')).toBe('');
    } finally {
      m.restore();
    }
  });

  it('取不到 /api/version 时按旧版处理(更老实现无该路由)', async () => {
    const m = mockFetchRoutes((url) =>
      url.endsWith('/api/embed')
        ? new Response('not found', { status: 404 })
        : url.endsWith('/api/version')
          ? new Response('no such route', { status: 404 })
          : new Response(JSON.stringify({ embedding: [3] }), { status: 200 }),
    );
    try {
      const p = new OllamaProvider(opts);
      expect(await p.embed(['a', 'b'])).toEqual([[3], [3]]);
    } finally {
      m.restore();
    }
  });

  it('批量 405 → 直接回退逐条,不探版本', async () => {
    const m = mockFetchRoutes((url) =>
      url.endsWith('/api/embed')
        ? new Response('method not allowed', { status: 405 })
        : new Response(JSON.stringify({ embedding: [7] }), { status: 200 }),
    );
    try {
      const p = new OllamaProvider(opts);
      expect(await p.embed(['a', 'b'])).toEqual([[7], [7]]);
      expect(m.urls().filter((u) => u.endsWith('/api/version'))).toHaveLength(0);
    } finally {
      m.restore();
    }
  });

  it('批量返回条数与入参不符 → 同样回退逐条,不返回残缺结果', async () => {
    const m = mockFetchRoutes((url) =>
      url.endsWith('/api/embed')
        ? new Response(JSON.stringify({ embeddings: [[1]] }), { status: 200 })
        : new Response(JSON.stringify({ embedding: [9] }), { status: 200 }),
    );
    try {
      const p = new OllamaProvider(opts);
      expect(await p.embed(['a', 'b'])).toEqual([[9], [9]]);
      expect(m.urls().filter((u) => u.endsWith('/api/embeddings'))).toHaveLength(2);
    } finally {
      m.restore();
    }
  });

  it('批量 5xx 视为临时故障:重试一次后抛出,不回退逐条', async () => {
    const m = mockFetchRoutes(() => new Response('boom', { status: 500 }));
    try {
      const p = new OllamaProvider(opts);
      await expect(p.embed(['a'])).rejects.toThrow(/500/);
      expect(m.urls()).toEqual(['http://x/api/embed', 'http://x/api/embed']);
      expect(m.urls().filter((u) => u.endsWith('/api/embeddings'))).toHaveLength(0);
    } finally {
      m.restore();
    }
  });

  // 实测本机 ollama serve 未开 --embeddings 时 /api/embed 回 501,走同一 5xx 分支:
  // 显式失败并提示服务端配置,不会静默降级到同样不支持的逐条路径
  it('批量 501(服务端未启用 embeddings)→ 按 5xx 抛出,不回退逐条', async () => {
    const m = mockFetchRoutes(() =>
      new Response(JSON.stringify({ error: 'This server does not support embeddings.' }), { status: 501 }),
    );
    try {
      const p = new OllamaProvider(opts);
      await expect(p.embed(['a', 'b'])).rejects.toThrow(/501/);
      expect(m.urls().filter((u) => u.endsWith('/api/embeddings'))).toHaveLength(0);
    } finally {
      m.restore();
    }
  });

  it('逐条路径返回结构异常 → 不可重试错误直接抛出', async () => {
    const m = mockFetchRoutes((url) =>
      url.endsWith('/api/embed')
        ? new Response('not found', { status: 404 })
        : url.endsWith('/api/version')
          ? new Response(JSON.stringify({ version: '0.9.1' }), { status: 200 })
          : new Response(JSON.stringify({ foo: 1 }), { status: 200 }),
    );
    try {
      const p = new OllamaProvider(opts);
      await expect(p.embed(['a'])).rejects.toThrow('Ollama embedding 返回结构异常');
      expect(m.urls().filter((u) => u.endsWith('/api/embeddings'))).toHaveLength(1);
    } finally {
      m.restore();
    }
  });
});

// ────────────────────────────────────────────────────────────
// live 集成(env gate,issue #93):默认跳过,OLLAMA_LIVE_TEST=1 时连本机 Ollama 校验
// 前置:ollama serve 已启动,且 OLLAMA_EMBED_MODEL(默认 bge-m3)已 pull
// ────────────────────────────────────────────────────────────
const liveEnabled = process.env.OLLAMA_LIVE_TEST === '1';
const describeLive = liveEnabled ? describe : describe.skip;

describeLive('OllamaProvider embed 批量 live 一致性 (#93)', () => {
  jest.setTimeout(180_000);

  const liveOpts = {
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    chatModel: process.env.OLLAMA_CHAT_MODEL ?? 'qwen2.5:7b',
    embedModel: process.env.OLLAMA_EMBED_MODEL ?? 'bge-m3',
    timeoutMs: 180_000,
    embedBatchSize: 64,
  };

  it('一次批量与逐条(批大小 1)向量一致,且往返数降为 ceil(N/批大小)', async () => {
    const texts = ['正定古城隆兴寺', '苍岩山桥楼殿', '驼梁自然风景区'];
    const batched = await new OllamaProvider(liveOpts).embed(texts);
    const oneByOne = await new OllamaProvider({ ...liveOpts, embedBatchSize: 1 }).embed(texts);

    expect(batched.length).toBe(texts.length);
    batched.forEach((vec, i) => {
      expect(vec.length).toBe(oneByOne[i].length);
      vec.forEach((v, j) => expect(v).toBeCloseTo(oneByOne[i][j], 6));
    });
  });
});
