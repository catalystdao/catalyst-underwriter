import { Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker, MessagePort } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { MonitorService } from 'src/monitor/monitor.service';

export const DEFAULT_LISTENER_MAX_BLOCKS = null;
export const DEFAULT_LISTENER_PROCESSING_INTERVAL = 100;


interface DefaultListenerWorkerData {
    processingInterval: number,
    maxBlocks: number | null
}

export interface VaultConfig {
    poolId: string,
    vaultAddress: string,
    interfaceAddress: string,
    channels: Record<string, string>
}

export interface ListenerWorkerData {
    chainId: string,
    chainName: string,
    rpc: string,
    startingBlock?: number,
    processingInterval: number,
    maxBlocks: number | null,
    vaultConfigs: VaultConfig[],
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

        const vaultConfigs = this.loadVaultConfigs();

        for (const [chainId, chainVaultConfigs] of Object.entries(vaultConfigs)) {

            const workerData = await this.loadWorkerConfig(chainId, chainVaultConfigs, defaultWorkerConfig);

            const worker = new Worker(join(__dirname, 'listener.worker.js'), {
                workerData,
                transferList: [workerData.monitorPort]
            });
            this.workers[chainId] = worker;

            worker.on('error', (error) =>
                this.loggerService.fatal(
                    error,
                    `Error on listener worker (chain ${chainId}).`,
                ),
            );

            worker.on('exit', (exitCode) => {
                this.workers[chainId] = null;
                this.loggerService.info(
                    `Listener worker exited with code ${exitCode} (chain ${chainId}).`,
                );
            });
        }
    }

    private loadDefaultWorkerConfig(): DefaultListenerWorkerData {
        const globalConfig = this.configService.globalConfig;
        const globalListenerConfig = globalConfig.listener;

        const processingInterval = globalListenerConfig.processingInterval ?? DEFAULT_LISTENER_PROCESSING_INTERVAL;
        const maxBlocks = globalListenerConfig.maxBlocks ?? DEFAULT_LISTENER_MAX_BLOCKS;

        return {
            processingInterval,
            maxBlocks
        }
    }

    private async loadWorkerConfig(
        chainId: string,
        vaultConfigs: VaultConfig[],
        defaultConfig: DefaultListenerWorkerData
    ): Promise<ListenerWorkerData> {

        const chainConfig = this.configService.chainsConfig.get(chainId);
        if (chainConfig == undefined) {
            throw new Error(`Unable to load config for chain ${chainId}`);
        }

        const chainListenerConfig = chainConfig.listener;
        return {
            chainId,
            chainName: chainConfig.name,
            rpc: chainConfig.rpc,
            startingBlock: chainConfig.startingBlock,
            processingInterval: chainListenerConfig.processingInterval ?? defaultConfig.processingInterval,
            maxBlocks: chainListenerConfig.maxBlocks ?? defaultConfig.maxBlocks,
            vaultConfigs,
            monitorPort: await this.monitorService.attachToMonitor(chainId),
            loggerOptions: this.loggerService.loggerOptions
        };
    }

    private loadVaultConfigs(): Record<string, VaultConfig[]> {

        const configs: Record<string, VaultConfig[]> = {};
        for (const [chainId,] of this.configService.chainsConfig) {
            configs[chainId] = [];
        }

        // Get all the vaults across all the pools
        for (const [poolId, poolConfig] of this.configService.poolsConfig.entries()) {

            for (const fullVaultConfig of poolConfig.vaults) {
                const chainId = fullVaultConfig.chainId;

                if (!(chainId in configs)) {
                    throw new Error(`The chain id ${chainId} is required for vault '${fullVaultConfig.name}' (pool '${poolId}' ('${poolConfig.name}')), but is not configured.`)
                }

                configs[chainId].push({
                    poolId: poolId,
                    vaultAddress: fullVaultConfig.vaultAddress,
                    interfaceAddress: fullVaultConfig.interfaceAddress,
                    channels: fullVaultConfig.channels
                });
            }
        }

        return configs;
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