/**
 * jest-runtime 无法 require @nestjs/* 纯 ESM 包(同 agent.gateway.spec.ts 的处理),
 * 故打桩 Logger 并把 warn 收集到数组里断言。
 */
const warns: string[] = [];
jest.mock('@nestjs/common', () => ({
  Logger: class {
    log(): void {}
    warn(msg: string): void {
      warns.push(msg);
    }
    error(): void {}
    debug(): void {}
  },
}));

import { buildAppConfig, AppConfig } from '../../config/configuration';
import { createLLMProvider } from './llm.factory';
import { FallbackProvider } from './fallback.provider';
import { MockProvider } from './mock.provider';
import { SiliconFlowProvider } from './siliconflow.provider';

/** 用给定环境变量走真实配置链路构造 AppConfig。 */
function configOf(env: NodeJS.ProcessEnv) {
  return buildAppConfig(env);
}

describe('createLLMProvider (issue #8/#27/#60)', () => {
  beforeEach(() => warns.splice(0, warns.length));

  it('默认(mock)构造 MockProvider,不打 warn', () => {
    expect(createLLMProvider(configOf({}))).toBeInstanceOf(MockProvider);
    expect(warns).toHaveLength(0);
  });

  it('选型即 mock 时不拉真实厂商(离线意图)', () => {
    const p = createLLMProvider(
      configOf({ LLM_PROVIDER: 'mock', SILICONFLOW_API_KEY: 'sk-test' }),
    );
    expect(p).toBeInstanceOf(MockProvider);
    expect(p.name).toBe('mock');
  });

  it('非法选型名 → 回退 mock 并打 warn', () => {
    const config = {
      ...configOf({}),
      llm: { ...configOf({}).llm, provider: 'gpt9' as AppConfig['llm']['provider'] },
    };
    expect(createLLMProvider(config)).toBeInstanceOf(MockProvider);
    expect(warns).toHaveLength(1);
  });

  describe('降级链(issue #60)', () => {
    it('siliconflow + Key → 包成 siliconflow → ollama → mock 链,链首仍是选型', () => {
      const p = createLLMProvider(
        configOf({ LLM_PROVIDER: 'siliconflow', SILICONFLOW_API_KEY: 'sk-test' }),
      );
      expect(p).toBeInstanceOf(FallbackProvider);
      expect(p.name).toBe('siliconflow');
      expect(p.activeProvider?.()).toBe('siliconflow');
      // #27 的"有 Key 就该静默"口径保持
      expect(warns).toHaveLength(0);
    });

    it('ollama 选型 → ollama → mock 链(本地挂了仍有模板兜底)', () => {
      const p = createLLMProvider(configOf({ LLM_PROVIDER: 'ollama' }));
      expect(p).toBeInstanceOf(FallbackProvider);
      expect(p.name).toBe('ollama');
    });

    it('siliconflow 缺 Key → 跳过该家,#27 的 warn 保留并顺延到 ollama', () => {
      const p = createLLMProvider(configOf({ LLM_PROVIDER: 'siliconflow' }));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('SILICONFLOW_API_KEY');
      expect(p).toBeInstanceOf(FallbackProvider);
      expect(p.name).toBe('ollama');
    });

    it('缺 Key 且关掉降级 → 与 #27 完全一致地落到 MockProvider', () => {
      const p = createLLMProvider(
        configOf({ LLM_PROVIDER: 'siliconflow', LLM_FALLBACK: '0' }),
      );
      expect(p).toBeInstanceOf(MockProvider);
      expect(warns).toHaveLength(1);
    });

    it('LLM_FALLBACK=0 → 不包链,行为与改动前一致', () => {
      const p = createLLMProvider(
        configOf({ LLM_PROVIDER: 'siliconflow', SILICONFLOW_API_KEY: 'sk-test', LLM_FALLBACK: '0' }),
      );
      expect(p).toBeInstanceOf(SiliconFlowProvider);
    });

    it('阈值与冷却可配,并透传给熔断器', async () => {
      const config = configOf({
        LLM_PROVIDER: 'siliconflow',
        SILICONFLOW_API_KEY: 'sk-test',
        LLM_CIRCUIT_FAILURES: '7',
        LLM_CIRCUIT_COOLDOWN_MS: '5000',
      });
      expect(config.llm.fallback).toEqual({ enabled: true, circuitFailures: 7, circuitCooldownMs: 5000 });
      const p = createLLMProvider(config);
      // ollama 未运行 → 走完整链后由 mock 承接,链不为断链而中断
      expect(p).toBeInstanceOf(FallbackProvider);
      expect(await p.chat([{ role: 'user', content: '你好' }])).toContain('石家庄');
      expect(p.activeProvider?.()).toBe('mock');
    });
  });
});
