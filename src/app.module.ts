import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { LoggerModule } from './logger/logger.module';
import { ListenerModule } from './listener/listener.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    ListenerModule
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
