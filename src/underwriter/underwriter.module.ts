import { Module } from '@nestjs/common';
import { UnderwriterService } from './underwriter.service';
import { WalletModule } from 'src/wallet/wallet.module';

@Module({
  providers: [UnderwriterService],
  imports: [WalletModule],
})
export class UnderwriterModule {}
