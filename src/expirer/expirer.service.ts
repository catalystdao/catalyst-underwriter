import { Injectable, OnModuleInit } from "@nestjs/common";
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker, MessagePort } from 'worker_threads';
import { ConfigService } from "src/config/config.service";
import { LoggerService, STATUS_LOG_INTERVAL } from "src/logger/logger.service";
import { WalletService } from "src/wallet/wallet.service";
import { DEFAULT_UNDERWRITER_RETRY_INTERVAL, DEFAULT_UNDERWRITER_PROCESSING_INTERVAL, DEFAULT_UNDERWRITER_MAX_TRIES, DEFAULT_UNDERWRITER_MAX_PENDING_TRANSACTIONS } from "src/underwriter/underwriter.service";
import { MonitorService } from "src/monitor/monitor.service";
import { tryErrorToString } from "src/common/utils";

export const DEFAULT_EXPIRER_RETRY_INTERVAL = DEFAULT_UNDERWRITER_RETRY_INTERVAL;
export const DEFAULT_EXPIRER_PROCESSING_INTERVAL = DEFAULT_UNDERWRITER_PROCESSING_INTERVAL;
export const DEFAULT_EXPIRER_MAX_TRIES = DEFAULT_UNDERWRITER_MAX_TRIES;
export const DEFAULT_EXPIRER_MAX_PENDING_TRANSACTIONS = DEFAULT_UNDERWRITER_MAX_PENDING_TRANSACTIONS;
export const DEFAULT_EXPIRER_EXPIRE_BLOCK_MARGIN = 500;

interface DefaultExpirerWorkerData {
    enabled: boolean;
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    expireBlocksMargin: number;
}

export interface ExpirerWorkerData {
    enabled: boolean;
    chainId: string;
    chainName: string;
    rpc: string;
    resolver: string | null;
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

        for (const [chainId, ] of this.configService.chainsConfig) {

            const workerData = await this.loadWorkerConfig(chainId, defaultWorkerConfig);

            if (!workerData.enabled) {
                this.loggerService.warn(
                    { chainId },
                    'Skipping expirer worker creation: expirer disabled.'
                );

                continue;
            }

            const worker = new Worker(join(__dirname, 'expirer.worker.js'), {
                workerData,
                transferList: [workerData.monitorPort, workerData.walletPort]
            });
            this.workers[chainId] = worker;

            worker.on('error', (error) =>
                this.loggerService.fatal(
                    { error: tryErrorToString(error), chainId },
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

        const enabled = globalExpirerConfig.enabled != false;

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
            enabled,
            retryInterval,
            processingInterval,
            maxTries,
            maxPendingTransactions,
            expireBlocksMargin
        }
    }

    private async loadWorkerConfig(
        chainId: string,
        defaultConfig: DefaultExpirerWorkerData
    ): Promise<ExpirerWorkerData> {

        const chainConfig = this.configService.chainsConfig.get(chainId);
        if (chainConfig == undefined) {
            throw new Error(`Unable to load config for chain ${chainId}`);
        }

        const chainExpirerConfig = chainConfig.expirer;
        const chainUnderwriterConfig = chainConfig.underwriter;
        return {
            enabled: defaultConfig.enabled
                && chainExpirerConfig.enabled != false,

            chainId,
            chainName: chainConfig.name,
            rpc: chainConfig.rpc,
            resolver: chainConfig.resolver,

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