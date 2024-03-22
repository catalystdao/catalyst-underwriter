import { JsonRpcProvider } from "ethers";
import pino, { LoggerOptions } from "pino";
import { parentPort, workerData } from 'worker_threads';
import { UnderwriterWorkerCommand, UnderwriterWorkerCommandId, UnderwriterWorkerData } from "./underwriter.service";
import { tryErrorToString, wait } from "src/common/utils";
import { AMBConfig, PoolConfig, TokenConfig } from "src/config/config.types";
import { STATUS_LOG_INTERVAL } from "src/logger/logger.service";
import { Store } from "src/store/store.lib";
import { SwapDescription } from "src/store/store.types";
import { EvalOrder, NewOrder, Order, UnderwriteOrder, UnderwriteOrderResult } from "./underwriter.types";
import { EvalQueue } from "./queues/eval-queue";
import { UnderwriteQueue } from "./queues/underwrite-queue";
import { TokenHandler } from "./token-handler/token-handler";
import { WalletInterface } from "src/wallet/wallet.interface";


class UnderwriterWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: UnderwriterWorkerData;

    readonly provider: JsonRpcProvider;

    readonly chainId: string;
    readonly chainName: string;

    readonly tokens: Record<string, TokenConfig>;
    readonly pools: PoolConfig[];
    readonly ambs: Record<string, AMBConfig>;

    readonly wallet: WalletInterface;
    readonly tokenHandler: TokenHandler;

    readonly newOrdersQueue: NewOrder<EvalOrder>[] = [];
    readonly evalQueue: EvalQueue;
    readonly underwriteQueue: UnderwriteQueue;


    constructor() {
        this.config = workerData as UnderwriterWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;

        this.tokens = this.config.tokens;
        this.pools = this.config.pools;
        this.ambs = this.config.ambs;

        this.store = new Store();
        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );
        this.provider = this.initializeProvider(this.config.rpc);

        this.wallet = new WalletInterface(this.config.walletPort);

        this.tokenHandler = new TokenHandler(
            this.chainId,
            this.config.retryInterval,
            this.pools,
            this.tokens,
            this.config.walletPublicKey,
            this.wallet,
            this.provider,
            this.logger
        );

        [this.evalQueue, this.underwriteQueue] = this.initializeQueues(
            this.config.enabled,
            this.chainId,
            this.tokens,
            this.pools,
            this.ambs,
            this.config.retryInterval,
            this.config.maxTries,
            this.config.underwriteBlocksMargin,
            this.tokenHandler,
            this.config.walletPublicKey,
            this.wallet,
            this.store,
            this.provider,
            this.logger
        );

        this.listenForCommands();

        void this.initiateIntervalStatusLog();
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(
        chainId: string,
        loggerOptions: LoggerOptions,
    ): pino.Logger {
        return pino(loggerOptions).child({
            worker: 'underwriter',
            chain: chainId,
        });
    }

    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(
            rpc,
            undefined,
            { staticNetwork: true }
        )
    }

    private initializeQueues(
        enabled: boolean,
        chainId: string,
        tokens: Record<string, TokenConfig>,
        pools: PoolConfig[],
        ambs: Record<string, AMBConfig>,
        retryInterval: number,
        maxTries: number,
        underwriteBlocksMargin: number,
        tokenHandler: TokenHandler,
        walletPublicKey: string,
        wallet: WalletInterface,
        store: Store,
        provider: JsonRpcProvider,
        logger: pino.Logger,
    ): [EvalQueue, UnderwriteQueue] {
        const evalQueue = new EvalQueue(
            enabled,
            chainId,
            tokens,
            pools,
            retryInterval,
            maxTries,
            underwriteBlocksMargin,
            tokenHandler,
            store,
            provider,
            logger
        );

        const underwriteQueue = new UnderwriteQueue(
            pools,
            ambs,
            retryInterval,
            maxTries,
            walletPublicKey,
            wallet,
            provider,
            logger
        );

        return [evalQueue, underwriteQueue];
    }

    private initiateIntervalStatusLog(): void {
        const logStatus = () => {
            const status = {
                isUnderwritingEnabled: this.evalQueue.isUnderwritingEnabled(),
                capacity: this.getUnderwritterCapacity(),
                newOrdersQueue: this.newOrdersQueue.length,
                evalQueue: this.evalQueue.size,
                evalRetryQueue: this.evalQueue.retryQueue.length,
                underwriteQueue: this.underwriteQueue.size,
                underwriteRetryQueue: this.underwriteQueue.retryQueue.length,
            };
            this.logger.info(status, 'Underwriter status.');
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }



    // Main handler
    // ********************************************************************************************
    async run(): Promise<void> {
        this.logger.info(
            `Underwriter worker started.`
        );

        await this.evalQueue.init();
        await this.underwriteQueue.init();

        await this.tokenHandler.init();

        await this.listenForOrders();

        while (true) {
            const evalOrders = await this.processNewOrdersQueue();

            await this.evalQueue.addOrders(...evalOrders);
            await this.evalQueue.processOrders();

            const [newUnderwriteOrders, ,] = this.evalQueue.getFinishedOrders();

            // ! The following call blocks the pipeline until the submitted approvals are
            // ! confirmed! Approvals should be configured to not be issued at a high frequency
            // ! (see the 'allowanceBuffer' configuration).
            // ! Failed allowance updates are not retried, thus any depending underwrites will
            // ! fail. However, consequtive 'processOrders' calls of this handler will always
            // ! reissue any required allowance updates.
            await this.tokenHandler.processNewAllowances(...newUnderwriteOrders);

            await this.underwriteQueue.addOrders(...newUnderwriteOrders);
            await this.underwriteQueue.processOrders();
            const [confirmedOrders, rejectedOrders, failedOrders] = this.underwriteQueue.getFinishedOrders();

            await this.handleConfirmedOrders(confirmedOrders);
            await this.handleRejectedOrders(rejectedOrders);
            await this.handleFailedOrders(failedOrders);

            await wait(this.config.processingInterval);
        }
    }


    private async handleConfirmedOrders(
        confirmedSubmitOrders: UnderwriteOrderResult[],
    ): Promise<void> {

        for (const confirmedOrder of confirmedSubmitOrders) {
        // Registering the 'use' of 'toAssetAllowance is an approximation, as the allowance is an
        // overestimate. Thus, in practice a small allowance will be left for the interface. This
        // leftover will be removed once a new allowance for other orders is set. 
            this.tokenHandler.registerAllowanceUse(
                confirmedOrder.interfaceAddress,
                confirmedOrder.toAsset,
                confirmedOrder.toAssetAllowance
            );

            //TODO add underwriteId to log? (note that this depends on the AMB implementation)
            const orderDescription = {
                fromVault: confirmedOrder.fromVault,
                fromChainId: confirmedOrder.fromChainId,
                swapTxHash: confirmedOrder.swapTxHash,
                swapId: confirmedOrder.swapIdentifier,
                txHash: confirmedOrder.txReceipt.hash,
            };

            this.logger.debug(
                orderDescription,
                `Successful underwrite processing: underwrite submitted.`,
            );
        }
    }

    private async handleRejectedOrders(
        rejectedSubmitOrders: UnderwriteOrder[],
    ): Promise<void> {

        for (const rejectedOrder of rejectedSubmitOrders) {
            this.tokenHandler.registerRequiredAllowanceDecrease(
                rejectedOrder.interfaceAddress,
                rejectedOrder.toAsset,
                rejectedOrder.toAssetAllowance
            )
        }
    }

    private async handleFailedOrders(
        failedSubmitOrders: UnderwriteOrder[],
    ): Promise<void> {

        for (const rejectedOrder of failedSubmitOrders) {
            this.tokenHandler.registerRequiredAllowanceDecrease(
                rejectedOrder.interfaceAddress,
                rejectedOrder.toAsset,
                rejectedOrder.toAssetAllowance
            )
        }
    }

    private async listenForOrders(): Promise<void> {
        this.logger.info(`Listening for SendAsset events`); //TODO the current store architecture will cause the following to trigger on all 'SendAsset' object changes
    
        await this.store.on(Store.onSendAssetChannel, (swapDescription: SwapDescription) => {

            if (swapDescription.toChainId != this.chainId) {
                return;
            }

            this.store.getSwapState(
                swapDescription.fromChainId,
                swapDescription.fromVault,
                swapDescription.swapId
            ).then((swapStatus) => {
                if (swapStatus == null) {
                    throw new Error(`No data found for the swap description ${swapDescription}.`)
                }

                void this.addUnderwriteOrder(
                    swapStatus.poolId,
                    swapStatus.fromChainId,
                    swapStatus.fromVault,
                    swapStatus.sendAssetEvent!.txHash,
                    swapStatus.sendAssetEvent!.blockNumber,
                    swapStatus.sendAssetEvent!.observedAtBlockNumber,
                    swapStatus.swapId,
                    swapStatus.sendAssetEvent!.fromChannelId,
                    swapStatus.toVault,
                    swapStatus.toAccount,
                    swapStatus.fromAsset,
                    swapStatus.sendAssetEvent!.toAssetIndex,
                    swapStatus.sendAssetEvent!.fromAmount,
                    swapStatus.sendAssetEvent!.minOut,
                    swapStatus.units,
                    swapStatus.sendAssetEvent!.fee,
                    swapStatus.sendAssetEvent!.underwriteIncentiveX16,
                );

            }).catch((rejection: any) => {
                this.logger.error(
                    { error: tryErrorToString(rejection), swapDescription },
                    `Failed to retrieve the 'SwapStatus'.`
                );
            })
            
        });
    }

    private async processNewOrdersQueue(): Promise<EvalOrder[]> {
        const currentTimestamp = Date.now();
        const capacity = this.getUnderwritterCapacity();

        let i;
        for (i = 0; i < this.newOrdersQueue.length; i++) {
            const nextNewOrder = this.newOrdersQueue[i];

            if (nextNewOrder.processAt > currentTimestamp || i + 1 > capacity) {
                break;
            }
        }

        const ordersToEval = this.newOrdersQueue.splice(0, i).map((newOrder) => {
            return newOrder.order;
        });

        return ordersToEval;
    }

    private getUnderwritterCapacity(): number {
        return Math.max(
            0,
            this.config.maxPendingTransactions
                - this.evalQueue.size
                - this.underwriteQueue.size
        );
    }

    //TODO refactor arguments? (abstract into different objects?)
    private async addUnderwriteOrder(
        poolId: string,
        fromChainId: string,
        fromVault: string,
        swapTxHash: string,
        swapBlockNumber: number,
        swapObservedAtBlockNumber: number,
        swapIdentifier: string,
        channelId: string,
        toVault: string,
        toAccount: string,
        fromAsset: string,
        toAssetIndex: bigint,
        fromAmount: bigint,
        minOut: bigint,
        units: bigint,
        fee: bigint,
        underwriteIncentiveX16: bigint
    ) {
        this.logger.debug(
            { fromVault, fromChainId, swapTxHash, swapId: swapIdentifier },
            `Underwrite order received.`
        );

        const submissionDeadline = Date.now() + this.config.maxSubmissionDelay;

        const sourceIdentifier = this.getSourceIdentifierOfSwap(poolId, fromChainId);
        if (sourceIdentifier == undefined) {
            this.logger.warn(
                { poolId, fromVault, fromChainId, swapTxHash, swapId: swapIdentifier },
                'Unable to find the \'sourceIdentifier\' corresponding to the received asset swap. Skipping underwrite.'
            );
            return;
        }

        const poolConfig = this.pools.find(pool => pool.id == poolId);
        if (poolConfig == undefined) {
            this.logger.warn(
                { poolId, fromVault, fromChainId, swapTxHash, swapId: swapIdentifier },
                'Unable to find the pool configuration corresponding to the given \'poolId\'. Skipping underwrite.'
            );
            return;
        }

        const order: Order = {
            poolId,
            amb: poolConfig.amb,
            fromChainId,
            fromVault,
            swapTxHash,
            swapBlockNumber,
            swapObservedAtBlockNumber,
            swapIdentifier,
            sourceIdentifier,
            channelId,
            toVault,
            toAccount,
            fromAsset,
            toAssetIndex,
            fromAmount,
            minOut,
            units,
            fee,
            underwriteIncentiveX16,
            submissionDeadline,
        };

        const processDelay = this.config.underwriteDelay;

        this.newOrdersQueue.push({
            processAt: Date.now() + processDelay,
            order
        });
    }

    private getSourceIdentifierOfSwap(
        poolId: string,
        fromChainId: string,
    ): string | undefined {
        const poolConfig = this.pools.find((pool) => pool.id == poolId);
        if (poolConfig == undefined) {
            return undefined;
        }

        const vaultConfig = poolConfig.vaults.find((vault) => vault.chainId == this.chainId);
        if (vaultConfig == undefined) {
            return undefined;
        }

        for (const [channelId, chainId] of Object.entries(vaultConfig.channels)) {
            if (chainId == fromChainId) return channelId;
        }

        return undefined;
    }



    // Commands handler
    // ********************************************************************************************
    private listenForCommands(): void {
        parentPort?.on('message', (data: any) => {
            void this.handleWorkerCommand(data);
        })
    }

    private async handleWorkerCommand(command: UnderwriterWorkerCommand): Promise<void> {
        switch (command.id) {
            case UnderwriterWorkerCommandId.Enable:
                this.evalQueue.enableUnderwrites();
                break;
            case UnderwriterWorkerCommandId.Disable:
                this.evalQueue.disableUnderwrite();
                break;
        }
    }

}

void new UnderwriterWorker().run();
