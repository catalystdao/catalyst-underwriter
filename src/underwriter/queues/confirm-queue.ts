import { HandleOrderResult, ProcessingQueue } from './processing-queue';
import { AbstractProvider, TransactionResponse, Wallet } from 'ethers';
import pino from 'pino';
import { TransactionHelper } from '../transaction-helper';

export interface PendingTransaction<T = any> {
    data: T,
    tx: TransactionResponse;
    replaceTx?: TransactionResponse;
    confirmationError?: any;
}

export class ConfirmQueue extends ProcessingQueue<PendingTransaction, PendingTransaction> {

    constructor(
        readonly retryInterval: number,
        readonly maxTries: number,
        private readonly confirmations: number,
        private readonly transactionHelper: TransactionHelper,
        private readonly confirmationTimeout: number,
        private readonly provider: AbstractProvider,
        private readonly wallet: Wallet,
        private readonly logger: pino.Logger,
    ) {
        super(
            retryInterval,
            maxTries,
            1, // Confirm transactions one at a time
        );
    }

    async init(): Promise<void> {
    }

    protected async onOrderInit(order: PendingTransaction): Promise<void> {
        order.replaceTx = undefined;
        order.confirmationError = undefined;
    }

    protected async handleOrder(
        order: PendingTransaction,
        retryCount: number,
    ): Promise<HandleOrderResult<PendingTransaction> | null> {
        // If it's the first time the order is processed, just wait for it
        if (retryCount == 0) {
            const transactionReceipt = this.provider
                .waitForTransaction(
                    order.tx.hash,
                    this.confirmations,
                    this.confirmationTimeout,
                )
                .then((_receipt) => order);

            return { result: transactionReceipt };
        }

        // Reprice the order if it hasn't been repriced
        if (!order.replaceTx) {
            // Reprice the order
            const originalTx = order.tx;

            const increasedFeeConfig =
                this.transactionHelper.getIncreasedFeeDataForTransaction(originalTx);

            order.replaceTx = await this.wallet.sendTransaction({
                type: originalTx.type,
                to: originalTx.to,
                nonce: originalTx.nonce,
                gasLimit: originalTx.gasLimit,
                data: originalTx.data,
                value: originalTx.value,
                ...increasedFeeConfig,
            });
        }

        // Wait for either the original or the replace transaction to fulfill
        const originalTxReceipt = this.provider.waitForTransaction(
            order.tx.hash,
            this.confirmations,
            this.confirmationTimeout,
        );
        const replaceTxReceipt = this.provider.waitForTransaction(
            order.replaceTx!.hash,
            this.confirmations,
            this.confirmationTimeout,
        );

        const confirmationPromise = Promise.any([
            originalTxReceipt,
            replaceTxReceipt,
        ]).then(
            () => order,
            (aggregateError) => {
                // If both the original/replace tx promises reject, throw the error of the replace tx.
                throw aggregateError.errors?.[1];
            },
        );

        return { result: confirmationPromise };
    }

    protected async handleFailedOrder(
        order: PendingTransaction,
        retryCount: number,
        error: any,
    ): Promise<boolean> {
        // ! This logic only runs if the tx has **not** been repriced.
        if (retryCount == 0) {
            return this.handleFailedOriginalOrder(order, retryCount, error);
        } else {
            return this.handleFailedRepricedOrder(order, retryCount, error);
        }
    }

    private async handleFailedOriginalOrder(
        order: PendingTransaction,
        retryCount: number,
        error: any,
    ): Promise<boolean> {

        const errorDescription = {
            txHash: order.tx.hash,
            error,
            try: retryCount + 1
        };

        // If tx timeouts, retry the order. This will cause `handleOrder` to reprice the tx.
        if (error.code === 'TIMEOUT') {
            this.logger.info(
                errorDescription,
                `Error on transaction confirmation: TIMEOUT. Transaction will be sped up.`,
            );
            return true;
        }

        // Unknown error on confirmation. Requeue the order for submission
        this.logger.warn(
            errorDescription,
            `Error on transaction confirmation. Requeue order for submission if possible.`,
        );
        order.confirmationError = error;
        return false; // Do not retry order confirmation
    }

    private async handleFailedRepricedOrder(
        order: PendingTransaction,
        retryCount: number,
        error: any,
    ): Promise<boolean> {

        const errorDescription = {
            txHash: order.tx.hash,
            repricedTxHash: order.replaceTx?.hash,
            error,
            try: retryCount + 1
        };

        // If tx timeouts, keep waiting.
        if (error.code === 'TIMEOUT') {
            this.logger.info(
                errorDescription,
                `Error on transaction confirmation: TIMEOUT. Keep waiting if possible.`,
            );
            return true;
        }

        // If tx errors with 'REPLACEMENT_UNDERPRICED', retry the order, as the original tx may still resolve.
        if (error.code === 'REPLACEMENT_UNDERPRICED') {
            this.logger.warn(
                errorDescription,
                `Error on repriced transaction confirmation: REPLACEMENT_UNDERPRICED. Keep waiting until original tx is rejected.`,
            );
            return true;
        }

        // Unknown error on confirmation, keep waiting
        this.logger.warn(
            errorDescription,
            `Error on repriced transaction confirmation. Keep waiting if possible.`,
        );
        return true;
    }

    protected async onOrderCompletion(
        order: PendingTransaction,
        success: boolean,
        result: null,
        retryCount: number,
    ): Promise<void> {
        const orderDescription = {
            txHash: order.tx.hash,
            repricedTxHash: order.replaceTx?.hash,
            try: retryCount + 1,
        };

        if (success) {
            this.logger.debug(orderDescription, `Transaction confirmed.`);
        } else {
            this.logger.error(orderDescription, `Transaction not confirmed.`);
        }
    }
}
