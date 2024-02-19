import { JsonRpcProvider } from "ethers";
import pino, { LoggerOptions } from "pino";
import { workerData } from 'worker_threads';
import { wait } from "src/common/utils";
import { PoolConfig } from "src/config/config.service";
import { STATUS_LOG_INTERVAL } from "src/logger/logger.service";
import { Store } from "src/store/store.lib";
import { ActiveUnderwriteDescription } from "src/store/store.types";
import { ExpireQueue } from "./queues/expire-queue";
import { WalletInterface } from "src/wallet/wallet.interface";
import { ExpirerWorkerData } from "./expirer.service";
import { ExpireOrder, ExpireOrderResult, ExpireEvalOrder } from "./expirer.types";
import { EvalQueue } from "./queues/eval-queue";


class UnderwriterWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: ExpirerWorkerData;

    readonly provider: JsonRpcProvider;

    readonly chainId: string;
    readonly chainName: string;

    readonly pools: PoolConfig[];

    readonly wallet: WalletInterface;

    readonly newOrdersQueue: ExpireEvalOrder[] = [];
    readonly evalQueue: EvalQueue;
    readonly expirerQueue: ExpireQueue;


    constructor() {
        this.config = workerData as ExpirerWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;

        this.pools = this.config.pools;

        this.store = new Store();
        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );
        this.provider = this.initializeProvider(this.config.rpc);

        this.wallet = new WalletInterface(this.config.walletPort);

        [this.evalQueue, this.expirerQueue] = this.initializeQueues(
            this.pools,
            this.config.retryInterval,
            this.config.maxTries,
            this.wallet,
            this.provider,
            this.store,
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
            worker: 'expirer',
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
        pools: PoolConfig[],
        retryInterval: number,
        maxTries: number,
        wallet: WalletInterface,
        provider: JsonRpcProvider,
        store: Store,
        logger: pino.Logger,
    ): [EvalQueue, ExpireQueue] {

        const evalQueue = new EvalQueue(
            retryInterval,
            maxTries,
            store,
            logger
        )

        const expirerQueue = new ExpireQueue(
            pools,
            retryInterval,
            maxTries,
            wallet,
            provider,
            logger
        );

        return [evalQueue, expirerQueue];
    }

    private initiateIntervalStatusLog(): void {
        const logStatus = () => {
            const status = {
                capacity: this.getExpirerCapacity(),
                newOrdersQueue: this.newOrdersQueue.length,
                evalQueue: this.evalQueue.size,
                evalRetryQueue: this.evalQueue.retryQueue.length,
                expirerQueue: this.expirerQueue.size,
                expirerRetryQueue: this.expirerQueue.retryQueue.length
            };
            this.logger.info(status, 'Expirer status.');
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }



    // Main handler
    // ********************************************************************************************
    async run(): Promise<void> {
        this.logger.info(
            `Expirer worker started.`
        );

        await this.expirerQueue.init();

        await this.listenForOrders();

        while (true) {
            const evalOrders = this.processNewOrdersQueue();

            await this.evalQueue.addOrders(...evalOrders);
            await this.evalQueue.processOrders();

            const [expireOrders, ,] = this.evalQueue.getFinishedOrders();

            await this.expirerQueue.addOrders(...expireOrders);
            await this.expirerQueue.processOrders();
            const [confirmedOrders, rejectedOrders,] = this.expirerQueue.getFinishedOrders();

            await this.handleConfirmedOrders(confirmedOrders);
            await this.handleRejectedOrders(rejectedOrders);

            await wait(this.config.processingInterval);
        }
    }


    private async handleConfirmedOrders(
        confirmedSubmitOrders: ExpireOrderResult[],
    ): Promise<void> {

        for (const confirmedOrder of confirmedSubmitOrders) {

            const orderDescription = {
                toChainId: confirmedOrder.toChainId,
                toInterface: confirmedOrder.toInterface,
                underwriteId: confirmedOrder.underwriteId,
                txHash: confirmedOrder.txReceipt.hash,
            };

            this.logger.debug(
                orderDescription,
                `Successful expire processing: expire submitted.`,
            );
        }
    }

    private async handleRejectedOrders(
        rejectedSubmitOrders: ExpireOrder[],
    ): Promise<void> {

        for (const rejectedOrder of rejectedSubmitOrders) {

            const orderDescription = {
                toChainId: rejectedOrder.toChainId,
                toInterface: rejectedOrder.toInterface,
                underwriteId: rejectedOrder.underwriteId,
            };

            this.logger.debug(
                orderDescription,
                `Unsuccessful expire processing: expire rejected.`,
            );
        }
    }

    private async listenForOrders(): Promise<void> {
        this.logger.info(`Listening for SwapUnderwritten events`);

        await this.store.on(Store.onSwapUnderwrittenChannel, (underwriteDescription: ActiveUnderwriteDescription) => {

            if (underwriteDescription.toChainId != this.chainId) {
                return;
            }

            //TODO currently expiring orders as soon as they are observed (for testing)
            //TODO implement 'when to expire' logic
            this.addExpireOrder(
                underwriteDescription.poolId,
                underwriteDescription.toChainId,
                underwriteDescription.toInterface,
                underwriteDescription.underwriteId
            );

        });
    }

    private processNewOrdersQueue(): ExpireEvalOrder[] {
        const capacity = this.getExpirerCapacity();

        let i;
        for (i = 0; i < this.newOrdersQueue.length; i++) {
            if (i + 1 > capacity) {
                break;
            }
        }

        return this.newOrdersQueue.splice(0, i);
    }

    private getExpirerCapacity(): number {
        return Math.max(
            0,
            this.config.maxPendingTransactions
            - this.evalQueue.size
            - this.expirerQueue.size
        );
    }

    private addExpireOrder(
        poolId: string,
        toChainId: string,
        toInterface: string,
        underwriteId: string,
    ) {
        this.logger.debug(
            { poolId, toChainId, toInterface, underwriteId },
            `Expire underwrite order received.`
        );

        const order: ExpireEvalOrder = {
            poolId,
            toChainId,
            toInterface,
            underwriteId,
        };

        this.newOrdersQueue.push(order);
    }

}

void new UnderwriterWorker().run();
