import { Module } from '@nestjs/common';
import { ExpirerService } from './expirer.service';
import { WalletModule } from 'src/wallet/wallet.module';
import { MonitorModule } from 'src/monitor/monitor.module';

@Module({
  providers: [ExpirerService],
  imports: [MonitorModule, WalletModule],
})
export class ExpirerModule {}
