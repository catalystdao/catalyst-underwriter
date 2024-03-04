import { Injectable, OnModuleInit } from "@nestjs/common";
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker, MessagePort } from 'worker_threads';
import { ConfigService } from "src/config/config.service";
import { PoolConfig } from "src/config/config.types";
import { LoggerService, STATUS_LOG_INTERVAL } from "src/logger/logger.service";
import { WalletService } from "src/wallet/wallet.service";
import { DEFAULT_UNDERWRITER_RETRY_INTERVAL, DEFAULT_UNDERWRITER_PROCESSING_INTERVAL, DEFAULT_UNDERWRITER_MAX_TRIES, DEFAULT_UNDERWRITER_MAX_PENDING_TRANSACTIONS } from "src/underwriter/underwriter.service";
import { MonitorService } from "src/monitor/monitor.service";

export const DEFAULT_EXPIRER_RETRY_INTERVAL = DEFAULT_UNDERWRITER_RETRY_INTERVAL;
export const DEFAULT_EXPIRER_PROCESSING_INTERVAL = DEFAULT_UNDERWRITER_PROCESSING_INTERVAL;
export const DEFAULT_EXPIRER_MAX_TRIES = DEFAULT_UNDERWRITER_MAX_TRIES;
export const DEFAULT_EXPIRER_MAX_PENDING_TRANSACTIONS = DEFAULT_UNDERWRITER_MAX_PENDING_TRANSACTIONS;
export const DEFAULT_EXPIRER_EXPIRE_BLOCK_MARGIN = 500;

interface DefaultExpirerWorkerData {
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    expireBlocksMargin: number;
}

export interface ExpirerWorkerData {
    chainId: string;
    chainName: string;
    pools: PoolConfig[];
    rpc: string;
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    expireBlocksMargin: number;
    underwriterPublicKey: string;
    monitorPort: MessagePort;
    walletPort: MessagePort;
    loggerOptions: LoggerOptions;
}

@Injectable()
export class ExpirerService implements OnModuleInit {
    private workers: Record<string, Worker | null> = {};

    constructor(
        private readonly configService: ConfigService,
        private readonly monitorService: MonitorService,
        private readonly walletService: WalletService,
        private readonly loggerService: LoggerService,
    ) {}

    async onModuleInit() {
        this.loggerService.info(`Starting Expirer on all chains...`);

        await this.initializeWorkers();

        this.initiateIntervalStatusLog();
    }

    private async initializeWorkers(): Promise<void> {
        const defaultWorkerConfig = this.loadDefaultWorkerConfig();

        const pools = this.loadPools();

        for (const [chainId, ] of this.configService.chainsConfig) {

            const workerData = await this.loadWorkerConfig(chainId, pools, defaultWorkerConfig);

            const worker = new Worker(join(__dirname, 'expirer.worker.js'), {
                workerData,
                transferList: [workerData.monitorPort, workerData.walletPort]
            });
            this.workers[chainId] = worker;

            worker.on('error', (error) =>
                this.loggerService.fatal(
                    { error, chainId },
                    `Error on expirer worker.`,
                ),
            );

            worker.on('exit', (exitCode) => {
                this.workers[chainId] = null;
                this.loggerService.fatal(
                    { exitCode, chainId },
                    `Expirer worker exited.`,
                );
            });
        }
    }

    private loadDefaultWorkerConfig(): DefaultExpirerWorkerData {
        const globalExpirerConfig = this.configService.globalConfig.expirer;
        const globalUnderwriterConfig = this.configService.globalConfig.underwriter;

        const retryInterval = globalExpirerConfig.retryInterval
            ?? globalUnderwriterConfig.retryInterval
            ?? DEFAULT_EXPIRER_RETRY_INTERVAL;
        const processingInterval = globalExpirerConfig.processingInterval
            ?? globalUnderwriterConfig.processingInterval
            ?? DEFAULT_EXPIRER_PROCESSING_INTERVAL;
        const maxTries = globalExpirerConfig.maxTries
            ?? globalUnderwriterConfig.maxTries
            ?? DEFAULT_EXPIRER_MAX_TRIES;
        const maxPendingTransactions = globalExpirerConfig.maxPendingTransactions
            ?? globalUnderwriterConfig.maxPendingTransactions
            ?? DEFAULT_EXPIRER_MAX_PENDING_TRANSACTIONS;
        const expireBlocksMargin = globalExpirerConfig.expireBlocksMargin
            ?? DEFAULT_EXPIRER_EXPIRE_BLOCK_MARGIN;
    
        return {
            retryInterval,
            processingInterval,
            maxTries,
            maxPendingTransactions,
            expireBlocksMargin
        }
    }

    private async loadWorkerConfig(
        chainId: string,
        pools: PoolConfig[],
        defaultConfig: DefaultExpirerWorkerData
    ): Promise<ExpirerWorkerData> {

        const chainConfig = this.configService.chainsConfig.get(chainId);
        if (chainConfig == undefined) {
            throw new Error(`Unable to load config for chain ${chainId}`);
        }

        //TODO do we need this?
        // Only pass pools that contain a vault on the desired chainId
        const filteredPools = pools.filter(pool => {
            return pool.vaults.some((vault) => vault.chainId == chainId)
        });

        const chainExpirerConfig = chainConfig.expirer;
        const chainUnderwriterConfig = chainConfig.underwriter;
        return {
            chainId,
            chainName: chainConfig.name,
            pools: filteredPools,
            rpc: chainConfig.rpc,

            retryInterval: chainExpirerConfig.retryInterval
                ?? chainUnderwriterConfig.retryInterval
                ?? defaultConfig.retryInterval,
            processingInterval: chainExpirerConfig.processingInterval
                ?? chainUnderwriterConfig.processingInterval
                ?? defaultConfig.processingInterval,
            maxTries: chainExpirerConfig.maxTries
                ?? chainUnderwriterConfig.maxTries
                ?? defaultConfig.maxTries,
            maxPendingTransactions: chainExpirerConfig.maxPendingTransactions
                ?? chainUnderwriterConfig.maxPendingTransactions
                ?? defaultConfig.maxPendingTransactions,
            expireBlocksMargin: chainExpirerConfig.expireBlocksMargin
                ?? defaultConfig.expireBlocksMargin,

            underwriterPublicKey: this.walletService.publicKey,
            monitorPort: await this.monitorService.attachToMonitor(chainId),
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
            this.loggerService.info(status, 'Expirer workers status.');
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }

}