import { Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker, MessagePort } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { AMBConfig, ChainConfig, PoolConfig, TokensConfig } from 'src/config/config.types';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { WalletService } from 'src/wallet/wallet.service';
import { Wallet } from 'ethers';
import { DisableUnderwritingRequest, EnableUnderwritingRequest } from './underwriter.controller';


export const DEFAULT_UNDERWRITER_RETRY_INTERVAL = 30000;
export const DEFAULT_UNDERWRITER_PROCESSING_INTERVAL = 100;
export const DEFAULT_UNDERWRITER_MAX_TRIES = 3;
export const DEFAULT_UNDERWRITER_MAX_PENDING_TRANSACTIONS = 50;
export const DEFAULT_UNDERWRITER_UNDERWRITE_BLOCKS_MARGIN = 50;
export const DEFAULT_UNDERWRITER_UNDERWRITE_DELAY = 500;
export const DEFAULT_UNDERWRITER_MAX_SUBMISSION_DELAY = 300000;
export const DEFAULT_UNDERWRITER_TOKEN_BALANCE_UPDATE_INTERVAL = 50;

interface DefaultUnderwriterWorkerData {
    enabled: boolean;
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    underwriteBlocksMargin: number;
    underwriteDelay: number;
    maxSubmissionDelay: number;
    maxUnderwriteAllowed: bigint | undefined;
    minUnderwriteReward: bigint | undefined;
    lowTokenBalanceWarning: bigint | undefined;
    tokenBalanceUpdateInterval: number;
    walletPublicKey: string;
}

export interface UnderwriterWorkerData {
    enabled: boolean;
    chainId: string,
    chainName: string,
    tokens: TokensConfig,
    pools: PoolConfig[],
    ambs: Record<string, AMBConfig>,
    rpc: string,
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    underwriteBlocksMargin: number;
    underwriteDelay: number;
    maxSubmissionDelay: number;
    walletPublicKey: string;
    walletPort: MessagePort;
    loggerOptions: LoggerOptions;
}

export enum UnderwriterWorkerCommandId {
    Enable,
    Disable
}

export interface UnderwriterWorkerCommand {
    id: UnderwriterWorkerCommandId,
    data?: any
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
        const ambs = Object.fromEntries(this.configService.ambsConfig.entries());

