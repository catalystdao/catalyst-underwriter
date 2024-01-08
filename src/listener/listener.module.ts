import { Module } from '@nestjs/common';
import { LoggerModule } from 'src/logger/logger.module';
import { ListenerService } from './listener.service';

@Module({
  providers: [ListenerService],
  imports: [LoggerModule],
})
export class ListenerModule {}
