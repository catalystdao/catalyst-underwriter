import { Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';

export const DEFAULT_LISTENER_INTERVAL = 5000;
export const DEFAULT_BLOCK_DELAY = 0;
export const DEFAULT_MAX_BLOCKS = null;


interface DefaultListenerWorkerData {
    interval: number,
    blockDelay: number,
    maxBlocks: number | null
}

export interface ListenerWorkerData {
    chainId: string,
    chainName: string,
    rpc: string,
    startingBlock?: number,
    blockDelay: number,
    interval: number,
    maxBlocks: number | null,
    vaults: string[],
    interfaces: string[],
    loggerOptions: LoggerOptions
}

@Injectable()
export class ListenerService implements OnModuleInit {
    private workers: Record<string, Worker | null> = {};

    constructor(
        private readonly configService: ConfigService,
        private readonly loggerService: LoggerService,
    ) { }

    onModuleInit() {
        this.loggerService.info(`Starting Listener on all chains...`);

        this.initializeWorkers();

        this.initiateIntervalStatusLog();
    }

    private initializeWorkers(): void {
        const defaultWorkerConfig = this.loadDefaultWorkerConfig();

        const addresses = this.loadAddresses();

        for (const [chainId, { vaults, interfaces }] of Object.entries(addresses)) {

            const workerData = this.loadWorkerConfig(chainId, vaults, interfaces, defaultWorkerConfig);

            const worker = new Worker(join(__dirname, 'listener.worker.js'), {
                workerData
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
        const underwriterConfig = this.configService.underwriterConfig;
        const globalListenerConfig = underwriterConfig.listener;

        const blockDelay = underwriterConfig.blockDelay ?? DEFAULT_BLOCK_DELAY;
        const interval = globalListenerConfig.interval ?? DEFAULT_LISTENER_INTERVAL;
        const maxBlocks = globalListenerConfig.maxBlocks ?? DEFAULT_MAX_BLOCKS;

        return {
            interval,
            blockDelay,
            maxBlocks
        }
    }

    private loadWorkerConfig(
        chainId: string,
        vaults: string[],
        interfaces: string[],
        defaultConfig: DefaultListenerWorkerData
    ): ListenerWorkerData {

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
            blockDelay: chainConfig.blockDelay ?? defaultConfig.blockDelay,
            interval: chainListenerConfig.interval ?? defaultConfig.interval,
            maxBlocks: chainListenerConfig.maxBlocks ?? defaultConfig.maxBlocks,
            vaults,
            interfaces,
            loggerOptions: this.loggerService.loggerOptions
        };
    }

    private loadAddresses(): Record<string, { vaults: string[], interfaces: string[] }> {

        const addresses: Record<string, { vaults: string[], interfaces: string[] }> = {};
        for (const [chainId,] of this.configService.chainsConfig) {
            addresses[chainId] = {
                vaults: [],
                interfaces: []
            };
        }

        // Get all the vaults across all the pools
        for (const [poolName, poolConfig] of this.configService.poolsConfig.entries()) {

            for (const vaultConfig of poolConfig.vaults) {
                const chainId = vaultConfig.chainId;

                if (!(chainId in addresses)) {
                    throw new Error(`The chain id ${chainId} is required for vault '${vaultConfig.name}' (pool '${poolName}'), but is not configured.`)
                }

                addresses[chainId].vaults.push(vaultConfig.vaultAddress);
                addresses[chainId].interfaces.push(vaultConfig.interfaceAddress);
            }
        }

        return addresses;
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