        for (const [chainId, ] of this.configService.chainsConfig) {

            const workerData = await this.loadWorkerConfig(chainId, pools, ambs, defaultWorkerConfig);

            const worker = new Worker(join(__dirname, 'underwriter.worker.js'), {
                workerData,
                transferList: [workerData.walletPort]
            });
            this.workers[chainId] = worker;

            worker.on('error', (error) =>
                this.loggerService.fatal(
                    { error, chainId },
                    `Error on underwriter worker.`,
                ),
            );

            worker.on('exit', (exitCode) => {
                this.workers[chainId] = null;
                this.loggerService.fatal(
                    { exitCode, chainId },
                    `Underwriter worker exited.`,
                );
            });
        }
    }

    private loadDefaultWorkerConfig(): DefaultUnderwriterWorkerData {
        const globalUnderwriterConfig = this.configService.globalConfig.underwriter;

        const enabled = globalUnderwriterConfig.enabled != false;
        const retryInterval = globalUnderwriterConfig.retryInterval ?? DEFAULT_UNDERWRITER_RETRY_INTERVAL;
        const processingInterval = globalUnderwriterConfig.processingInterval ?? DEFAULT_UNDERWRITER_PROCESSING_INTERVAL;
        const maxTries = globalUnderwriterConfig.maxTries ?? DEFAULT_UNDERWRITER_MAX_TRIES;
        const maxPendingTransactions = globalUnderwriterConfig.maxPendingTransactions ?? DEFAULT_UNDERWRITER_MAX_PENDING_TRANSACTIONS;
        const underwriteBlocksMargin = globalUnderwriterConfig.underwriteBlocksMargin ?? DEFAULT_UNDERWRITER_UNDERWRITE_BLOCKS_MARGIN;
        const underwriteDelay = globalUnderwriterConfig.underwriteDelay ?? DEFAULT_UNDERWRITER_UNDERWRITE_DELAY;
        const maxSubmissionDelay = globalUnderwriterConfig.maxSubmissionDelay ?? DEFAULT_UNDERWRITER_MAX_SUBMISSION_DELAY;
        const maxUnderwriteAllowed = globalUnderwriterConfig.maxUnderwriteAllowed;
        const minUnderwriteReward = globalUnderwriterConfig.minUnderwriteReward;
        const lowTokenBalanceWarning = globalUnderwriterConfig.lowTokenBalanceWarning;
        const tokenBalanceUpdateInterval = globalUnderwriterConfig.tokenBalanceUpdateInterval ?? DEFAULT_UNDERWRITER_TOKEN_BALANCE_UPDATE_INTERVAL;
        const walletPublicKey = (new Wallet(this.configService.globalConfig.privateKey)).address;
    
        return {
            enabled,
            retryInterval,
            processingInterval,
            maxTries,
            maxPendingTransactions,
            underwriteBlocksMargin,
            underwriteDelay,
            maxSubmissionDelay,
            maxUnderwriteAllowed,
            minUnderwriteReward,
            lowTokenBalanceWarning,
            tokenBalanceUpdateInterval,
            walletPublicKey,
        }
    }

    private async loadWorkerConfig(
        chainId: string,
        pools: PoolConfig[],
        ambs: Record<string, AMBConfig>,
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
            enabled: defaultConfig.enabled && chainUnderwriterConfig.enabled != false,
            chainId,
            chainName: chainConfig.name,
            tokens: this.loadTokensConfig(chainConfig, defaultConfig),
            pools: filteredPools,
            ambs,
            rpc: chainConfig.rpc,

            retryInterval: chainUnderwriterConfig.retryInterval ?? defaultConfig.retryInterval,
            processingInterval:
                chainUnderwriterConfig.processingInterval ??
                defaultConfig.processingInterval,
            maxTries: chainUnderwriterConfig.maxTries ?? defaultConfig.maxTries,
            maxPendingTransactions:
                chainUnderwriterConfig.maxPendingTransactions
                ?? defaultConfig.maxPendingTransactions,
            underwriteBlocksMargin:
                chainUnderwriterConfig.underwriteBlocksMargin
                ?? defaultConfig.underwriteBlocksMargin,
            underwriteDelay:
                chainUnderwriterConfig.underwriteDelay
                ?? defaultConfig.underwriteDelay,
            maxSubmissionDelay:
                chainUnderwriterConfig.maxSubmissionDelay
                ?? defaultConfig.maxSubmissionDelay,

            walletPublicKey: defaultConfig.walletPublicKey,
            walletPort: await this.walletService.attachToWallet(chainId),
            loggerOptions: this.loggerService.loggerOptions
        };
    }

    private loadTokensConfig(
        chainConfig: ChainConfig,
        defaultConfig: DefaultUnderwriterWorkerData
    ): TokensConfig {
        const chainUnderwriterConfig = chainConfig.underwriter;

        // Token-specific config can be specified in three places. The hierarchy of the config to
        // use is as follows (list in decreasing preference)
        // - chain > tokens > ${config}
        // - chain > underwriter > ${config}
        // - global > underwriter > ${config}

        const finalConfig: TokensConfig = {};
        for (const [tokenAddress, chainTokenConfig] of Object.entries(chainConfig.tokens)) {
            finalConfig[tokenAddress] = { ...chainTokenConfig };

            finalConfig[tokenAddress].maxUnderwriteAllowed ??=
                chainUnderwriterConfig.maxUnderwriteAllowed
                ?? defaultConfig.maxUnderwriteAllowed;

            finalConfig[tokenAddress].minUnderwriteReward ??=
                chainUnderwriterConfig.minUnderwriteReward
                ?? defaultConfig.minUnderwriteReward;

            finalConfig[tokenAddress].lowTokenBalanceWarning ??=
                chainUnderwriterConfig.lowTokenBalanceWarning
                ?? defaultConfig.lowTokenBalanceWarning;

            finalConfig[tokenAddress].tokenBalanceUpdateInterval ??=
                chainUnderwriterConfig.tokenBalanceUpdateInterval
                ?? defaultConfig.tokenBalanceUpdateInterval;
        }

        return finalConfig;
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


    // Management utils
    // ********************************************************************************************

    async enableUnderwriting(request: EnableUnderwritingRequest): Promise<void> {

        const enableCommand: UnderwriterWorkerCommand = {
            id: UnderwriterWorkerCommandId.Enable
        }

        for (const [chainId, worker] of Object.entries(this.workers)) {
            if (
                request.chainIds != undefined
                && !request.chainIds.includes(chainId)
            ) {
                continue;
            }

            this.loggerService.warn(
                { chainId },
                'Requesting underwrite worker enable.'
            );
            worker?.postMessage(enableCommand);
        }
    }

    async disableUnderwriting(request: DisableUnderwritingRequest): Promise<void> {

        const disableCommand: UnderwriterWorkerCommand = {
            id: UnderwriterWorkerCommandId.Disable
        }

        for (const [chainId, worker] of Object.entries(this.workers)) {
            if (
                request.chainIds != undefined
                && !request.chainIds.includes(chainId)
            ) {
                continue;
            }

            this.loggerService.warn(
                { chainId },
                'Requesting underwrite worker disable.'
            );
            worker?.postMessage(disableCommand);
        }
    }
}