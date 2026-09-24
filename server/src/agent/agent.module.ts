import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { AgentGateway } from './agent.gateway';
import { AgentService } from './agent.service';
import { createLLMProvider, LLM_PROVIDER } from './llm/llm.factory';
import { RagService } from './rag/rag.service';

@Module({
  providers: [
    AgentGateway,
    AgentService,
    RagService,
    // 依据配置选择 LLMProvider(本迭代为 mock)
    {
      provide: LLM_PROVIDER,
      useFactory: (config: AppConfig) => createLLMProvider(config),
      inject: [APP_CONFIG],
    },
  ],
})
export class AgentModule {}
