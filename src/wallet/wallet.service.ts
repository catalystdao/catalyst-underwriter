import { Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker, MessagePort } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { WalletGetPortResponse } from './wallet.types';

const DEFAULT_WALLET_RETRY_INTERVAL = 30000;
const DEFAULT_WALLET_PROCESSING_INTERVAL = 100;
const DEFAULT_WALLET_MAX_TRIES = 3;
const DEFAULT_WALLET_MAX_PENDING_TRANSACTIONS = 50;
const DEFAULT_WALLET_CONFIRMATIONS = 1;
const DEFAULT_WALLET_CONFIRMATION_TIMEOUT = 60000;

interface DefaultWalletWorkerData {
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    confirmations: number;
    confirmationTimeout: number;
    maxFeePerGas?: number | string;
    maxAllowedPriorityFeePerGas?: number | string;
    maxPriorityFeeAdjustmentFactor?: number;
    maxAllowedGasPrice?: number | string;
    gasPriceAdjustmentFactor?: number;
    priorityAdjustmentFactor?: number;
}

export interface WalletWorkerData {
    chainId: string,
    chainName: string,
    rpc: string,
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    confirmations: number;
    confirmationTimeout: number;
    privateKey: string;
    maxFeePerGas?: number | string;
    maxAllowedPriorityFeePerGas?: number | string;
    maxPriorityFeeAdjustmentFactor?: number;
    maxAllowedGasPrice?: number | string;
    gasPriceAdjustmentFactor?: number;
    priorityAdjustmentFactor?: number;
    loggerOptions: LoggerOptions;

}

@Injectable()
export class WalletService implements OnModuleInit {
    private workers: Record<string, Worker | null> = {};
    private requestPortMessageId = 0;

    constructor(
        private readonly configService: ConfigService,
        private readonly loggerService: LoggerService,
    ) {}

    onModuleInit() {
        this.loggerService.info(`Starting Wallets on all chains...`);

        this.initializeWorkers();

        this.initiateIntervalStatusLog();
    }

    private initializeWorkers(): void {
        const defaultWorkerConfig = this.loadDefaultWorkerConfig();

        for (const [chainId, ] of this.configService.chainsConfig) {

            const workerData = this.loadWorkerConfig(chainId, defaultWorkerConfig);

            const worker = new Worker(join(__dirname, 'wallet.worker.js'), {
                workerData
            });
            this.workers[chainId] = worker;

            worker.on('error', (error) =>
                this.loggerService.fatal(
                    error,
                    `Error on Wallet worker (chain ${chainId}).`,
                ),
            );

            worker.on('exit', (exitCode) => {
                this.workers[chainId] = null;
                this.loggerService.info(
                    `Wallet worker exited with code ${exitCode} (chain ${chainId}).`,
                );
            });
        }
    }

    private loadDefaultWorkerConfig(): DefaultWalletWorkerData {
        const globalWalletConfig = this.configService.globalConfig.underwriter; //TODO replace 'underwrite' with 'wallet'

        const retryInterval = globalWalletConfig.retryInterval ?? DEFAULT_WALLET_RETRY_INTERVAL;
        const processingInterval = globalWalletConfig.processingInterval ?? DEFAULT_WALLET_PROCESSING_INTERVAL;
        const maxTries = globalWalletConfig.maxTries ?? DEFAULT_WALLET_MAX_TRIES;
        const maxPendingTransactions = globalWalletConfig.maxPendingTransactions ?? DEFAULT_WALLET_MAX_PENDING_TRANSACTIONS;
        const confirmations = globalWalletConfig.confirmations ?? DEFAULT_WALLET_CONFIRMATIONS;
        const confirmationTimeout = globalWalletConfig.confirmationTimeout ?? DEFAULT_WALLET_CONFIRMATION_TIMEOUT;

        const maxFeePerGas = globalWalletConfig.maxFeePerGas;
        const maxAllowedPriorityFeePerGas = globalWalletConfig.maxAllowedPriorityFeePerGas;
        const maxPriorityFeeAdjustmentFactor = globalWalletConfig.maxPriorityFeeAdjustmentFactor;
        const maxAllowedGasPrice = globalWalletConfig.maxAllowedGasPrice;
        const gasPriceAdjustmentFactor = globalWalletConfig.gasPriceAdjustmentFactor;
        const priorityAdjustmentFactor = globalWalletConfig.priorityAdjustmentFactor;
    
        return {
            retryInterval,
            processingInterval,
            maxTries,
            maxPendingTransactions,
            confirmations,
            confirmationTimeout,
            maxFeePerGas,
            maxAllowedPriorityFeePerGas,
            maxPriorityFeeAdjustmentFactor,
            maxAllowedGasPrice,
            gasPriceAdjustmentFactor,
            priorityAdjustmentFactor,
        }
    }

