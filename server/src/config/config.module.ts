import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { APP_CONFIG, buildAppConfig } from './configuration';

/**
 * 全局配置模块:加载 .env 并以类型化 token APP_CONFIG 暴露合并后的配置,
 * 供任意模块 @Inject(APP_CONFIG) 使用。
 */
@Global()
@Module({
  imports: [NestConfigModule.forRoot({ isGlobal: true, cache: true })],
  providers: [{ provide: APP_CONFIG, useFactory: () => buildAppConfig() }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
