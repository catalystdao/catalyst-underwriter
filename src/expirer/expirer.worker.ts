import { JsonRpcProvider } from "ethers";
import pino, { LoggerOptions } from "pino";
import { workerData, MessagePort } from 'worker_threads';
import { tryErrorToString, wait } from "src/common/utils";
import { STATUS_LOG_INTERVAL } from "src/logger/logger.service";
import { Store } from "src/store/store.lib";
import { ActiveUnderwriteDescription, CompletedUnderwriteDescription } from "src/store/store.types";
import { ExpireQueue } from "./queues/expire-queue";
import { WalletInterface } from "src/wallet/wallet.interface";
import { ExpirerWorkerData } from "./expirer.service";
import { ExpireOrder, ExpireOrderResult, ExpireEvalOrder } from "./expirer.types";
import { EvalQueue } from "./queues/eval-queue";
import { MonitorInterface, MonitorStatus } from "src/monitor/monitor.interface";
import { Resolver, loadResolver } from "src/resolvers/resolver";


class ExpirerWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: ExpirerWorkerData;

    readonly provider: JsonRpcProvider;

    readonly chainId: string;
    readonly chainName: string;

    readonly resolver: Resolver;

    private currentStatus: MonitorStatus | null;
    private transactionBlockNumber: number | undefined;   // For chains like Arbitrum which use l1 and l2 block numbers

    readonly underwriterPublicKey: string;
    readonly wallet: WalletInterface;

    readonly newOrdersQueue: ExpireEvalOrder[] = [];
    readonly evalQueue: EvalQueue;
    readonly expirerQueue: ExpireQueue;

    constructor() {
        this.config = workerData as ExpirerWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;

        this.store = new Store();
        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );
        this.provider = this.initializeProvider(this.config.rpc);

        this.resolver = this.loadResolver(
            this.config.resolver,
            this.provider,
            this.logger
        );

        this.underwriterPublicKey = this.config.underwriterPublicKey.toLowerCase();
        this.wallet = new WalletInterface(this.config.walletPort);

        [this.evalQueue, this.expirerQueue] = this.initializeQueues(
            this.config.retryInterval,
            this.config.maxTries,
            this.wallet,
            this.provider,
            this.store,
            this.logger
        );

        this.startListeningToMonitor(this.config.monitorPort);

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

    private loadResolver(
        resolver: string | null,
        provider: JsonRpcProvider,
        logger: pino.Logger
    ): Resolver {
        return loadResolver(resolver, provider, logger);
    }

    private initializeQueues(
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
            retryInterval,
            maxTries,
            wallet,
            provider,
            logger
        );

        return [evalQueue, expirerQueue];
    }

    private startListeningToMonitor(port: MessagePort): MonitorInterface {
        const monitor = new MonitorInterface(port);

        monitor.addListener((status) => {
            this.transactionBlockNumber = undefined;
            this.currentStatus = status;
        });

        return monitor;
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

        // Wait for the 'monitor' to get initialized
        while (this.currentStatus == undefined) {
            await wait(this.config.retryInterval);
        }

        await this.expirerQueue.init();

        await this.listenForOrders();

        while (true) {
            const evalOrders = await this.processNewOrdersQueue();

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

            this.addExpireOrder(
                underwriteDescription.toChainId,
                underwriteDescription.toInterface,
                underwriteDescription.underwriter,
                underwriteDescription.underwriteId,
                underwriteDescription.expiry
            );

        });

        await this.store.on(Store.onSwapUnderwriteCompleteChannel, (underwriteDescription: CompletedUnderwriteDescription) => {

            if (underwriteDescription.toChainId != this.chainId) {
                return;
            }

            this.removeExpireOrder(
                underwriteDescription.toInterface,
                underwriteDescription.underwriteId,
            );

        });

    }

    private async getCurrentTransactionBlockNumber(): Promise<number> {
        if (this.transactionBlockNumber != undefined) {
            return this.transactionBlockNumber;
        }

        const blockNumber = this.currentStatus?.blockNumber;
        if (blockNumber == undefined) {
            throw new Error('Unable to query transaction block number: monitor block number is undefined.')
        }

        let transactionBlockNumber: number | undefined;
        while (transactionBlockNumber == undefined) {
            try {
                transactionBlockNumber = await this.resolver.getTransactionBlockNumber(blockNumber);
            }
            catch (error) {
                this.logger.warn(
                    {
                        blockNumber,
                        error: tryErrorToString(error),
                    },
                    `Failed to query the transaction block number. Worker stalled until succesful query.`
                );
                await wait(this.config.retryInterval);
            }
        }

        this.transactionBlockNumber = transactionBlockNumber;
        return this.transactionBlockNumber;
    }

    private async processNewOrdersQueue(): Promise<ExpireEvalOrder[]> {
        const capacity = this.getExpirerCapacity();
        const currentBlockNumber = await this.getCurrentTransactionBlockNumber();

        let i;
        for (i = 0; i < this.newOrdersQueue.length; i++) {
            const nextNewOrder = this.newOrdersQueue[i];

            if (nextNewOrder.expireAt > currentBlockNumber || i + 1 > capacity) {
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
        toChainId: string,
        toInterface: string,
        underwriter: string,
        underwriteId: string,
        expiry: number,
    ) {
        this.logger.debug(
            { toInterface, underwriteId },
            `Expire underwrite order received.`
        );

        const expireAt = underwriter.toLowerCase() == this.underwriterPublicKey
            ? expiry - this.config.expireBlocksMargin
            : expiry;

        const newOrder: ExpireEvalOrder = {
            toChainId,
            toInterface,
            underwriteId,
            expireAt
        };

        // Insert the new order into the 'newOrdersQueue' keeping the queue order.
        const insertIndex = this.newOrdersQueue.findIndex(order => {
            return order.expireAt > newOrder.expireAt;
        });

        if (insertIndex == -1) {
            this.newOrdersQueue.push(newOrder);
        } else {
            this.newOrdersQueue.splice(insertIndex, 0, newOrder);
        }
    }

    private removeExpireOrder(
        toInterface: string,
        underwriteId: string,
    ) {
        this.logger.debug(
            { toInterface, underwriteId },
            `Expire underwrite order removal received.`
        );
        
        const removalIndex = this.newOrdersQueue.findIndex(order => {
            return order.toInterface == toInterface && order.underwriteId == underwriteId;
        });

        if (removalIndex != -1) {
            this.newOrdersQueue.splice(removalIndex, 1);
        } else {
            this.logger.warn(
                { toInterface, underwriteId },
                `No pending expire order for the given underwrite.`
            );
        }
    }

}

void new ExpirerWorker().run();
