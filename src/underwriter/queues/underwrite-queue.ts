import { JsonRpcProvider, TransactionRequest } from "ethers";
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "../../processing-queue/processing-queue";
import { UnderwriteOrder, UnderwriteOrderResult } from "../underwriter.types";
import { PoolConfig } from "src/config/config.service";
import { CatalystChainInterface__factory } from "src/contracts";
import { WalletInterface } from "src/wallet/wallet.interface";

export class UnderwriteQueue extends ProcessingQueue<UnderwriteOrder, UnderwriteOrderResult> {

    constructor(
        readonly pools: PoolConfig[],
        readonly retryInterval: number,
        readonly maxTries: number,
        private readonly wallet: WalletInterface,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    protected async handleOrder(
        order: UnderwriteOrder,
        _retryCount: number
    ): Promise<HandleOrderResult<UnderwriteOrderResult> | null> {

        const interfaceContract = CatalystChainInterface__factory.connect(
            order.interfaceAddress,
            this.provider
        );

        //TODO use underwriteAndCheckConnection
        const txData = interfaceContract.interface.encodeFunctionData("underwrite", [
            order.toVault,
            order.toAsset,
            order.units,
            order.minOut,
            order.toAccount,
            order.underwriteIncentiveX16,
            order.calldata,
        ]);

        const txRequest: TransactionRequest = {
            to: order.interfaceAddress,
            data: txData,
            gasLimit: order.gasLimit,
        };

        const txPromise = this.wallet.submitTransaction(txRequest, order)
            .then(transactionResult => {
                if (transactionResult.submissionError) {
                    throw transactionResult.submissionError;    //TODO wrap in a 'SubmissionError' type?
                }
                if (transactionResult.confirmationError) {
                    throw transactionResult.confirmationError;    //TODO wrap in a 'ConfirmationError' type?
                }

                const order = transactionResult.metadata as UnderwriteOrder;

                return {
                    ...order,
                    tx: transactionResult.tx,
                    txReceipt: transactionResult.txReceipt
                } as UnderwriteOrderResult;
            });

        return { result: txPromise };
    }

    protected async handleFailedOrder(order: UnderwriteOrder, retryCount: number, error: any): Promise<boolean> {

        //TODO add underwriteId to log? (note that this depends on the AMB implementation)
        const errorDescription = {
            fromVault: order.fromVault,
            fromChainId: order.fromChainId,
            swapTxHash: order.swapTxHash,
            swapId: order.swapIdentifier,
            error,
            try: retryCount + 1
        };

        this.logger.warn(errorDescription, `Error on underwrite submission.`);

        //TODO Improve error filtering?
        //TODO  - If invalid allowance => should retry
        //TODO  - If 'recentlyUnderwritten' => should not retry
        return false;
    }

    protected async onOrderCompletion(
        order: UnderwriteOrder,
        success: boolean,
        result: UnderwriteOrderResult | null,
        retryCount: number
    ): Promise<void> {

        //TODO add underwriteId to log? (note that this depends on the AMB implementation)
        const orderDescription = {
            fromVault: order.fromVault,
            fromChainId: order.fromChainId,
            swapTxHash: order.swapTxHash,
            swapId: order.swapIdentifier,
            underwriteTxHash: result?.tx.hash,
            try: retryCount + 1
        };

        if (success) {
            if (result != null) {
                this.logger.debug(
                    orderDescription,
                    `Successful underwrite processing: underwrite submitted.`,
                );
            } else {
                this.logger.debug(
                    orderDescription,
                    `Successful underwrite processing: underwrite not submitted.`,
                );
            }
        } else {
            this.logger.error(
                orderDescription,
                `Unsuccessful underwrite processing.`,
            );
        }
    }
}