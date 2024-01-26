import { Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker } from 'worker_threads';
import { ConfigService, PoolConfig } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';

const DEFAULT_UNDERWRITER_RETRY_INTERVAL = 2000;
const DEFAULT_UNDERWRITER_PROCESSING_INTERVAL = 100;
const DEFAULT_UNDERWRITER_MAX_TRIES = 3;
const DEFAULT_UNDERWRITER_MAX_PENDING_TRANSACTIONS = 100;
const DEFAULT_UNDERWRITER_CONFIRMATIONS = 1;
const DEFAULT_UNDERWRITER_CONFIRMATION_TIMEOUT = 10 * 60000;

interface DefaultUnderwriterWorkerData {
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    confirmations: number;
    confirmationTimeout: number;
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
    confirmations: number;
    confirmationTimeout: number;
    privateKey: string;
    gasLimitBuffer: Record<string, any> & { default: number };
    gasPriceAdjustmentFactor?: number;
    maxAllowedGasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeeAdjustmentFactor?: number;
    maxAllowedPriorityFeePerGas?: bigint;
    priorityAdjustmentFactor: number | undefined;
    loggerOptions: LoggerOptions;
}


@Injectable()
export class UnderwriterService implements OnModuleInit {
    private workers: Record<string, Worker | null> = {};

    constructor(
        private readonly configService: ConfigService,
        private readonly loggerService: LoggerService,
    ) { }

    onModuleInit() {
        this.loggerService.info(`Starting Underwriter on all chains...`);

        this.initializeWorkers();

        this.initiateIntervalStatusLog();
    }

    private initializeWorkers(): void {
        const defaultWorkerConfig = this.loadDefaultWorkerConfig();

        const pools = this.loadPools();

        for (const [chainId, ] of this.configService.chainsConfig) {

            const workerData = this.loadWorkerConfig(chainId, pools, defaultWorkerConfig);

            const worker = new Worker(join(__dirname, 'underwriter.worker.js'), {
                workerData
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
        const underwriterConfig = this.configService.underwriterConfig;
        const globalUnderwriterConfig = underwriterConfig.underwriter;

        const retryInterval = globalUnderwriterConfig.retryInterval ?? DEFAULT_UNDERWRITER_RETRY_INTERVAL;
        const processingInterval = globalUnderwriterConfig.processingInterval ?? DEFAULT_UNDERWRITER_PROCESSING_INTERVAL;
        const maxTries = globalUnderwriterConfig.maxTries ?? DEFAULT_UNDERWRITER_MAX_TRIES;
        const maxPendingTransactions = globalUnderwriterConfig.maxPendingTransactions ?? DEFAULT_UNDERWRITER_MAX_PENDING_TRANSACTIONS;
        const confirmations = globalUnderwriterConfig.confirmations ?? DEFAULT_UNDERWRITER_CONFIRMATIONS;
        const confirmationTimeout = globalUnderwriterConfig.confirmationTimeout ?? DEFAULT_UNDERWRITER_CONFIRMATION_TIMEOUT;

        return {
            retryInterval,
            processingInterval,
            maxTries,
            maxPendingTransactions,
            confirmations,
            confirmationTimeout
        }
    }

    private loadWorkerConfig(
        chainId: string,
        pools: PoolConfig[],
        defaultConfig: DefaultUnderwriterWorkerData
    ): UnderwriterWorkerData {

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
            processingInterval: chainUnderwriterConfig.processingInterval ?? defaultConfig.processingInterval,
            maxTries: chainUnderwriterConfig.maxTries ?? defaultConfig.maxTries,
            maxPendingTransactions: chainUnderwriterConfig.maxPendingTransactions ?? defaultConfig.maxPendingTransactions,
            confirmations: chainUnderwriterConfig.confirmations ?? defaultConfig.confirmations,
            confirmationTimeout: chainUnderwriterConfig.confirmationTimeout ?? defaultConfig.confirmationTimeout,
            privateKey: this.configService.underwriterConfig.privateKey,
            gasLimitBuffer: { default: 0, ...chainUnderwriterConfig.gasLimitBuffer},
            gasPriceAdjustmentFactor: chainUnderwriterConfig.gasPriceAdjustmentFactor,
            maxAllowedGasPrice: chainUnderwriterConfig.maxAllowedGasPrice,
            maxFeePerGas: chainUnderwriterConfig.maxFeePerGas,
            maxPriorityFeeAdjustmentFactor: chainUnderwriterConfig.maxPriorityFeeAdjustmentFactor,
            maxAllowedPriorityFeePerGas: chainUnderwriterConfig.maxAllowedPriorityFeePerGas,
            priorityAdjustmentFactor: chainUnderwriterConfig.priorityAdjustmentFactor,
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