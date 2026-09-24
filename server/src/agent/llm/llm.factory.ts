import { Logger } from '@nestjs/common';
import { AppConfig } from '../../config/configuration';
import { LLMProvider } from './llm.types';
import { MockProvider } from './mock.provider';

/** DI token:注入当前生效的 LLMProvider。 */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/**
 * 依据配置构造 LLMProvider。
 * 本迭代仅实现 mock;选择 siliconflow / ollama 时给出明确提示并回退到 mock,
 * 避免运行期才失败,同时不阻塞全链路联调。后续在对应 case 接入真实实现即可。
 */
export function createLLMProvider(config: AppConfig): LLMProvider {
  const logger = new Logger('LLMFactory');
  switch (config.llm.provider) {
    case 'mock':
      return new MockProvider();
    case 'siliconflow':
    case 'ollama':
      logger.warn(
        `provider="${config.llm.provider}" 尚未在本迭代实现,临时回退到 MockProvider。`,
      );
      return new MockProvider();
    default:
      return new MockProvider();
  }
}
