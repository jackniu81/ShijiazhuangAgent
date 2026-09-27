/**
 * jest-runtime 无法 require @nestjs/* 纯 ESM 包(同 llm.factory.spec.ts),打桩 Logger 收集 warn。
 */
const warns: string[] = [];
jest.mock('@nestjs/common', () => ({
  Logger: class {
    log(): void {}
    warn(msg: string): void {
      warns.push(msg);
    }
  },
}));

import { ChatOptions, LLMProvider, Msg } from './llm.types';
import { AbortedError, LLMError } from './http';
import { FallbackProvider } from './fallback.provider';

/** 可编程假厂商:按脚本决定成功文本或抛出异常,并记录被调用次数。 */
class FakeProvider implements LLMProvider {
  chatCalls = 0;
  streamCalls = 0;
  embedCalls = 0;

  constructor(
    readonly name: string,
    private readonly opts: {
      chat?: () => Promise<string>;
      stream?: (onToken: (t: string) => void) => Promise<string>;
      embed?: () => Promise<number[][]>;
    } = {},
  ) {}

  chat(_m: Msg[], _o?: ChatOptions): Promise<string> {
    this.chatCalls += 1;
    return (this.opts.chat ?? pass(`${this.name}:ok`))();
  }

  stream(_m: Msg[], onToken: (t: string) => void, _o?: ChatOptions): Promise<string> {
    this.streamCalls += 1;
    if (this.opts.stream) return this.opts.stream(onToken);
    const text = `${this.name}:stream`;
    onToken(text);
    return Promise.resolve(text);
  }

  embed(_t: string[]): Promise<number[][]> {
    this.embedCalls += 1;
    return (this.opts.embed ?? pass([[1, 2, 3]]))();
  }
}

const pass = <T>(value: T) => () => Promise.resolve(value);
const boom = (err: Error) => () => Promise.reject(err);

function chain(...providers: LLMProvider[]): FallbackProvider {
  return new FallbackProvider(providers, { circuitFailures: 3, circuitCooldownMs: 60_000 });
}

beforeEach(() => {
  warns.splice(0, warns.length);
  jest.restoreAllMocks();
});

describe('FallbackProvider chat 降级', () => {
  it('主厂商正常时不打扰备选,name 仍为链首', async () => {
    const a = new FakeProvider('siliconflow');
    const b = new FakeProvider('ollama');
    const fb = chain(a, b);
    expect(await fb.chat([])).toBe('siliconflow:ok');
    expect(b.chatCalls).toBe(0);
    expect(fb.name).toBe('siliconflow');
    expect(fb.activeProvider()).toBe('siliconflow');
  });

  it('主厂商抛 LLMError → 改投下一家并标注实际承接者', async () => {
    const a = new FakeProvider('siliconflow', { chat: boom(new LLMError('5xx')) });
    const b = new FakeProvider('ollama');
    const fb = chain(a, b);
    expect(await fb.chat([])).toBe('ollama:ok');
    expect(fb.activeProvider()).toBe('ollama');
    expect(warns.some((w) => w.includes('降级承接'))).toBe(true);
  });

  it('非 LLMError 的意外异常也降级,避免整个请求变砖', async () => {
    const a = new FakeProvider('siliconflow', { chat: boom(new TypeError('boom')) });
    const b = new FakeProvider('mock');
    const fb = chain(a, b);
    expect(await fb.chat([])).toBe('mock:ok');
  });

  it('全部失败 → 抛最后一家原始错误,不吞异常', async () => {
    const a = new FakeProvider('siliconflow', { chat: boom(new LLMError('A挂了')) });
    const b = new FakeProvider('ollama', { chat: boom(new LLMError('B也挂了')) });
    const fb = chain(a, b);
    await expect(fb.chat([])).rejects.toThrow('B也挂了');
    expect(a.chatCalls).toBe(1);
    expect(b.chatCalls).toBe(1);
  });

  it('用户取消(AbortedError)不降级,立即中断链', async () => {
    const a = new FakeProvider('siliconflow', { chat: boom(new AbortedError()) });
    const b = new FakeProvider('ollama');
    const fb = chain(a, b);
    await expect(fb.chat([])).rejects.toBeInstanceOf(AbortedError);
    expect(b.chatCalls).toBe(0);
  });
});

