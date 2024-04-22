import { JsonRpcProvider, TransactionRequest } from "ethers";
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "../../processing-queue/processing-queue";
import { UnderwriteOrder, UnderwriteOrderResult } from "../underwriter.types";
import { AMBConfig } from "src/config/config.types";
import { CatalystChainInterface__factory } from "src/contracts";
import { WalletInterface } from "src/wallet/wallet.interface";
import { encodeBytes65Address } from "src/common/decode.payload";
import fetch from "node-fetch";
import { tryErrorToString } from "src/common/utils";

export class UnderwriteQueue extends ProcessingQueue<UnderwriteOrder, UnderwriteOrderResult> {

    constructor(
        private readonly chainId: string,
        private readonly ambs: Record<string, AMBConfig>,
        readonly retryInterval: number,
        readonly maxTries: number,
        private readonly walletPublicKey: string,
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

        const txData = interfaceContract.interface.encodeFunctionData("underwriteAndCheckConnection", [
            order.sourceIdentifier,
            encodeBytes65Address(order.fromVault),
            order.toVault,
            order.toAsset,
            order.units,
            order.minOut,
            order.toAccount,
            order.underwriteIncentiveX16,
            order.calldata,
        ]);

        if (order.gasLimit == undefined) {
            // Gas estimation and limit check are here as they cannot be performed until the token
            // approval for the order is executed, which must happen after the 'evaluation' step.
            order.gasLimit = await this.provider.estimateGas({
                to: order.interfaceAddress,
                from: this.walletPublicKey,
                data: txData,
                blockTag: 'pending' //TODO is 'pending' widely supported?
            });

            if (order.maxGasLimit != null && order.gasLimit > order.maxGasLimit) {
                // NOTE: the following error message is matched on the 'handleFailedOrder' handler below.
                throw new Error('Skipping underwrite, \'gasLimit\' is larger than the set \'maxGasLimit\'.')
            }
        }

        const txRequest: TransactionRequest = {
            to: order.interfaceAddress,
            data: txData,
            gasLimit: order.gasLimit,
        };

        const txPromise = this.wallet.submitTransaction(
            txRequest,
            order,
            { deadline: order.submissionDeadline }
        ).then((transactionResult): UnderwriteOrderResult => {
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

            const order = transactionResult.metadata as UnderwriteOrder;

            return {
                ...order,
                tx: transactionResult.tx,
                txReceipt: transactionResult.txReceipt
            };
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
            error: tryErrorToString(error),
            try: retryCount + 1
        };

        if (typeof error.message == "string") {
            if (error.message == 'Skipping underwrite, \'gasLimit\' is larger than the set \'maxGasLimit\'.') {
                this.logger.warn(
                    { errorDescription, gasLimit: order.gasLimit, maxGasLimit: order.maxGasLimit },
                    'Skipping underwrite, \'gasLimit\' is larger than the set \'maxGasLimit\'.'
                );
                return false;   // Do not retry
            }
        }
        if (order.gasLimit == undefined) {
            // This may happen if the token allowance is not set correctly
            this.logger.warn(errorDescription, 'Gas limit estimation failed. Retrying if possible.')
            return true;
        }

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
                await this.requestRelayPrioritisation(order);
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

    private async requestRelayPrioritisation(
        order: UnderwriteOrder
    ): Promise<void> {

        const ambConfig = this.ambs[order.amb];
        if (!ambConfig.relayPrioritisation) {
            this.logger.debug(
                { amb: order.amb, swapTxHash: order.swapTxHash, swapIdentifier: order.swapIdentifier},
                'Skipping packet relay prioritisation: prioritisation disabled.'
            );
            return;
        }

        const relayerEndpoint = `http://${process.env.RELAYER_HOST}:${process.env.RELAYER_PORT}/prioritiseAMBMessage`;

        const ambMessageData = {
            messageIdentifier: order.messageIdentifier,
            amb: order.amb,
            sourceChainId: order.fromChainId,
            destinationChainId: this.chainId,
        };
        try {
            this.logger.debug(
                { ambMessageData, swapTxHash: order.swapTxHash, swapIdentifier: order.swapIdentifier},
                'Requesting AMB message relay prioritisation.'  
            );
            await fetch(relayerEndpoint, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(ambMessageData),
            });
        } catch (error) {
            this.logger.error(
                { ambMessageData, swapTxHash: order.swapTxHash, swapIdentifier: order.swapIdentifier},
                'Failed to request amb message relay prioritisation.'
            );
        }
    }
}