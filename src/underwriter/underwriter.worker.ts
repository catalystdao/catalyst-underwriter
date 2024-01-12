import { JsonRpcProvider, Wallet, Provider } from "ethers";
import pino from "pino";
import { workerData } from 'worker_threads';
import { UnderwriterWorkerData } from "./underwriter.service";
import { wait } from "src/common/utils";
import { PoolConfig } from "src/config/config.service";
import { STATUS_LOG_INTERVAL } from "src/logger/logger.service";
import { Store } from "src/store/store.lib";
import { SwapDescription } from "src/store/store.types";
import { EvalOrder, GasFeeConfig, NewOrder, Order } from "./underwriter.types";
import { EvalQueue } from "./queues/eval-queue";
import { UnderwriteQueue } from "./queues/underwrite-queue";


const MAX_GAS_PRICE_ADJUSTMENT_FACTOR = 5;


class UnderwriterWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: UnderwriterWorkerData;

    readonly provider: JsonRpcProvider;
    readonly signer: Wallet;

    readonly chainId: string;
    readonly chainName: string;

    readonly pools: PoolConfig[];

    readonly newOrdersQueue: NewOrder<EvalOrder>[] = [];
    readonly evalQueue: EvalQueue;
    readonly underwriteQueue: UnderwriteQueue;


    constructor() {
        this.config = workerData as UnderwriterWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;

        this.pools = this.config.pools;

        this.store = new Store();
        this.logger = this.initializeLogger(this.chainId);
        this.provider = this.initializeProvider(this.config.rpc);
        this.signer = this.initializeSigner(this.config.privateKey, this.provider);

        [this.evalQueue, this.underwriteQueue] = this.initializeQueues(
            this.pools,
            this.config.retryInterval,
            this.config.maxTries,
            this.config.transactionTimeout,
            this.loadGasFeeConfig(
                this.config.gasPriceAdjustmentFactor,
                this.config.maxAllowedGasPrice,
                this.config.maxFeePerGas,
                this.config.maxPriorityFeeAdjustmentFactor,
                this.config.maxAllowedPriorityFeePerGas
            ),
            this.signer,
            this.logger
        );

        void this.initiateIntervalStatusLog();
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(chainId: string): pino.Logger {
        return pino(this.config.loggerOptions).child({
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

    private initializeSigner(privateKey: string, provider: Provider): Wallet {
        return new Wallet(privateKey, provider);
    }

    private initializeQueues(
        pools: PoolConfig[],
        retryInterval: number,
        maxTries: number,
        transactionTimeout: number,
        gasFeeConfig: GasFeeConfig,
        signer: Wallet,
        logger: pino.Logger,
    ): [EvalQueue, UnderwriteQueue] {
        const evalQueue = new EvalQueue(
            pools,
            retryInterval,
            maxTries,
            signer,
            logger
        );

        const underwriteQueue = new UnderwriteQueue(
            pools,
            retryInterval,
            maxTries,
            transactionTimeout,
            gasFeeConfig,
            signer,
            logger
        )

        return [evalQueue, underwriteQueue];
    }

    private loadGasFeeConfig(
        gasPriceAdjustmentFactor?: number,
        maxAllowedGasPrice?: bigint,
        maxFeePerGas?: bigint,
        maxPriorityFeeAdjustmentFactor?: number,
        maxAllowedPriorityFeePerGas?: bigint
    ): GasFeeConfig {

        if (
            gasPriceAdjustmentFactor != undefined &&
            gasPriceAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR
        ) {
            throw new Error(
                `Failed to load gas fee configuration. 'gasPriceAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR})`,
            );
        }

        if (
            maxPriorityFeeAdjustmentFactor != undefined &&
            maxPriorityFeeAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR
        ) {
            throw new Error(
                `Failed to load gas fee configuration. 'maxPriorityFeeAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR})`,
            );
        }

        return {
            gasPriceAdjustmentFactor,
            maxAllowedGasPrice,
            maxFeePerGas,
            maxPriorityFeeAdjustmentFactor,
            maxAllowedPriorityFeePerGas,
        };
    }

    private initiateIntervalStatusLog(): void {
        const logStatus = () => {
            const status = {
                capacity: this.getUnderwritterCapacity(),
                pendingTransactions: this.underwriteQueue.pendingTransactionsCount,
                newOrdersQueue: this.newOrdersQueue.length,
                evalQueue: this.evalQueue.queue.length,
                evalRetryQueue: this.evalQueue.retryQueue.length,
                underwriteQueue: this.underwriteQueue.queue.length,
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
            `Underwriter worker started on ${this.chainName} (${this.chainId})`
        );

        await this.evalQueue.init();
        await this.underwriteQueue.init();

        await this.listenForOrders();

        while (true) {
            const evalOrders = await this.processNewOrdersQueue();

            this.evalQueue.addOrders(...evalOrders);
            const validOrders = await this.evalQueue.processOrders();

            this.underwriteQueue.addOrders(...validOrders);
            await this.underwriteQueue.processOrders();

            await this.evalQueue.processRetryOrders();
            await this.underwriteQueue.processRetryOrders();

            await wait(this.config.processingInterval);
        }
    }

    private async listenForOrders(): Promise<void> {
        this.logger.info(`Listening for SendAsset events`); //TODO the current store architecture will cause the following to trigger on all 'SendAsset' object changes
    
        await this.store.on(Store.onSendAssetChannel, (swapDescription: SwapDescription) => {

            if (swapDescription.toChainId != this.chainId) {
                return;
            }

            this.store.getSwapStatus(
                swapDescription.fromChainId,
                swapDescription.fromVault,
                swapDescription.txHash
            ).then((swapStatus) => {
                if (swapStatus == null) {
                    throw new Error(`No data found for the swap description ${swapDescription}.`)
                }

                void this.addUnderwriteOrder(
                    swapStatus.poolId,
                    swapStatus.fromChainId,
                    swapStatus.fromVault,
                    swapStatus.txHash,
                    swapStatus.swapIdentifier,
                    swapStatus.channelId,
                    swapStatus.toVault,
                    swapStatus.toAccount,
                    swapStatus.fromAsset,
                    swapStatus.toAssetIndex,
                    swapStatus.fromAmount,
                    swapStatus.minOut,
                    swapStatus.units,
                    swapStatus.fee,
                    swapStatus.underwriteIncentiveX16,
                );

            }).catch((rejection) => {
                this.logger.error(rejection, `Failed to retrieve the 'SwapStatus' for the swap description ${swapDescription}.`);
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
            this.config.maxPendingTransactions -
            (
                this.evalQueue.queue.length
                + this.evalQueue.retryQueue.length
                + this.underwriteQueue.pendingTransactionsCount
                + this.underwriteQueue.queue.length
                + this.underwriteQueue.retryQueue.length
            )
        );
    }

    //TODO refactor arguments? (abstract into different objects?)
    private async addUnderwriteOrder(
        poolId: string,
        fromChainId: string,
        fromVault: string,
        txHash: string,
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
            `Underwrite order received (SendAsset txHash: ${txHash}, swapId: ${swapIdentifier})`
        );

        const order: Order = {
            poolId,
            fromChainId,
            fromVault,
            txHash,
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