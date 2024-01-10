import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { LoggerModule } from './logger/logger.module';
import { ListenerModule } from './listener/listener.module';
import { UnderwriterModule } from './underwriter/underwriter.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    ListenerModule,
    UnderwriterModule
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
