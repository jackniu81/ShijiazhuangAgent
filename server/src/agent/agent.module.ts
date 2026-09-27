import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { AgentGateway } from './agent.gateway';
import { AgentService } from './agent.service';
import { SESSION_STORE } from './chat/session.store';
import { buildSessionStore } from './chat/session.factory';
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
    // 多轮会话历史:按配置选内存 / Postgres 持久化后端(issue #7 / #29)
    {
      provide: SESSION_STORE,
      useFactory: (config: AppConfig) => buildSessionStore(config),
      inject: [APP_CONFIG],
    },
  ],
})
export class AgentModule {}
