import { JsonRpcProvider, Wallet, Provider, AbstractProvider, ContractTransactionResponse, ZeroAddress } from "ethers";
import pino, { LoggerOptions } from "pino";
import { workerData } from 'worker_threads';
import { UnderwriterWorkerData } from "./underwriter.service";
import { wait } from "src/common/utils";
import { PoolConfig } from "src/config/config.service";
import { STATUS_LOG_INTERVAL } from "src/logger/logger.service";
import { Store } from "src/store/store.lib";
import { SwapDescription } from "src/store/store.types";
import { EvalOrder, GasFeeConfig, NewOrder, Order, UnderwriteOrder, UnderwriteOrderResult } from "./underwriter.types";
import { EvalQueue } from "./queues/eval-queue";
import { UnderwriteQueue } from "./queues/underwrite-queue";
import { TransactionHelper } from "./transaction-helper";
import { ConfirmQueue } from "./queues/confirm-queue";


class UnderwriterWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: UnderwriterWorkerData;

    readonly provider: JsonRpcProvider;
    readonly signer: Wallet;

    readonly chainId: string;
    readonly chainName: string;

    readonly pools: PoolConfig[];

    readonly transactionHelper: TransactionHelper;

    readonly newOrdersQueue: NewOrder<EvalOrder>[] = [];
    readonly evalQueue: EvalQueue;
    readonly underwriteQueue: UnderwriteQueue;
    readonly confirmQueue: ConfirmQueue;

    private isStalled = false;


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
        this.signer = this.initializeSigner(this.config.privateKey, this.provider);

        this.transactionHelper = new TransactionHelper(
          this.getGasFeeConfig(this.config),
          this.config.retryInterval,
          this.provider,
          this.signer,
          this.logger,
        );

        [this.evalQueue, this.underwriteQueue, this.confirmQueue] = this.initializeQueues(
            this.pools,
            this.config.retryInterval,
            this.config.maxTries,
            this.config.confirmations,
            this.config.confirmationTimeout,
            this.transactionHelper,
            this.provider,
            this.signer,
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

    private initializeSigner(privateKey: string, provider: Provider): Wallet {
        return new Wallet(privateKey, provider);
    }

    private initializeQueues(
        pools: PoolConfig[],
        retryInterval: number,
        maxTries: number,
        confirmations: number,
        confirmationTimeout: number,
        transactionHelper: TransactionHelper,
        provider: AbstractProvider,
        signer: Wallet,
        logger: pino.Logger,
    ): [EvalQueue, UnderwriteQueue, ConfirmQueue] {
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
            transactionHelper,
            signer,
            logger
        );

        const confirmQueue = new ConfirmQueue(
          retryInterval,
          maxTries,
          confirmations,
          transactionHelper,
          confirmationTimeout,
          provider,
          signer,
          logger,
        );

        return [evalQueue, underwriteQueue, confirmQueue];
    }

    private getGasFeeConfig(config: UnderwriterWorkerData): GasFeeConfig {
        return {
          gasPriceAdjustmentFactor: config.gasPriceAdjustmentFactor,
          maxAllowedGasPrice: config.maxAllowedGasPrice,
          maxFeePerGas: config.maxFeePerGas,
          maxPriorityFeeAdjustmentFactor: config.maxPriorityFeeAdjustmentFactor,
          maxAllowedPriorityFeePerGas: config.maxAllowedPriorityFeePerGas,
          priorityAdjustmentFactor: config.priorityAdjustmentFactor,
        };
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
                confirmQueue: this.confirmQueue.size,
                confirmRetryQueue: this.confirmQueue.retryQueue.length,
                isStalled: this.isStalled,
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

        await this.transactionHelper.init();
        await this.evalQueue.init();
        await this.underwriteQueue.init();
        await this.confirmQueue.init();

        await this.listenForOrders();

        while (true) {
            const evalOrders = await this.processNewOrdersQueue();

            await this.evalQueue.addOrders(...evalOrders);
            await this.evalQueue.processOrders();

            const [newUnderwriteOrders, ,] = this.evalQueue.getFinishedOrders();
            await this.underwriteQueue.addOrders(...newUnderwriteOrders);
            await this.underwriteQueue.processOrders();

            const [toConfirmSubmitOrders, ,] = this.underwriteQueue.getFinishedOrders();
            await this.confirmQueue.addOrders(...toConfirmSubmitOrders);
            await this.confirmQueue.processOrders();

            const [, unconfirmedSubmitOrders, rejectedSubmitOrders] =
              this.confirmQueue.getFinishedOrders();
      
            await this.handleUnconfirmedSubmitOrders(unconfirmedSubmitOrders);
      
            await this.handleRejectedSubmitOrders(rejectedSubmitOrders);

            await wait(this.config.processingInterval);
        }
    }

    private async handleUnconfirmedSubmitOrders(
      unconfirmedSubmitOrders: UnderwriteOrderResult[],
    ): Promise<void> {
      for (const unconfirmedOrder of unconfirmedSubmitOrders) {
        if (unconfirmedOrder.resubmit) {
          const requeueCount = unconfirmedOrder.requeueCount ?? 0;
          if (requeueCount >= this.config.maxTries - 1) {
            const orderDescription = {
              originalTxHash: unconfirmedOrder.tx.hash,
              replaceTxHash: unconfirmedOrder.replaceTx?.hash,
              resubmit: unconfirmedOrder.resubmit,
              requeueCount: requeueCount,
            };
  
            this.logger.warn(
              orderDescription,
              `Transaction confirmation failure. Maximum number of requeues reached. Dropping message.`,
            );
            continue;
          }
  
          const requeueOrder: UnderwriteOrder = {
            poolId: unconfirmedOrder.poolId,
            fromChainId: unconfirmedOrder.fromChainId,
            fromVault: unconfirmedOrder.fromVault,
            swapTxHash: unconfirmedOrder.swapTxHash,
            swapIdentifier: unconfirmedOrder.swapIdentifier,
            channelId: unconfirmedOrder.channelId,
            toVault: unconfirmedOrder.toVault,
            toAccount: unconfirmedOrder.toAccount,
            fromAsset: unconfirmedOrder.fromAsset,
            toAssetIndex: unconfirmedOrder.toAssetIndex,
            fromAmount: unconfirmedOrder.fromAmount,
            minOut: unconfirmedOrder.minOut,
            units: unconfirmedOrder.units,
            fee: unconfirmedOrder.fee,
            underwriteIncentiveX16: unconfirmedOrder.underwriteIncentiveX16,
            toAsset: unconfirmedOrder.toAsset,
            toAssetAllowance: unconfirmedOrder.toAssetAllowance,
            interfaceAddress: unconfirmedOrder.interfaceAddress,
            calldata: unconfirmedOrder.calldata,
            gasLimit: unconfirmedOrder.gasLimit,
            requeueCount: requeueCount + 1,
          };
          await this.underwriteQueue.addOrders(requeueOrder);
        }
      }
    }
  
    private async handleRejectedSubmitOrders(
      rejectedSubmitOrders: UnderwriteOrderResult[],
    ): Promise<void> {
      for (const rejectedOrder of rejectedSubmitOrders) {
        await this.cancelTransaction(rejectedOrder.tx);
      }
    }
  
    // This function does not return until the transaction of the given nonce is mined!
    private async cancelTransaction(baseTx: ContractTransactionResponse): Promise<void> {
      const cancelTxNonce = baseTx.nonce;
      if (cancelTxNonce == undefined) {
        // This point should never be reached.
        //TODO log warn?
        return;
      }
  
      for (let i = 0; i < this.config.maxTries; i++) {
        // NOTE: cannot use the 'transactionHelper' for querying of the transaction nonce, as the
        // helper takes into account the 'pending' transactions.
        const latestNonce = await this.signer.getNonce('latest');
  
        if (latestNonce > cancelTxNonce) {
          return;
        }
  
        try {
          const tx = await this.signer.sendTransaction({
            nonce: cancelTxNonce,
            to: ZeroAddress,
            data: '0x',
            ...this.transactionHelper.getIncreasedFeeDataForTransaction(baseTx),
          });
  
          await this.provider.waitForTransaction(
            tx.hash,
            this.config.confirmations,
            this.config.confirmationTimeout,
          );
  
          // Transaction cancelled
          return;
        } catch {
          // continue
        }
      }
  
      this.isStalled = true;
      while (true) {
        this.logger.warn(
          { nonce: cancelTxNonce },
          `Underwriter stalled. Waiting until pending transaction is resolved.`,
        );
  
        await wait(this.config.confirmationTimeout);
  
        // NOTE: cannot use the 'transactionHelper' for querying of the transaction nonce, as the
        // helper takes into account the 'pending' transactions.
        const latestNonce = await this.signer.getNonce('latest');
  
        if (latestNonce > cancelTxNonce) {
          this.logger.info(
            { nonce: cancelTxNonce },
            `Underwriter resumed after stall recovery.`,
          );
          this.isStalled = false;
          return;
        }
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
                - this.confirmQueue.size
        );
    }

    //TODO refactor arguments? (abstract into different objects?)
    private async addUnderwriteOrder(
        poolId: string,
        fromChainId: string,
        fromVault: string,
        swapTxHash: string,
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
