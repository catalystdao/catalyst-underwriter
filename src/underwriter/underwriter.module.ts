import { MonitorModule } from 'src/monitor/monitor.module';
import { Module } from '@nestjs/common';
import { UnderwriterService } from './underwriter.service';
import { WalletModule } from 'src/wallet/wallet.module';

@Module({
    providers: [UnderwriterService],
    imports: [MonitorModule, WalletModule],
})
export class UnderwriterModule {}
