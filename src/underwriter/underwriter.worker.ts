import { JsonRpcProvider } from "ethers";
import pino, { LoggerOptions } from "pino";
import { workerData } from 'worker_threads';
import { UnderwriterWorkerData } from "./underwriter.service";
import { wait } from "src/common/utils";
import { PoolConfig } from "src/config/config.service";
import { STATUS_LOG_INTERVAL } from "src/logger/logger.service";
import { Store } from "src/store/store.lib";
import { SwapDescription } from "src/store/store.types";
import { EvalOrder, NewOrder, Order, UnderwriteOrder, UnderwriteOrderResult } from "./underwriter.types";
import { EvalQueue } from "./queues/eval-queue";
import { UnderwriteQueue } from "./queues/underwrite-queue";
import { ApprovalHandler } from "./approval-handler";
import { WalletInterface } from "src/wallet/wallet.interface";
import { MonitorInterface } from "src/monitor/monitor.interface";


class UnderwriterWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: UnderwriterWorkerData;

    readonly provider: JsonRpcProvider;

    readonly chainId: string;
    readonly chainName: string;

    readonly pools: PoolConfig[];

    readonly wallet: WalletInterface;
    readonly monitor: MonitorInterface;
    readonly approvalHandler: ApprovalHandler;

    readonly newOrdersQueue: NewOrder<EvalOrder>[] = [];
    readonly evalQueue: EvalQueue;
    readonly underwriteQueue: UnderwriteQueue;


    constructor() {
        this.config = workerData as UnderwriterWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;

        this.pools = this.config.pools;

        this.store = new Store();
        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );
        this.provider = this.initializeProvider(this.config.rpc);

        this.monitor = new MonitorInterface(this.config.monitorPort);
        this.wallet = new WalletInterface(this.config.walletPort);

        this.approvalHandler = new ApprovalHandler(
            this.config.retryInterval,
            this.wallet,
            this.logger
        );

        [this.evalQueue, this.underwriteQueue] = this.initializeQueues(
            this.chainId,
            this.pools,
            this.config.retryInterval,
            this.config.maxTries,
            this.config.underwriteBlocksMargin,
            this.monitor,
            this.wallet,
            this.store,
            this.provider,
            this.logger
        );

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
        chainId: string,
        pools: PoolConfig[],
        retryInterval: number,
        maxTries: number,
        underwriteBlocksMargin: number,
        monitor: MonitorInterface,
        wallet: WalletInterface,
        store: Store,
        provider: JsonRpcProvider,
        logger: pino.Logger,
    ): [EvalQueue, UnderwriteQueue] {
        const evalQueue = new EvalQueue(
            chainId,
            pools,
            retryInterval,
            maxTries,
            monitor,
            underwriteBlocksMargin,
            store,
            provider,
            logger
        );

        const underwriteQueue = new UnderwriteQueue(
            pools,
            retryInterval,
            maxTries,
            wallet,
            provider,
            logger
        );

        return [evalQueue, underwriteQueue];
    }

    private initiateIntervalStatusLog(): void {
        const logStatus = () => {
            const status = {
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

        await this.listenForOrders();

        while (true) {
            const evalOrders = await this.processNewOrdersQueue();

            await this.evalQueue.addOrders(...evalOrders);
            await this.evalQueue.processOrders();

            const [newUnderwriteOrders, ,] = this.evalQueue.getFinishedOrders();

            await this.approvalHandler.updateAllowances(...newUnderwriteOrders);

            await this.underwriteQueue.addOrders(...newUnderwriteOrders);
            await this.underwriteQueue.processOrders();
            const [confirmedOrders, rejectedOrders, ] = this.underwriteQueue.getFinishedOrders();

            await this.handleConfirmedOrders(confirmedOrders);
            await this.handleRejectedOrders(rejectedOrders);

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
            this.approvalHandler.registerAllowanceUse(
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
            this.approvalHandler.registerRequiredAllowanceDecrease(
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

            }).catch((rejection) => {
                this.logger.error(
                    { error: rejection, swapDescription },
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

        const order: Order = {
            poolId,
            fromChainId,
            fromVault,
            swapTxHash,
            swapBlockNumber,
            swapIdentifier,
            channelId,
            toVault,
            toAccount,
            fromAsset,
            toAssetIndex,
            fromAmount,
            minOut,
            units,
            fee,
            underwriteIncentiveX16
        };

        const processDelay = 0;   //TODO derive delay

        this.newOrdersQueue.push({
            processAt: Date.now() + processDelay,
            order
        });
    }

}

void new UnderwriterWorker().run();
