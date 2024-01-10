import { FeeData, Wallet } from "ethers";
import pino from "pino";
import { RetryQueue } from "./retry-queue";
import { UnderwriteOrder, GasFeeConfig, EvalOrder, GasFeeOverrides } from "../underwriter.types";


export class UnderwriteQueue extends RetryQueue<UnderwriteOrder, never> {

    private feeData: FeeData | undefined;

    private transactionCount = 0;
    private pendingTransactions = 0;

    get pendingTransactionsCount(): number {
        return this.pendingTransactions;
    }

    constructor(
        retryInterval: number,
        maxTries: number,
        readonly transactionTimeout: number,
        readonly gasFeeConfig: GasFeeConfig,
        private readonly signer: Wallet,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    async init(): Promise<void> {
        await this.updateTransactionCount();
        await this.updateFeeData();
    }

    protected async onProcessOrders(): Promise<void> {
        if (this.queue.length > 0) await this.updateFeeData();
    }

    protected async onRetryOrderDrop(order: EvalOrder, retryCount: number): Promise<void> {
        this.logger.error(
          `Failed to perform underwrite for swap ${order.swapIdentifier} (swap txHash ${order.txHash}). Dropping message (try ${retryCount + 1}).`,
        );
    }

    protected async handleOrder(order: UnderwriteOrder, _retryCount: number): Promise<null> {

        this.logger.info(`Handle order triggered: ${order}`)

        // Execute the relay transaction if the static call did not fail.
        //TODO tx

        // this.registerPendingTransaction(tx.wait(), order);
        // this.transactionCount++;

        // this.logger.info(
        //     `Submitted underwrite ${'TODO'} (hash: ${tx.hash} on block ${tx.blockNumber})`, //TODO id
        // );

        return null;
    }

    protected async handleFailedOrder(order: UnderwriteOrder, retryCount: number, error: any): Promise<boolean> {
        if (error.code === 'CALL_EXCEPTION') {
            //TODO improve error filtering?
            this.logger.info(
                `Failed to submit underwrite ${'TODO'}: CALL_EXCEPTION. Dropping message (try ${retryCount + 1}).`,
            );
            //TODO approved funds
            return false;
        }

        if (
            error.code === 'NONCE_EXPIRED' ||
            error.code === 'REPLACEMENT_UNDERPRICED' ||
            error.error?.message.includes('invalid sequence')
        ) {
            await this.updateTransactionCount();
        }

        this.logger.warn(
            error,
            `Failed to submit underwrite ${'TODO'} (try ${retryCount + 1})`,  //TODO id
        );

        return true;
    }


    private async updateTransactionCount(): Promise<void> {
        let i = 1;
        while (true) {
            try {
                this.transactionCount =
                    await this.signer.getNonce('pending'); //TODO 'pending' may not be supported
                break;
            } catch (error) {
                // Continue trying indefinitely. If the transaction count is incorrect, no transaction will go through.
                this.logger.error(error, `Failed to update nonce for chain (try ${i}).`);
                await new Promise((r) => setTimeout(r, this.retryInterval));
            }

            i++;
        }
    }

    private async updateFeeData(): Promise<void> {
        try {
            this.feeData = await this.signer.provider!.getFeeData();    //TODO handle null possibility
        } catch {
            // Continue with stale fee data.
        }
    }

    private getFeeDataForTransaction(): GasFeeOverrides {
        const queriedFeeData = this.feeData;
        if (queriedFeeData == undefined) {
            return {};
        }

        const queriedMaxPriorityFeePerGas = queriedFeeData.maxPriorityFeePerGas;
        if (queriedMaxPriorityFeePerGas != null) {
            // Set fee data for an EIP 1559 transactions
            const maxFeePerGas = this.gasFeeConfig.maxFeePerGas;

            // Adjust the 'maxPriorityFeePerGas' by the adjustment factor
            let maxPriorityFeePerGas;
            if (this.gasFeeConfig.maxPriorityFeeAdjustmentFactor != undefined) {
                maxPriorityFeePerGas = BigInt(Math.floor(
                    Number(queriedMaxPriorityFeePerGas) *
                    this.gasFeeConfig.maxPriorityFeeAdjustmentFactor,
                ));
            }

            // Apply the max allowed 'maxPriorityFeePerGas'
            if (
                maxPriorityFeePerGas != undefined &&
                this.gasFeeConfig.maxAllowedPriorityFeePerGas != undefined &&
                this.gasFeeConfig.maxAllowedPriorityFeePerGas < maxPriorityFeePerGas
            ) {
                maxPriorityFeePerGas = this.gasFeeConfig.maxAllowedPriorityFeePerGas;
            }

            return {
                maxFeePerGas,
                maxPriorityFeePerGas,
            };
        } else {
            // Set traditional gasPrice
            const queriedGasPrice = queriedFeeData.gasPrice;
            if (queriedGasPrice == null) return {};

            // Adjust the 'gasPrice' by the adjustment factor
            let gasPrice;
            if (this.gasFeeConfig.gasPriceAdjustmentFactor != undefined) {
                gasPrice = BigInt(Math.floor(
                    Number(queriedGasPrice) *
                    this.gasFeeConfig.gasPriceAdjustmentFactor,
                ));
            }

            // Apply the max allowed 'gasPrice'
            if (
                gasPrice != undefined &&
                this.gasFeeConfig.maxAllowedGasPrice != undefined &&
                this.gasFeeConfig.maxAllowedGasPrice < gasPrice
            ) {
                gasPrice = this.gasFeeConfig.maxAllowedGasPrice;
            }

            return {
                gasPrice,
            };
        }
    }

    private registerPendingTransaction(
        promise: Promise<any>,
        order: UnderwriteOrder,
        retryCount: number,
    ): void {
        this.pendingTransactions += 1;

        const timingOutPromise = Promise.race([
            promise,
            new Promise((resolve, reject) =>
                setTimeout(reject, this.transactionTimeout),
            ),
        ]);

        timingOutPromise.then(
            () => {
                this.pendingTransactions -= 1;
                //TODO prioritiseSwap
            },
            () => {
                this.pendingTransactions -= 1;

                this.logger.warn(
                    new Error('Transaction submission timed out.'),
                    `Failed to submit order ${'TODO'} (try ${retryCount + 1})`,  //TODO order id
                );

                return this.addOrderToRetryQueue({
                    order,
                    retryCount,
                    retryAtTimestamp: 0
                });
            },
        );
    }

}