import { Logger } from '@nestjs/common';
import { AppConfig } from '../../config/configuration';
import { LLMProvider } from './llm.types';
import { MockProvider } from './mock.provider';
import { OllamaProvider } from './ollama.provider';
import { SiliconFlowProvider } from './siliconflow.provider';

/** DI token:注入当前生效的 LLMProvider。 */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/**
 * 依据配置构造 LLMProvider(issue #8)。
 * 选型非法或缺关键配置(如 SILICONFLOW_API_KEY)时启动即抛清晰错误,
 * 不静默回退 mock,避免部署环境与开发环境行为不一致。
 */
export function createLLMProvider(config: AppConfig): LLMProvider {
  const logger = new Logger('LLMFactory');
  const { provider, timeoutMs, siliconflow, ollama } = config.llm;
  switch (provider) {
    case 'mock':
      return new MockProvider();
    case 'siliconflow': {
      const p = new SiliconFlowProvider({ ...siliconflow, timeoutMs });
      logger.log(`LLM provider=siliconflow,chat=${siliconflow.chatModel},embed=${siliconflow.embedModel}`);
      return p;
    }
    case 'ollama': {
      logger.log(`LLM provider=ollama,chat=${ollama.chatModel},embed=${ollama.embedModel}`);
      return new OllamaProvider({ ...ollama, timeoutMs });
    }
    default:
      return new MockProvider();
  }
}
