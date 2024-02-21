import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { LoggerModule } from './logger/logger.module';
import { ListenerModule } from './listener/listener.module';
import { UnderwriterModule } from './underwriter/underwriter.module';
import { WalletModule } from './wallet/wallet.module';
import { MonitorModule } from './monitor/monitor.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    MonitorModule,
    ListenerModule,
    WalletModule,
    UnderwriterModule
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
