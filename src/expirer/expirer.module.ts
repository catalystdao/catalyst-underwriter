import { Module } from '@nestjs/common';
import { ExpirerService } from './expirer.service';
import { WalletModule } from 'src/wallet/wallet.module';

@Module({
  providers: [ExpirerService],
  imports: [WalletModule],
})
export class ExpirerModule {}
