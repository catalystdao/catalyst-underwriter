import { JsonRpcProvider, TransactionRequest } from "ethers";
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "../../processing-queue/processing-queue";
import { CatalystChainInterface__factory } from "src/contracts";
import { WalletInterface } from "src/wallet/wallet.interface";
import { ExpireOrder, ExpireOrderResult } from "../expirer.types";
import { tryErrorToString } from "src/common/utils";
export class ExpireQueue extends ProcessingQueue<ExpireOrder, ExpireOrderResult> {

    constructor(
        private readonly chainId: string,
        retryInterval: number,
        maxTries: number,
        private readonly wallet: WalletInterface,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    protected async handleOrder(
        order: ExpireOrder,
        _retryCount: number
    ): Promise<HandleOrderResult<ExpireOrderResult> | null> {

        const interfaceContract = CatalystChainInterface__factory.connect(
            order.toInterface,
            this.provider
        );

        const txData = interfaceContract.interface.encodeFunctionData("expireUnderwrite", [
            order.toVault,
            order.toAsset,
            order.units,
            order.minOut,
            order.toAccount,
            order.underwriteIncentiveX16,
            order.calldata,
        ]);

        const txRequest: TransactionRequest = {
            to: order.toInterface,
            data: txData,
            // gasLimit: order.gasLimit,    //TODO set gas limit
        };

        this.logger.warn(
            order,
            'Expiring underwrite.'
        );

        //TODO add 'priority' option to wallet
        const txPromise = this.wallet.submitTransaction(this.chainId, txRequest, order)
            .then((transactionResult): ExpireOrderResult => {
                if (transactionResult.submissionError) {
                    throw transactionResult.submissionError;    //TODO wrap in a 'SubmissionError' type?
                }
                if (transactionResult.confirmationError) {
                    throw transactionResult.confirmationError;    //TODO wrap in a 'ConfirmationError' type?
                }

                if (transactionResult.tx == undefined) {
                    // This case should never be reached (if tx == undefined, a 'submissionError' should be returned).
                    throw new Error('No transaction returned on wallet transaction submission result.');
                }
                if (transactionResult.txReceipt == undefined) {
                    // This case should never be reached (if txReceipt == undefined, a 'confirmationError' should be returned).
                    throw new Error('No transaction receipt returned on wallet transaction submission result.');
                }

                const order = transactionResult.metadata as ExpireOrder;

                return {
                    ...order,
                    tx: transactionResult.tx,
                    txReceipt: transactionResult.txReceipt
                };
            });

        return { result: txPromise };
    }

    protected async handleFailedOrder(order: ExpireOrder, retryCount: number, error: any): Promise<boolean> {

        const errorDescription = {
            toChainId: order.toChainId,
            toInterface: order.toInterface,
            underwriteId: order.underwriteId,
            error: tryErrorToString(error),
            try: retryCount + 1
        };

        this.logger.warn(errorDescription, `Error on expire submission.`);

        //TODO Improve error filtering?
        return false;
    }

    protected override async onOrderCompletion(
        order: ExpireOrder,
        success: boolean,
        result: ExpireOrderResult | null,
        retryCount: number
    ): Promise<void> {

        const orderDescription = {
            toChainId: order.toChainId,
            toInterface: order.toInterface,
            underwriteId: order.underwriteId,
            expireTxHash: result?.tx.hash,
            try: retryCount + 1
        };

        if (success) {
            if (result != null) {
                this.logger.info(
                    orderDescription,
                    `Successful expire processing: expire submitted.`,
                );
            } else {
                this.logger.info(
                    orderDescription,
                    `Successful expire processing: expire not submitted.`,
                );
            }
        } else {
            this.logger.error(
                orderDescription,
                `Unsuccessful expire processing.`,
            );
        }
    }
}