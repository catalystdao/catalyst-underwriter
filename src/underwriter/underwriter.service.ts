import { Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker, MessagePort } from 'worker_threads';
import { ConfigService, PoolConfig } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { WalletService } from 'src/wallet/wallet.service';

export const DEFAULT_UNDERWRITER_RETRY_INTERVAL = 30000;
export const DEFAULT_UNDERWRITER_PROCESSING_INTERVAL = 100;
export const DEFAULT_UNDERWRITER_MAX_TRIES = 3;
export const DEFAULT_UNDERWRITER_MAX_PENDING_TRANSACTIONS = 50;

interface DefaultUnderwriterWorkerData {
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
}

export interface UnderwriterWorkerData {
    chainId: string,
    chainName: string,
    pools: PoolConfig[],
    rpc: string,
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    walletPort: MessagePort;
    loggerOptions: LoggerOptions;
}


@Injectable()
export class UnderwriterService implements OnModuleInit {
    private workers: Record<string, Worker | null> = {};

    constructor(
        private readonly configService: ConfigService,
        private readonly walletService: WalletService,
        private readonly loggerService: LoggerService,
    ) { }

    async onModuleInit() {
        this.loggerService.info(`Starting Underwriter on all chains...`);

        await this.initializeWorkers();

        this.initiateIntervalStatusLog();
    }

    private async initializeWorkers(): Promise<void> {
        const defaultWorkerConfig = this.loadDefaultWorkerConfig();

        const pools = this.loadPools();

        for (const [chainId, ] of this.configService.chainsConfig) {

            const workerData = await this.loadWorkerConfig(chainId, pools, defaultWorkerConfig);

            const worker = new Worker(join(__dirname, 'underwriter.worker.js'), {
                workerData,
                transferList: [workerData.walletPort]
            });
            this.workers[chainId] = worker;

            worker.on('error', (error) =>
                this.loggerService.fatal(
                    error,
                    `Error on underwriter worker (chain ${chainId}).`,
                ),
            );

            worker.on('exit', (exitCode) => {
                this.workers[chainId] = null;
                this.loggerService.info(
                    `Underwriter worker exited with code ${exitCode} (chain ${chainId}).`,
                );
            });
        }
    }

    private loadDefaultWorkerConfig(): DefaultUnderwriterWorkerData {
        const globalUnderwriterConfig = this.configService.globalConfig.underwriter;

        const retryInterval = globalUnderwriterConfig.retryInterval ?? DEFAULT_UNDERWRITER_RETRY_INTERVAL;
        const processingInterval = globalUnderwriterConfig.processingInterval ?? DEFAULT_UNDERWRITER_PROCESSING_INTERVAL;
        const maxTries = globalUnderwriterConfig.maxTries ?? DEFAULT_UNDERWRITER_MAX_TRIES;
        const maxPendingTransactions = globalUnderwriterConfig.maxPendingTransactions ?? DEFAULT_UNDERWRITER_MAX_PENDING_TRANSACTIONS;
    
        return {
            retryInterval,
            processingInterval,
            maxTries,
            maxPendingTransactions
        }
    }

    private async loadWorkerConfig(
        chainId: string,
        pools: PoolConfig[],
        defaultConfig: DefaultUnderwriterWorkerData
    ): Promise<UnderwriterWorkerData> {

        const chainConfig = this.configService.chainsConfig.get(chainId);
        if (chainConfig == undefined) {
            throw new Error(`Unable to load config for chain ${chainId}`);
        }

        // Only pass pools that contain a vault on the desired chainId
        const filteredPools = pools.filter(pool => {
            return pool.vaults.some((vault) => vault.chainId == chainId)
        });

        const chainUnderwriterConfig = chainConfig.underwriter;
        return {
            chainId,
            chainName: chainConfig.name,
            pools: filteredPools,
            rpc: chainUnderwriterConfig.rpc ?? chainConfig.rpc,

            retryInterval: chainUnderwriterConfig.retryInterval ?? defaultConfig.retryInterval,
            processingInterval:
                chainUnderwriterConfig.processingInterval ??
                defaultConfig.processingInterval,
            maxTries: chainUnderwriterConfig.maxTries ?? defaultConfig.maxTries,
            maxPendingTransactions:
                chainUnderwriterConfig.maxPendingTransactions
                ?? defaultConfig.maxPendingTransactions,

            walletPort: await this.walletService.attachToWallet(chainId),
            loggerOptions: this.loggerService.loggerOptions
        };
    }

    private loadPools(): PoolConfig[] {

        const pools: PoolConfig[] = [];

        for (const [, poolConfig] of this.configService.poolsConfig) {
            pools.push({
                id: poolConfig.id,
                name: poolConfig.name,
                amb: poolConfig.amb,
                vaults: poolConfig.vaults.map(vault => {
                    const transformedChannels: Record<string, string> = {}
                    for (const [channelId, chainId] of Object.entries(vault.channels)) {
                        transformedChannels[channelId.toLowerCase()] = chainId; // Important for when matching vaults
                    }

                    return {
                        name: vault.name,
                        chainId: vault.chainId,
                        vaultAddress: vault.vaultAddress.toLowerCase(), // Important for when matching vaults
                        interfaceAddress: vault.interfaceAddress.toLowerCase(), // Important for when matching vaults
                        channels: transformedChannels
                    }
                })
            });
        }

        return pools;
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
            this.loggerService.info(status, 'Underwriter workers status.');
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }
}