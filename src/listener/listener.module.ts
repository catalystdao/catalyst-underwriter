import { Module } from '@nestjs/common';
import { ListenerService } from './listener.service';
import { MonitorModule } from 'src/monitor/monitor.module';

@Module({
    providers: [ListenerService],
    imports: [MonitorModule],
})
export class ListenerModule {}
