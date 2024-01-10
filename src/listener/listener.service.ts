import { Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';

export const DEFAULT_LISTENER_INTERVAL = 5000;
export const DEFAULT_LISTENER_BLOCK_DELAY = 0;
export const DEFAULT_LISTENER_MAX_BLOCKS = null;


interface DefaultListenerWorkerData {
    interval: number,
    blockDelay: number,
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
    blockDelay: number,
    interval: number,
    maxBlocks: number | null,
    vaultConfigs: VaultConfig[],
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

        const vaultConfigs = this.loadVaultConfigs();

        for (const [chainId, chainVaultConfigs] of Object.entries(vaultConfigs)) {

            const workerData = this.loadWorkerConfig(chainId, chainVaultConfigs, defaultWorkerConfig);

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

        const blockDelay = underwriterConfig.blockDelay ?? DEFAULT_LISTENER_BLOCK_DELAY;
        const interval = globalListenerConfig.interval ?? DEFAULT_LISTENER_INTERVAL;
        const maxBlocks = globalListenerConfig.maxBlocks ?? DEFAULT_LISTENER_MAX_BLOCKS;

        return {
            interval,
            blockDelay,
            maxBlocks
        }
    }

    private loadWorkerConfig(
        chainId: string,
        vaultConfigs: VaultConfig[],
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
            vaultConfigs,
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