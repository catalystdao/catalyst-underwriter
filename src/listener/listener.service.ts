import { Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker, MessagePort } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { MonitorService } from 'src/monitor/monitor.service';
import { tryErrorToString } from 'src/common/utils';
import { ChainConfig, EndpointConfig } from 'src/config/config.types';

export const DEFAULT_LISTENER_MAX_BLOCKS = null;
export const DEFAULT_LISTENER_RETRY_INTERVAL = 2000;
export const DEFAULT_LISTENER_PROCESSING_INTERVAL = 100;


interface DefaultListenerWorkerData {
    retryInterval: number;
    processingInterval: number,
    maxBlocks: number | null
}

export interface ListenerWorkerData {
    chainId: string,
    chainName: string,
    rpc: string,
    startingBlock?: number,
    retryInterval: number;
    processingInterval: number,
    maxBlocks: number | null,
    endpointConfigs: EndpointConfig[],
    monitorPort: MessagePort;
    loggerOptions: LoggerOptions
}

@Injectable()
export class ListenerService implements OnModuleInit {
    private workers: Record<string, Worker | null> = {};

    constructor(
        private readonly configService: ConfigService,
        private readonly monitorService: MonitorService,
        private readonly loggerService: LoggerService,
    ) { }

    async onModuleInit() {
        this.loggerService.info(`Starting Listener on all chains...`);

        await this.initializeWorkers();

        this.initiateIntervalStatusLog();
    }

    private async initializeWorkers(): Promise<void> {
        const defaultWorkerConfig = this.loadDefaultWorkerConfig();

        for (const [chainId, chainConfig] of this.configService.chainsConfig) {

            const workerData = await this.loadWorkerConfig(
                chainId,
                chainConfig,
                defaultWorkerConfig
            );

            if (workerData == undefined) {
                this.loggerService.warn('Skipping listener for chain.');
                continue;
            }

            const worker = new Worker(join(__dirname, 'listener.worker.js'), {
                workerData,
                transferList: [workerData.monitorPort]
            });
            this.workers[chainId] = worker;

            worker.on('error', (error) =>
                this.loggerService.fatal(
                    { error: tryErrorToString(error), chainId },
                    `Error on listener worker.`,
                ),
            );

            worker.on('exit', (exitCode) => {
                this.workers[chainId] = null;
                this.loggerService.fatal(
                    { exitCode, chainId },
                    `Listener worker exited.`,
                );
            });
        }
    }

    private loadDefaultWorkerConfig(): DefaultListenerWorkerData {
        const globalConfig = this.configService.globalConfig;
        const globalListenerConfig = globalConfig.listener;

        const retryInterval = globalListenerConfig.retryInterval ?? DEFAULT_LISTENER_RETRY_INTERVAL;
        const processingInterval = globalListenerConfig.processingInterval ?? DEFAULT_LISTENER_PROCESSING_INTERVAL;
        const maxBlocks = globalListenerConfig.maxBlocks ?? DEFAULT_LISTENER_MAX_BLOCKS;

        return {
            retryInterval,
            processingInterval,
            maxBlocks
        }
    }

    private async loadWorkerConfig(
        chainId: string,
        chainConfig: ChainConfig,
        defaultConfig: DefaultListenerWorkerData
    ): Promise<ListenerWorkerData | undefined> {

        const chainEndpointConfigs = this.configService.endpointsConfig.get(chainId);
        if (chainEndpointConfigs == undefined) {
            this.loggerService.warn('No endpoints specified. Skipping chain.');
            return undefined;
        }

        const chainListenerConfig = chainConfig.listener;
        return {
            chainId,
            chainName: chainConfig.name,
            rpc: chainConfig.rpc,
            startingBlock: chainListenerConfig.startingBlock,
            retryInterval: chainListenerConfig.retryInterval ?? defaultConfig.retryInterval,
            processingInterval: chainListenerConfig.processingInterval ?? defaultConfig.processingInterval,
            maxBlocks: chainListenerConfig.maxBlocks ?? defaultConfig.maxBlocks,
            endpointConfigs: chainEndpointConfigs,
            monitorPort: await this.monitorService.attachToMonitor(chainId),
            loggerOptions: this.loggerService.loggerOptions
        };
    }

    private initiateIntervalStatusLog(): void {
        const logStatus = () => {
            const activeWorkers = [];
            const inactiveWorkers = [];
            for (const chainId of Object.keys(this.workers)) {
                if (this.workers[chainId] != null) activeWorkers.push(chainId);
                else inactiveWorkers.push(chainId);
            }
            const status = {
                activeWorkers,
                inactiveWorkers,
            };
            this.loggerService.info(status, 'Listener workers status.');
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }
}