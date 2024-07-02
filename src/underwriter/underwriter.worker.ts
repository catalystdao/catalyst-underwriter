import { JsonRpcProvider } from "ethers";
import pino, { LoggerOptions } from "pino";
import { parentPort, workerData } from 'worker_threads';
import { UnderwriterWorkerCommand, UnderwriterWorkerCommandId, UnderwriterWorkerData } from "./underwriter.service";
import { tryErrorToString, wait } from "src/common/utils";
import { AMBConfig, EndpointConfig } from "src/config/config.types";
import { STATUS_LOG_INTERVAL } from "src/logger/logger.service";
import { Store } from "src/store/store.lib";
import { SwapDescription } from "src/store/store.types";
import { DiscoverOrder, NewOrder, UnderwriteOrder, UnderwriteOrderResult, UnderwriterTokenConfig } from "./underwriter.types";
import { EvalQueue } from "./queues/eval-queue";
import { UnderwriteQueue } from "./queues/underwrite-queue";
import { TokenHandler } from "./token-handler/token-handler";
import { WalletInterface } from "src/wallet/wallet.interface";
import { DiscoverQueue } from "./queues/discover-queue";
import { Resolver, loadResolver } from "src/resolvers/resolver";


class UnderwriterWorker {
    private readonly store: Store;
    private readonly logger: pino.Logger;

    private readonly config: UnderwriterWorkerData;

    private readonly provider: JsonRpcProvider;

    private readonly chainId: string;
    private readonly chainName: string;

    private readonly resolver: Resolver;

    private readonly endpoints: EndpointConfig[];
    private readonly tokens: Record<string, UnderwriterTokenConfig>;
    private readonly ambs: Record<string, AMBConfig>;

    private readonly wallet: WalletInterface;
    private readonly tokenHandler: TokenHandler;

    private readonly newOrdersQueue: NewOrder<DiscoverOrder>[] = [];
    private readonly discoverQueue: DiscoverQueue;
    private readonly evalQueue: EvalQueue;
    private readonly underwriteQueue: UnderwriteQueue;


    constructor() {
        this.config = workerData as UnderwriterWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;

        this.endpoints = this.config.endpointConfigs;
        this.tokens = this.config.tokens;
        this.ambs = this.config.ambs;

        this.store = new Store();
        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );
        this.provider = this.initializeProvider(this.config.rpc);

        this.resolver = loadResolver(
            this.config.resolver,
            this.provider,
            this.logger
        );

        this.wallet = new WalletInterface(this.config.walletPort);

        this.tokenHandler = new TokenHandler(
            this.chainId,
            this.config.retryInterval,
            this.endpoints,
            this.tokens,
            this.config.walletPublicKey,
            this.wallet,
            this.provider,
            this.logger
        );

