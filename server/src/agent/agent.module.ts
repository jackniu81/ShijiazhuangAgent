import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { AgentGateway } from './agent.gateway';
import { AgentService } from './agent.service';
import { SESSION_STORE, SessionStore } from './chat/session.store';
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
    // 多轮会话历史(内存 + TTL,见 issue #7)
    {
      provide: SESSION_STORE,
      useFactory: (config: AppConfig) =>
        new SessionStore({
          maxTurns: config.chat.historyTurns,
          ttlMs: config.chat.sessionTtlMs,
        }),
      inject: [APP_CONFIG],
    },
  ],
})
export class AgentModule {}
