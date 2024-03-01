import { MonitorModule } from 'src/monitor/monitor.module';
import { Module } from '@nestjs/common';
import { UnderwriterService } from './underwriter.service';
import { WalletModule } from 'src/wallet/wallet.module';
import { UnderwriterController } from './underwriter.controller';

@Module({
    controllers: [UnderwriterController],
    providers: [UnderwriterService],
    imports: [MonitorModule, WalletModule],
})
export class UnderwriterModule {}