    private loadWorkerConfig(
        chainId: string,
        defaultConfig: DefaultWalletWorkerData
    ): WalletWorkerData {

        const chainConfig = this.configService.chainsConfig.get(chainId);
        if (chainConfig == undefined) {
            throw new Error(`Unable to load config for chain ${chainId}`);
        }

        const chainWalletConfig = chainConfig.underwriter; //TODO replace 'underwrite' with 'wallet'
        return {
            chainId,
            chainName: chainConfig.name,
            rpc: chainWalletConfig.rpc ?? chainConfig.rpc,

            retryInterval: chainWalletConfig.retryInterval ?? defaultConfig.retryInterval,
            processingInterval:
                chainWalletConfig.processingInterval ??
                defaultConfig.processingInterval,
            maxTries: chainWalletConfig.maxTries ?? defaultConfig.maxTries,
            maxPendingTransactions:
                chainWalletConfig.maxPendingTransactions
                ?? defaultConfig.maxPendingTransactions,
            confirmations: chainWalletConfig.confirmations ?? defaultConfig.confirmations,
            confirmationTimeout:
                chainWalletConfig.confirmationTimeout ??
                defaultConfig.confirmationTimeout,

            privateKey: this.configService.globalConfig.privateKey,
            
            maxFeePerGas:
                chainWalletConfig.maxFeePerGas ??
                defaultConfig.maxFeePerGas,

            maxPriorityFeeAdjustmentFactor: 
                chainWalletConfig.maxPriorityFeeAdjustmentFactor ??
                defaultConfig.maxPriorityFeeAdjustmentFactor,

            maxAllowedPriorityFeePerGas:
                chainWalletConfig.maxAllowedPriorityFeePerGas ??
                defaultConfig.maxAllowedPriorityFeePerGas,

            gasPriceAdjustmentFactor:
                chainWalletConfig.gasPriceAdjustmentFactor ??
                defaultConfig.gasPriceAdjustmentFactor,

            maxAllowedGasPrice:
                chainWalletConfig.maxAllowedGasPrice ??
                defaultConfig.maxAllowedGasPrice,

            priorityAdjustmentFactor:
                chainWalletConfig.priorityAdjustmentFactor ??
                defaultConfig.priorityAdjustmentFactor,

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
            this.loggerService.info(status, 'Wallet workers status.');
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }


    private getNextRequestPortMessageId(): number {
        return this.requestPortMessageId++;
    }

    async attachToWallet(chainId: string): Promise<MessagePort> {
        const worker = this.workers[chainId];

        if (worker == undefined) {
            throw new Error(`Wallet does not exist for chain ${chainId}`);
        }

        const messageId = this.getNextRequestPortMessageId();
        const portPromise = new Promise<MessagePort>((resolve) => {
            const listener = (data: WalletGetPortResponse) => {
                if (data.messageId == messageId) {
                    worker.off("message", listener);
                    resolve(data.port);
                }
            };
            worker.on("message", listener);
            worker.postMessage(messageId);
        });

        return portPromise;
    }
}
