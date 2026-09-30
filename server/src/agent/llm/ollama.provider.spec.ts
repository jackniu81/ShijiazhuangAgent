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
