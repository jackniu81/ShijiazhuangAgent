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
 * issue #27:选 siliconflow 但缺 SILICONFLOW_API_KEY 时,打 warn 日志并自动回退 mock,
 * 保证开箱即用(无 Key 也能启动验收);非法选型名同样回退 mock。
 * 注意:运行期的真实失败降级链(超时/断联→备选 provider)属 #59,不在此处。
 */
export function createLLMProvider(config: AppConfig): LLMProvider {
  const logger = new Logger('LLMFactory');
  const { provider, timeoutMs, siliconflow, ollama } = config.llm;
  switch (provider) {
    case 'mock':
      return new MockProvider();
    case 'siliconflow': {
      if (!siliconflow.apiKey) {
        logger.warn('LLM_PROVIDER=siliconflow 但未配置 SILICONFLOW_API_KEY,已自动回退 mock。请参考 server/.env.example 补全后重启。');
        return new MockProvider();
      }
      const p = new SiliconFlowProvider({ ...siliconflow, timeoutMs });
      logger.log(`LLM provider=siliconflow,chat=${siliconflow.chatModel},embed=${siliconflow.embedModel}`);
      return p;
    }
    case 'ollama': {
      logger.log(`LLM provider=ollama,chat=${ollama.chatModel},embed=${ollama.embedModel}`);
      return new OllamaProvider({ ...ollama, timeoutMs });
    }
    default:
      logger.warn(`LLM_PROVIDER="${String(provider)}" 不是合法取值(mock|siliconflow|ollama),已回退 mock。`);
      return new MockProvider();
  }
}
