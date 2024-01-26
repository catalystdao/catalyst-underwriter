import { HandleOrderResult, ProcessingQueue } from './processing-queue';
import { AbstractProvider, Wallet } from 'ethers';
import pino from 'pino';
import { TransactionHelper } from '../transaction-helper';
import { UnderwriteOrderResult } from '../underwriter.types';
import { CatalystChainInterface__factory } from 'src/contracts';

export class ConfirmQueue extends ProcessingQueue<UnderwriteOrderResult, null> {

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

    protected async onOrderInit(order: UnderwriteOrderResult): Promise<void> {
        order.resubmit = false;
    }

    protected async handleOrder(
        order: UnderwriteOrderResult,
        retryCount: number,
    ): Promise<HandleOrderResult<null> | null> {
        // If it's the first time the order is processed, just wait for it
        if (retryCount == 0) {
            const transactionReceipt = this.provider
                .waitForTransaction(
                    order.tx.hash,
                    this.confirmations,
                    this.confirmationTimeout,
                )
                .then((_receipt) => null);

            return { result: transactionReceipt };
        }

        // Reprice the order if it hasn't been repriced
        if (!order.replaceTx) {
            // Reprice the order
            const originalTx = order.tx;
            const interfaceContract = CatalystChainInterface__factory.connect(order.interfaceAddress, this.wallet);

            const increasedFeeConfig =
                this.transactionHelper.getIncreasedFeeDataForTransaction(originalTx);

            order.replaceTx = await interfaceContract.underwrite(    //TODO use underwriteAndCheckConnection
                order.toVault,
                order.toAsset,
                order.units,
                order.minOut,
                order.toAccount,
                order.underwriteIncentiveX16,
                order.calldata,
                {
                    gasLimit: originalTx.gasLimit,
                    nonce: originalTx.nonce,
                    ...increasedFeeConfig,
                },
            );
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
            () => null,
            (aggregateError) => {
                // If both the original/replace tx promises reject, throw the error of the replace tx.
                throw aggregateError.errors?.[1];
            },
        );

        return { result: confirmationPromise };
    }

    protected async handleFailedOrder(
        order: UnderwriteOrderResult,
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
        order: UnderwriteOrderResult,
        retryCount: number,
        error: any,
    ): Promise<boolean> {

        //TODO add underwriteId to log? (note that this depends on the AMB implementation)
        const errorDescription = {
            fromVault: order.fromVault,
            fromChainId: order.fromChainId,
            swapTxHash: order.swapTxHash,
            swapId: order.swapIdentifier,
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

        //TODO Improve error filtering?
        //TODO  - If invalid allowance => should retry
        //TODO  - If 'recentlyUnderwritten' => should not retry
        // If tx errors with 'CALL_EXCEPTION', drop the order
        if (error.code === 'CALL_EXCEPTION') {
            this.logger.info(
                errorDescription,
                `Error on transaction confirmation: CALL_EXCEPTION. Dropping message.`,
            );
            return false; // Do not retry order confirmation
        }

        // If tx errors because of an invalid nonce, requeue the order for submission
        if (
            error.code === 'NONCE_EXPIRED' ||
            error.code === 'REPLACEMENT_UNDERPRICED' ||
            error.error?.message.includes('invalid sequence') //TODO is this dangerous? (any contract may include that error)
        ) {
            this.logger.info(
                errorDescription,
                `Error on transaction confirmation: nonce error. Requeue order for submission if possible.`,
            );
            order.resubmit = true;
            return false; // Do not retry order confirmation
        }

        // Unknown error on confirmation. Requeue the order for submission
        this.logger.warn(
            errorDescription,
            `Error on transaction confirmation. Requeue order for submission if possible.`,
        );
        order.resubmit = true;
        return false; // Do not retry order confirmation
    }

    private async handleFailedRepricedOrder(
        order: UnderwriteOrderResult,
        retryCount: number,
        error: any,
    ): Promise<boolean> {
        const errorDescription = {
            fromVault: order.fromVault,
            fromChainId: order.fromChainId,
            swapTxHash: order.swapTxHash,
            swapId: order.swapIdentifier,
            error,
            requeueCount: order.requeueCount,
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

        // If tx errors with 'REPLACEMENT_UNDERPRICED', retry the order, as the original tx may still be pending.
        if (error.code === 'REPLACEMENT_UNDERPRICED') {
            this.logger.warn(
                errorDescription,
                `Error on repriced transaction confirmation: REPLACEMENT_UNDERPRICED. Keep waiting until tx is rejected.`,
            );
            return true;
        }

        //TODO Improve error filtering?
        //TODO  - If invalid allowance => should retry
        //TODO  - If 'recentlyUnderwritten' => should not retry
        // If tx errors with 'CALL_EXCEPTION', drop the order
        if (error.code === 'CALL_EXCEPTION') {
            this.logger.info(
                errorDescription,
                `Error on repriced transaction confirmation: CALL_EXCEPTION. Dropping message.`,
            );
            return false; // Do not retry order confirmation
        }

        // If tx errors because of an invalid nonce, requeue the order for submission
        // NOTE: it is possible for this error to occur because of the original tx being accepted. In
        // that case, the order will error on the submitter.
        if (
            error.code === 'NONCE_EXPIRED' ||
            error.error?.message.includes('invalid sequence') //TODO is this dangerous? (any contract may include that error)
        ) {
            this.logger.info(
                errorDescription,
                `Error on transaction confirmation: nonce error. Requeue order for submission if possible.`,
            );
            order.resubmit = true;
            return false; // Do not retry order confirmation
        }

        // Unknown error on confirmation, keep waiting
        this.logger.warn(
            errorDescription,
            `Error on repriced transaction confirmation. Keep waiting if possible.`,
        );
        return true;
    }

    protected async onOrderCompletion(
        order: UnderwriteOrderResult,
        success: boolean,
        result: null,
        retryCount: number,
    ): Promise<void> {
        const orderDescription = {
            originalTxHash: order.tx.hash,
            replaceTxHash: order.replaceTx?.hash,
            resubmit: order.resubmit,
            requeueCount: order.requeueCount,
            try: retryCount + 1,
        };

        if (success) {
            this.logger.debug(orderDescription, `Transaction confirmed.`);
        } else {
            this.logger.error(orderDescription, `Transaction not confirmed.`);
        }
    }
}
