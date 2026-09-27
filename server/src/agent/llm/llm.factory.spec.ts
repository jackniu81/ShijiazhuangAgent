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
import { MockProvider } from './mock.provider';
import { OllamaProvider } from './ollama.provider';
import { SiliconFlowProvider } from './siliconflow.provider';

/** 用给定环境变量走真实配置链路构造 AppConfig。 */
function configOf(env: NodeJS.ProcessEnv) {
  return buildAppConfig(env);
}

describe('createLLMProvider (issue #8/#27)', () => {
  beforeEach(() => warns.splice(0, warns.length));

  it('默认(mock)构造 MockProvider,不打 warn', () => {
    expect(createLLMProvider(configOf({}))).toBeInstanceOf(MockProvider);
    expect(warns).toHaveLength(0);
  });

  it('siliconflow 且有 Key → SiliconFlowProvider', () => {
    const p = createLLMProvider(configOf({ LLM_PROVIDER: 'siliconflow', SILICONFLOW_API_KEY: 'sk-test' }));
    expect(p).toBeInstanceOf(SiliconFlowProvider);
    expect(warns).toHaveLength(0);
  });

  it('siliconflow 缺 Key → 自动回退 MockProvider 并打 warn(issue #27)', () => {
    const p = createLLMProvider(configOf({ LLM_PROVIDER: 'siliconflow' }));
    expect(p).toBeInstanceOf(MockProvider);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('SILICONFLOW_API_KEY');
  });

  it('ollama → OllamaProvider(无需 Key)', () => {
    expect(createLLMProvider(configOf({ LLM_PROVIDER: 'ollama' }))).toBeInstanceOf(OllamaProvider);
    expect(warns).toHaveLength(0);
  });

  it('非法选型名 → 回退 mock 并打 warn', () => {
    const config = { ...configOf({}), llm: { ...configOf({}).llm, provider: 'gpt9' as AppConfig['llm']['provider'] } };
    expect(createLLMProvider(config)).toBeInstanceOf(MockProvider);
    expect(warns).toHaveLength(1);
  });
});
