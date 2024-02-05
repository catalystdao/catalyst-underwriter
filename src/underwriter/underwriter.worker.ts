import { JsonRpcProvider, Wallet, Provider, AbstractProvider, ZeroAddress, TransactionResponse } from "ethers";
import pino, { LoggerOptions } from "pino";
import { workerData } from 'worker_threads';
import { UnderwriterWorkerData } from "./underwriter.service";
import { wait } from "src/common/utils";
import { PoolConfig } from "src/config/config.service";
import { STATUS_LOG_INTERVAL } from "src/logger/logger.service";
import { Store } from "src/store/store.lib";
import { SwapDescription } from "src/store/store.types";
import { EvalOrder, GasFeeConfig, NewOrder, Order, PendingApproval, UnderwriteOrder } from "./underwriter.types";
import { EvalQueue } from "./queues/eval-queue";
import { UnderwriteQueue } from "./queues/underwrite-queue";
import { TransactionHelper } from "./transaction-helper";
import { ConfirmQueue, PendingTransaction } from "./queues/confirm-queue";
import { ApprovalHandler } from "./approval-handler";


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
    readonly approvalHandler: ApprovalHandler;

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

        this.approvalHandler = new ApprovalHandler(
          this.config.retryInterval,
          this.config.maxTries,
          this.transactionHelper,
          this.signer,
          this.logger
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
            const approvalTransactions = await this.approvalHandler.updateAllowances(...newUnderwriteOrders);
            await this.confirmQueue.addOrders(...approvalTransactions);

            await this.underwriteQueue.addOrders(...newUnderwriteOrders);
            await this.underwriteQueue.processOrders();

            const [toConfirmSubmitOrders, ,] = this.underwriteQueue.getFinishedOrders();
            await this.confirmQueue.addOrders(...toConfirmSubmitOrders);
            await this.confirmQueue.processOrders();

            const [confirmedSubmitOrders, unconfirmedSubmitOrders, rejectedSubmitOrders] =
              this.confirmQueue.getFinishedOrders();
      
            await this.handleConfirmedSubmitOrders(confirmedSubmitOrders);
            await this.handleUnconfirmedSubmitOrders(unconfirmedSubmitOrders);
            await this.handleRejectedSubmitOrders(rejectedSubmitOrders);

            await wait(this.config.processingInterval);
        }
    }

    private async handleUnconfirmedSubmitOrders(
      unconfirmedSubmitOrders: PendingTransaction[],
    ): Promise<void> {

      for (const unconfirmedOrder of unconfirmedSubmitOrders) {
        if (unconfirmedOrder.data?.isApproval != null) {
          await this.handleUnconfirmedApproval(unconfirmedOrder);
        } else {
          await this.handleUnconfirmedUnderwrite(unconfirmedOrder);
        }
      }
    }

    private async handleUnconfirmedApproval(unconfirmedOrder: PendingTransaction) {
      const pendingApproval = unconfirmedOrder.data as PendingApproval;

      // Decrease the registered 'set' allowance, so that a new approval order is executed on the
      // next 'run()' loop.
      this.approvalHandler.registerSetAllowanceDecrease(
        pendingApproval.interface,
        pendingApproval.asset,
        pendingApproval.requiredAllowance - pendingApproval.setAllowance
      );
    }

    private async handleUnconfirmedUnderwrite(unconfirmedOrder: PendingTransaction) {

      const underwriteOrder = unconfirmedOrder.data as UnderwriteOrder;
      const resubmitUnderwrite = this.processConfirmationError(
        unconfirmedOrder
      );

      if (resubmitUnderwrite) {
        const requeueCount = underwriteOrder.requeueCount ?? 0;
        if (requeueCount >= this.config.maxTries - 1) {
          const orderDescription = {
            originalTxHash: unconfirmedOrder.tx.hash,
            replaceTxHash: unconfirmedOrder.replaceTx?.hash,
            requeueCount: requeueCount,
          };
          
          this.approvalHandler.registerRequiredAllowanceDecrease(
            underwriteOrder.interfaceAddress,
            underwriteOrder.toAsset,
            underwriteOrder.toAssetAllowance
          );

          this.logger.warn(
            orderDescription,
            `Transaction confirmation failure. Maximum number of requeues reached. Dropping message.`,
          );
          return;
        }

        const requeueOrder: UnderwriteOrder = {
          poolId: underwriteOrder.poolId,
          fromChainId: underwriteOrder.fromChainId,
          fromVault: underwriteOrder.fromVault,
          swapTxHash: underwriteOrder.swapTxHash,
          swapIdentifier: underwriteOrder.swapIdentifier,
          channelId: underwriteOrder.channelId,
          toVault: underwriteOrder.toVault,
          toAccount: underwriteOrder.toAccount,
          fromAsset: underwriteOrder.fromAsset,
          toAssetIndex: underwriteOrder.toAssetIndex,
          fromAmount: underwriteOrder.fromAmount,
          minOut: underwriteOrder.minOut,
          units: underwriteOrder.units,
          fee: underwriteOrder.fee,
          underwriteIncentiveX16: underwriteOrder.underwriteIncentiveX16,
          toAsset: underwriteOrder.toAsset,
          toAssetAllowance: underwriteOrder.toAssetAllowance,
          interfaceAddress: underwriteOrder.interfaceAddress,
          calldata: underwriteOrder.calldata,
          gasLimit: underwriteOrder.gasLimit,
          requeueCount: requeueCount + 1,
        };
        await this.underwriteQueue.addOrders(requeueOrder);
      } else {
        this.approvalHandler.registerRequiredAllowanceDecrease(
          underwriteOrder.interfaceAddress,
          underwriteOrder.toAsset,
          underwriteOrder.toAssetAllowance
        )
      }

    }

    private async handleConfirmedSubmitOrders(
      confirmedSubmitOrders: PendingTransaction[],
    ): Promise<void> {

      for (const confirmedOrder of confirmedSubmitOrders) {
        // Ignore 'approval' transactions
        if (confirmedOrder.data?.isApproval != null) continue;

        const underwriteOrder = confirmedOrder.data as UnderwriteOrder;
        this.approvalHandler.registerAllowanceUse(
          underwriteOrder.interfaceAddress,
          underwriteOrder.toAsset,
          underwriteOrder.toAssetAllowance
        );

        //TODO add underwriteId to log? (note that this depends on the AMB implementation)
        const orderDescription = {
          fromVault: underwriteOrder.fromVault,
          fromChainId: underwriteOrder.fromChainId,
          swapTxHash: underwriteOrder.swapTxHash,
          swapId: underwriteOrder.swapIdentifier,
          originalTxHash: confirmedOrder.tx.hash,
          replaceTxHash: confirmedOrder.replaceTx?.hash,
        };

        this.logger.debug(
            orderDescription,
            `Successful underwrite processing: underwrite submitted.`,
        );
      }
    }

    // Returns whether to resubmit the order
    private processConfirmationError(unconfirmedOrder: PendingTransaction): boolean {
      const error = unconfirmedOrder.confirmationError;
      const underwriteOrder = unconfirmedOrder.data as UnderwriteOrder;

      if (error == null) return false;

      const errorDescription = {
        fromVault: underwriteOrder.fromVault,
        fromChainId: underwriteOrder.fromChainId,
        swapTxHash: underwriteOrder.swapTxHash,
        swapId: underwriteOrder.swapIdentifier,
        underwriteTxHash: unconfirmedOrder.replaceTx?.hash ?? unconfirmedOrder.tx.hash
      };
      
      //TODO Improve error filtering?
      //TODO  - If invalid allowance => should retry
      //TODO  - If 'recentlyUnderwritten' => should not retry
      // If tx errors with 'CALL_EXCEPTION', drop the order
      if (error.code === 'CALL_EXCEPTION') {
        this.logger.info(
            errorDescription,
            `Error on transaction confirmation: CALL_EXCEPTION. Dropping message.`,
        );
        return false; // Do not resubmit
      }

      // If tx errors because of an invalid nonce, requeue the order for submission
      // NOTE: it is possible for this error to occur because of the original tx being accepted. In
      // that case, the order will error on the submitter.
      if (
          error.code === 'NONCE_EXPIRED' ||
          error.code === 'REPLACEMENT_UNDERPRICED' ||
          error.error?.message.includes('invalid sequence') //TODO is this dangerous? (any contract may include that error)
      ) {
          this.logger.info(
              errorDescription,
              `Error on transaction confirmation: nonce error. Requeue order for submission if possible.`,
          );
          return true;
      }

      return false;
    }
  
    private async handleRejectedSubmitOrders(
      rejectedSubmitOrders: PendingTransaction[],
    ): Promise<void> {
      for (const rejectedOrder of rejectedSubmitOrders) {
        await this.cancelTransaction(rejectedOrder.tx);
      }
    }
  
    // This function does not return until the transaction of the given nonce is mined!
    private async cancelTransaction(baseTx: TransactionResponse): Promise<void> {
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
