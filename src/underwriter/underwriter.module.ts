import { Module } from '@nestjs/common';
import { UnderwriterService } from './underwriter.service';

@Module({
  providers: [UnderwriterService],
  imports: [],
})
export class UnderwriterModule {}
