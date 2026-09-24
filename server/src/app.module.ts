import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module';
import { AppConfigModule } from './config/config.module';
import { VersionModule } from './version/version.module';

@Module({
  imports: [
    // 全局配置(.env -> APP_CONFIG),供各模块直接注入
    AppConfigModule,
    VersionModule,
    AgentModule,
  ],
})
export class AppModule {}
