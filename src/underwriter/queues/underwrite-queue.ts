import { Wallet } from "ethers";
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "./processing-queue";
import { UnderwriteOrder } from "../underwriter.types";
import { PoolConfig } from "src/config/config.service";
import { CatalystChainInterface__factory } from "src/contracts";
import { TransactionHelper } from "../transaction-helper";
import { PendingTransaction } from "./confirm-queue";

export class UnderwriteQueue extends ProcessingQueue<UnderwriteOrder, PendingTransaction<UnderwriteOrder>> {

    constructor(
        readonly pools: PoolConfig[],
        readonly retryInterval: number,
        readonly maxTries: number,
        private readonly transactionHelper: TransactionHelper,
        private readonly signer: Wallet,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    protected async onProcessOrders(): Promise<void> {
        await this.transactionHelper.updateFeeData();
    }

    protected async handleOrder(
        order: UnderwriteOrder,
        _retryCount: number
    ): Promise<HandleOrderResult<PendingTransaction<UnderwriteOrder>> | null> {

        const interfaceContract = CatalystChainInterface__factory.connect(order.interfaceAddress, this.signer);

        const tx = await interfaceContract.underwrite(    //TODO use underwriteAndCheckConnection
            order.toVault,
            order.toAsset,
            order.units,
            order.minOut,
            order.toAccount,
            order.underwriteIncentiveX16,
            order.calldata,
            {
                nonce: this.transactionHelper.getTransactionNonce(),
                gasLimit: order.gasLimit,
                ...this.transactionHelper.getFeeDataForTransaction()
            }
        );

        this.transactionHelper.increaseTransactionNonce();

        return { result: { data: order, tx } };
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

        //TODO Improve error filtering?
        //TODO  - If invalid allowance => should retry
        //TODO  - If 'recentlyUnderwritten' => should not retry
        if (error.code === 'CALL_EXCEPTION') {
            this.logger.info(
                errorDescription,
                `Error on underwrite submission: CALL_EXCEPTION.`,
            );
            return false;   // Do not retry eval
        }

        if (
            error.code === 'NONCE_EXPIRED' ||
            error.code === 'REPLACEMENT_UNDERPRICED' ||
            error.error?.message.includes('invalid sequence') //TODO is this dangerous? (any contract may include that error)
        ) {
            await this.transactionHelper.updateTransactionNonce();
        }

        this.logger.warn(errorDescription, `Error on underwrite submission.`);

        return true;
    }

    protected async onOrderCompletion(
        order: UnderwriteOrder,
        success: boolean,
        result: PendingTransaction<UnderwriteOrder> | null,
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