        [this.discoverQueue, this.evalQueue, this.underwriteQueue] = this.initializeQueues(
            this.config.enabled,
            this.chainId,
            this.endpoints,
            this.tokens,
            this.ambs,
            this.config.retryInterval,
            this.config.maxTries,
            this.config.underwritingCollateral,
            this.config.allowanceBuffer,
            this.config.maxUnderwriteDelay,
            this.config.minRelayDeadlineDuration,
            this.config.minMaxGasDelivery,
            this.tokenHandler,
            this.resolver,
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
        endpointConfigs: EndpointConfig[],
        tokens: Record<string, UnderwriterTokenConfig>,
        ambs: Record<string, AMBConfig>,
        retryInterval: number,
        maxTries: number,
        underwritingCollateral: number,
        allowanceBuffer: number,
        maxUnderwriteDelay: number,
        minRelayDeadlineDuration: bigint,
        minMaxGasDelivery: bigint,
        tokenHandler: TokenHandler,
        resolver: Resolver,
        walletPublicKey: string,
        wallet: WalletInterface,
        store: Store,
        provider: JsonRpcProvider,
        logger: pino.Logger,
    ): [DiscoverQueue, EvalQueue, UnderwriteQueue] {
        const discoverQueue = new DiscoverQueue(
            chainId,
            endpointConfigs,
            tokens,
            retryInterval,
            maxTries,
            store,
            provider,
            logger
        );

        const evalQueue = new EvalQueue(
            enabled,
            chainId,
            tokens,
            retryInterval,
            maxTries,
            underwritingCollateral,
            allowanceBuffer,
            maxUnderwriteDelay,
            minRelayDeadlineDuration,
            minMaxGasDelivery,
            tokenHandler,
            wallet,
            provider,
            logger
        );

        const underwriteQueue = new UnderwriteQueue(
            chainId,
            ambs,
            retryInterval,
            maxTries,
            resolver,
            walletPublicKey,
            wallet,
            provider,
            logger
        );

        return [discoverQueue, evalQueue, underwriteQueue];
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
            const discoverOrders = await this.processNewOrdersQueue();

            await this.discoverQueue.addOrders(...discoverOrders);
            await this.discoverQueue.processOrders();
            const [evalOrders] = this.discoverQueue.getFinishedOrders();

            await this.evalQueue.addOrders(...evalOrders);
            await this.evalQueue.processOrders();
            const [underwriteOrders] = this.evalQueue.getFinishedOrders();

            //TODO if the following fails, does it get retried at an 'processingInterval' interval? (that is too quick and will cause rpc errors)
            // ! The following call blocks the pipeline until the submitted approvals are
            // ! confirmed! Approvals should be configured to not be issued at a high frequency
            // ! (see the 'allowanceBuffer' configuration).
            // ! Failed allowance updates are not retried, thus any depending underwrites will
            // ! fail. However, consequtive 'processOrders' calls of this handler will always
            // ! reissue any required allowance updates.
            await this.tokenHandler.processNewAllowances(...underwriteOrders);

            await this.underwriteQueue.addOrders(...underwriteOrders);
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

        await this.store.on(Store.onSendAssetChannel, (event: any) => {

            //TODO verify event format
            const swapDescription = event as SwapDescription;

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

                const sendAssetDetails = swapStatus.ambMessageSendAssetDetails!;

                void this.addUnderwriteOrder(
                    swapStatus.fromChainId,
                    swapStatus.fromVault,
                    swapStatus.swapId,
                    sendAssetDetails.toVault,
                    sendAssetDetails.toAccount,
                    sendAssetDetails.units,
                    sendAssetDetails.toAssetIndex,
                    sendAssetDetails.minOut,
                    sendAssetDetails.underwriteIncentiveX16,
                    sendAssetDetails.calldata,
                    sendAssetDetails.txHash,
                    sendAssetDetails.blockNumber,
                    sendAssetDetails.blockTimestamp,
                    sendAssetDetails.amb,
                    sendAssetDetails.fromChannelId,
                    sendAssetDetails.toIncentivesAddress,
                    sendAssetDetails.toApplication, // ! It must be verified that the 'toApplication' should be the 'interface'
                    sendAssetDetails.messageIdentifier,
                    sendAssetDetails.deadline,
                    sendAssetDetails.maxGasDelivery,
                );

            }).catch((rejection: any) => {
                this.logger.error(
                    { error: tryErrorToString(rejection), swapDescription },
                    `Failed to retrieve the 'SwapStatus'.`
                );
            })

        });
    }

    private async processNewOrdersQueue(): Promise<DiscoverOrder[]> {
        const currentTimestamp = Date.now();
        const capacity = this.getUnderwritterCapacity();

        let i;
        for (i = 0; i < this.newOrdersQueue.length; i++) {
            const nextNewOrder = this.newOrdersQueue[i]!;

            if (nextNewOrder.processAt > currentTimestamp || i + 1 > capacity) {
                break;
            }
        }

        const ordersToProcess = this.newOrdersQueue.splice(0, i).map((newOrder) => {
            return newOrder.order;
        });

        return ordersToProcess;
    }

    private getUnderwritterCapacity(): number {
        return Math.max(
            0,
            this.config.maxPendingTransactions
                - this.discoverQueue.size
                - this.evalQueue.size
                - this.underwriteQueue.size
        );
    }

    //TODO refactor arguments? (abstract into different objects?)
    private async addUnderwriteOrder(
        fromChainId: string,
        fromVault: string,
        swapIdentifier: string,

        toVault: string,
        toAccount: string,
        units: bigint,
        toAssetIndex: bigint,
        minOut: bigint,
        underwriteIncentiveX16: bigint,
        calldata: string,

        swapTxHash: string,
        swapBlockNumber: number,
        swapBlockTimestamp: number,

        amb: string,
        sourceIdentifier: string,
        toIncentivesAddress: string,
        interfaceAddress: string,
        messageIdentifier: string,
        deadline: bigint,
        maxGasDelivery: bigint,
    ) {
        this.logger.debug(
            { fromVault, fromChainId, swapTxHash, swapId: swapIdentifier },
            `Underwrite order received.`
        );

        const submissionDeadline = Date.now() + this.config.maxSubmissionDelay;

        const order: DiscoverOrder = {
            fromChainId,
            fromVault,
            swapIdentifier,

            toVault,
            toAccount,
            units,
            toAssetIndex,
            minOut,
            underwriteIncentiveX16,
            calldata,

            swapTxHash,
            swapBlockNumber,
            swapBlockTimestamp,

            amb,
            sourceIdentifier,
            toIncentivesAddress,
            interfaceAddress,
            messageIdentifier,
            deadline,
            maxGasDelivery,

            submissionDeadline,
        };

        const processDelay = this.config.underwriteDelay;

        this.newOrdersQueue.push({
            processAt: Date.now() + processDelay,
            order
        });
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
