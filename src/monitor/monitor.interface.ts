import { MessagePort } from 'worker_threads';

export interface MonitorStatus {
    blockNumber: number;
    blockHash: string | null;
    timestamp: number;
}

export class MonitorInterface {

    constructor(private readonly port: MessagePort) {}

    addListener(listener: (status: MonitorStatus) => void) {
        this.port.on('message', listener);
    }

    removeListener(listener: (status: MonitorStatus) => void) {
        this.port.off('message', listener);
    }
}