describe('FallbackProvider stream 降级', () => {
  it('未产出任何 token 时失败 → 换下一家重放', async () => {
    const a = new FakeProvider('siliconflow', { stream: boom(new LLMError('连不上')) });
    const b = new FakeProvider('ollama');
    const fb = chain(a, b);
    const tokens: string[] = [];
    const full = await fb.stream([], (t) => tokens.push(t));
    expect(full).toBe('ollama:stream');
    expect(tokens).toEqual(['ollama:stream']);
  });

  it('已吐 token 后中途失败 → 不切换(避免前端重复内容),原样抛错', async () => {
    const a = new FakeProvider('siliconflow', {
      stream: (on) => {
        on('半截');
        return Promise.reject(new LLMError('断了'));
      },
    });
    const b = new FakeProvider('ollama');
    const fb = chain(a, b);
    const tokens: string[] = [];
    await expect(fb.stream([], (t) => tokens.push(t))).rejects.toThrow('断了');
    expect(b.streamCalls).toBe(0);
    expect(tokens).toEqual(['半截']);
  });

  it('取消信号沿链中断,不改投备选', async () => {
    const a = new FakeProvider('siliconflow', { stream: boom(new AbortedError()) });
    const b = new FakeProvider('ollama');
    const fb = chain(a, b);
    await expect(fb.stream([], () => undefined)).rejects.toBeInstanceOf(AbortedError);
    expect(b.streamCalls).toBe(0);
  });
});

describe('FallbackProvider embed 不降级', () => {
  it('embedding 恒走链首,备选厂商不被调用', async () => {
    const a = new FakeProvider('siliconflow', { embed: boom(new LLMError('embed 挂了')) });
    const b = new FakeProvider('ollama');
    const fb = chain(a, b);
    await expect(fb.embed(['x'])).rejects.toThrow('embed 挂了');
    expect(b.embedCalls).toBe(0);
  });
});

describe('FallbackProvider 熔断', () => {
  /** 固定时钟:让冷却窗口可判定。 */
  function freeze(nowMs: number): void {
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
  }

  it('连续失败达阈值 → 开熔断,后续请求直接跳过该厂商', async () => {
    freeze(1_000_000);
    const a = new FakeProvider('siliconflow', { chat: boom(new LLMError('5xx')) });
    const b = new FakeProvider('ollama');
    const fb = chain(a, b);

    for (let i = 0; i < 3; i++) await fb.chat([]);
    expect(a.chatCalls).toBe(3);

    // 第 4 次:链首仍在熔断冷却内,不再尝试
    freeze(1_000_000 + 1_000);
    await fb.chat([]);
    expect(a.chatCalls).toBe(3);
    expect(b.chatCalls).toBe(4);
  });

  it('冷却到期 → 放行探测,成功即恢复为链首', async () => {
    freeze(1_000_000);
    let down = true;
    const a = new FakeProvider('siliconflow', {
      chat: () => (down ? Promise.reject(new LLMError('5xx')) : Promise.resolve('siliconflow:ok')),
    });
    const b = new FakeProvider('ollama');
    const fb = chain(a, b);

    for (let i = 0; i < 3; i++) await fb.chat([]);
    expect(fb.activeProvider()).toBe('ollama');

    down = false;
    freeze(1_000_000 + 60_000); // 冷却期满
    expect(await fb.chat([])).toBe('siliconflow:ok');
    expect(fb.activeProvider()).toBe('siliconflow');
  });

  it('中途恢复(未达阈值)→ 失败计数清零,不开熔断', async () => {
    freeze(1_000_000);
    let down = true;
    const a = new FakeProvider('siliconflow', {
      chat: () => (down ? Promise.reject(new LLMError('5xx')) : Promise.resolve('siliconflow:ok')),
    });
    const b = new FakeProvider('ollama');
    const fb = chain(a, b);

    await fb.chat([]); // 失败 1 次
    down = false;
    expect(await fb.chat([])).toBe('siliconflow:ok'); // 成功 → 计数复位
    down = true;
    await fb.chat([]); // 又失败,累计 1 次
    await fb.chat([]); // 仍应优先探测链首,说明没被熔断跳过
    expect(a.chatCalls).toBe(4);
  });

  it('全部厂商都在冷却中 → 放行原次序探测,不至于无处可去', async () => {
    freeze(1_000_000);
    const a = new FakeProvider('siliconflow', { chat: boom(new LLMError('A')) });
    const b = new FakeProvider('ollama', { chat: boom(new LLMError('B')) });
    const fb = chain(a, b);
    // 两家全挂:每轮都走完链后抛错,累计到熔断阈值
    for (let i = 0; i < 3; i++) await expect(fb.chat([])).rejects.toThrow('B');
    freeze(1_000_000 + 1_000);
    await expect(fb.chat([])).rejects.toThrow('B');
    expect(a.chatCalls).toBe(4);
    expect(b.chatCalls).toBe(4);
  });
});

describe('FallbackProvider 构造', () => {
  it('空链直接拒绝构造', () => {
    expect(() => new FallbackProvider([], { circuitFailures: 3, circuitCooldownMs: 1000 })).toThrow();
  });

  it('单一厂商链:activeProvider 即该厂商', async () => {
    const a = new FakeProvider('mock');
    const fb = chain(a);
    expect(await fb.chat([])).toBe('mock:ok');
    expect(fb.activeProvider()).toBe('mock');
  });
});
