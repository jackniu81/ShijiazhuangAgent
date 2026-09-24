import { Module } from '@nestjs/common';
import { VersionModule } from './version/version.module';

@Module({
  imports: [VersionModule],
})
export class AppModule {}
