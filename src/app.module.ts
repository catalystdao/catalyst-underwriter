import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { LoggerModule } from './config/logger/logger.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
