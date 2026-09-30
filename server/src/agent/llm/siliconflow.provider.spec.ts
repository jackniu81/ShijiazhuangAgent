import { SiliconFlowProvider } from './siliconflow.provider';

/** 打桩全局 fetch,捕获请求体供断言(issue #87:JSON 强约束透传到请求体)。 */
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

const opts = {
  apiKey: 'k',
  baseUrl: 'http://x/v1',
  chatModel: 'm',
  embedModel: 'e',
  timeoutMs: 1000,
};

describe('SiliconFlowProvider JSON 强约束 (issue #87)', () => {
  it('chat 开启 jsonMode → 请求体带 response_format: {type: json_object}', async () => {
    const m = mockFetch(
      () => new Response(JSON.stringify({ choices: [{ message: { content: '{"days":[]}' } }] }), { status: 200 }),
    );
    try {
      const p = new SiliconFlowProvider(opts);
      const out = await p.chat([{ role: 'user', content: 'hi' }], { jsonMode: true });
      expect(out).toBe('{"days":[]}');
      expect(m.bodies[0].response_format).toEqual({ type: 'json_object' });
    } finally {
      m.restore();
    }
  });

  it('stream 即使传 jsonMode 也不注入 response_format(流式保持纯文本增量)', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"你"}}]}\ndata: [DONE]\n\n';
    const m = mockFetch(() => new Response(sse, { status: 200 }));
    try {
      const p = new SiliconFlowProvider(opts);
      const tokens: string[] = [];
      const full = await p.stream([{ role: 'user', content: 'hi' }], (t) => tokens.push(t), {
        jsonMode: true,
      });
      expect(full).toBe('你');
      expect(m.bodies[0].stream).toBe(true);
      expect(m.bodies[0].response_format).toBeUndefined();
    } finally {
      m.restore();
    }
  });

  it('未开启 jsonMode 的 chat 请求体不含 response_format(保持旧行为)', async () => {
    const m = mockFetch(
      () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );
    try {
      const p = new SiliconFlowProvider(opts);
      await p.chat([{ role: 'user', content: 'hi' }], { temperature: 0.7 });
      expect(m.bodies[0].response_format).toBeUndefined();
      expect(m.bodies[0].temperature).toBe(0.7);
    } finally {
      m.restore();
    }
  });

  it('jsonMode 与温度/token 参数共存,不影响既有字段', async () => {
    const m = mockFetch(
      () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 }),
    );
    try {
      const p = new SiliconFlowProvider(opts);
      await p.chat([{ role: 'user', content: 'hi' }], { temperature: 0.2, maxTokens: 4096, jsonMode: true });
      expect(m.bodies[0]).toMatchObject({
        temperature: 0.2,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      });
    } finally {
      m.restore();
    }
  });
});
