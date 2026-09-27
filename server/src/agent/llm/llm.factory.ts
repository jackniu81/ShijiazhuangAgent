import { Logger } from '@nestjs/common';
import { AppConfig, LlmProviderName } from '../../config/configuration';
import { FallbackProvider } from './fallback.provider';
import { LLMProvider } from './llm.types';
import { MockProvider } from './mock.provider';
import { OllamaProvider } from './ollama.provider';
import { SiliconFlowProvider } from './siliconflow.provider';

/** DI token:注入当前生效的 LLMProvider。 */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** 降级次序按 issue #60 定档:云端 → 本地 → 模板兜底。 */
const FALLBACK_ORDER: LlmProviderName[] = ['siliconflow', 'ollama', 'mock'];

/**
 * 依据配置构造 LLMProvider(issue #8)。
 * issue #27:选 siliconflow 但缺 SILICONFLOW_API_KEY 时打 warn 并放弃该家;
 * 非法选型名同样回退 mock,保证开箱即用(无 Key 也能启动验收)。
 * issue #60:真实厂商之上再叠一层运行期降级链(siliconflow → ollama → mock),
 * 主 provider 挂掉时逐个改投备选,mock 兜底让 demo 永不变砖。`LLM_FALLBACK=0` 关闭。
 */
export function createLLMProvider(config: AppConfig): LLMProvider {
  const logger = new Logger('LLMFactory');
  const requested = normalizeProvider(config.llm.provider, logger);
  // 选型即 mock = 明确的离线意图,不拉真 provider;关降级时行为与 #27 完全一致
  if (requested === 'mock' || !config.llm.fallback.enabled) {
    return createOne(requested, config, logger);
  }

  const chain = buildChain(requested, config, logger);
  if (chain.length === 1) return chain[0];
  logger.log(
    `LLM 降级链:${chain.map((p) => p.name).join(' → ')}(连续 ${config.llm.fallback.circuitFailures} 次失败即熔断 ${config.llm.fallback.circuitCooldownMs}ms)`,
  );
  return new FallbackProvider(chain, config.llm.fallback);
}

function normalizeProvider(name: LlmProviderName, logger: Logger): LlmProviderName {
  if (FALLBACK_ORDER.includes(name)) return name;
  logger.warn(`LLM_PROVIDER="${String(name)}" 不是合法取值(mock|siliconflow|ollama),已回退 mock。`);
  return 'mock';
}

/** 链首为当前选型,其余按定档次序补齐;mock 恒在链尾兜底。 */
function buildChain(requested: LlmProviderName, config: AppConfig, logger: Logger): LLMProvider[] {
  const order = [requested, ...FALLBACK_ORDER.filter((n) => n !== requested)];
  const chain: LLMProvider[] = [];
  for (const name of order) {
    const provider = createOne(name, config, logger);
    // 配置不全时 createOne 会回退成 mock,这种成员不算该厂商可用
    if (name !== 'mock' && provider.name !== name) {
      logger.log(`降级链跳过 ${name}(配置不全)`);
      continue;
    }
    chain.push(provider);
  }
  return chain;
}

/** 按厂商名单独构造一家(选型与降级链共用)。 */
function createOne(name: LlmProviderName, config: AppConfig, logger: Logger): LLMProvider {
  const { timeoutMs, siliconflow, ollama } = config.llm;
  switch (name) {
    case 'siliconflow': {
      if (!siliconflow.apiKey) {
        logger.warn('LLM_PROVIDER=siliconflow 但未配置 SILICONFLOW_API_KEY,已自动回退 mock。请参考 server/.env.example 补全后重启。');
        return new MockProvider();
      }
      logger.log(`LLM provider=siliconflow,chat=${siliconflow.chatModel},embed=${siliconflow.embedModel}`);
      return new SiliconFlowProvider({ ...siliconflow, timeoutMs });
    }
    case 'ollama':
      logger.log(`LLM provider=ollama,chat=${ollama.chatModel},embed=${ollama.embedModel}`);
      return new OllamaProvider({ ...ollama, timeoutMs });
    case 'mock':
    default:
      return new MockProvider();
  }
}
