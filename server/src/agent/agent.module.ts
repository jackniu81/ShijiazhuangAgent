import { Module } from '@nestjs/common';
import { AgentGateway } from './agent.gateway';
import { AgentService } from './agent.service';

@Module({
  providers: [AgentGateway, AgentService],
})
export class AgentModule {}
