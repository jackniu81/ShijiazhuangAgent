import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module';
import { VersionModule } from './version/version.module';

@Module({
  imports: [VersionModule, AgentModule],
})
export class AppModule {}
