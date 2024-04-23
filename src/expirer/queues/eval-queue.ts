import { HandleOrderResult, ProcessingQueue } from "src/processing-queue/processing-queue";
import { ExpireOrder, ExpireEvalOrder } from "../expirer.types";
import pino from "pino";
import { Store } from "src/store/store.lib";
import { UnderwriteStatus } from "src/store/store.types";
import { tryErrorToString } from "src/common/utils";

export class EvalQueue extends ProcessingQueue<ExpireEvalOrder, ExpireOrder> {

    constructor(
        private readonly minUnderwriteDuration: number,
        retryInterval: number,
        maxTries: number,
        private readonly store: Store,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    protected async handleOrder(order: ExpireEvalOrder, retryCount: number): Promise<HandleOrderResult<ExpireOrder> | null> {
        // NOTE: the 'activeUnderwriteState' is not unique. After an underwrite fulfills, a new
        // underwrite with the same 'state' can be created. Expiry cancellation of `fulfilled`
        // underwrites should not be left to be handled at this point, rather it should be done as
        // soon as the underwrite is fulfilled/expired (i.e. it should be removed from the
        // `newOrdersQueue` of the main expirer worker).
        const activeUnderwriteStatePromise = this.store.getActiveUnderwriteState(
            order.toChainId,
            order.toInterface,
            order.underwriteId
        );
        const swapStatePromise = this.store.getSwapStateByExpectedUnderwrite(
            order.toChainId,
            order.toInterface,
            order.underwriteId
        );

        const [activeUnderwriteState, swapState] = await Promise.all([activeUnderwriteStatePromise, swapStatePromise]);

        const isUnderwritePending = activeUnderwriteState != null
            && activeUnderwriteState.status == UnderwriteStatus.Underwritten
        if (!isUnderwritePending) {
            return null;
        }

        if (swapState?.ambMessageSendAssetDetails == undefined) {
            throw new Error(`Expire evaluation fail: swap's state not found (toChainId: ${order.toChainId}, toInterface: ${order.toInterface}, underwriteId: ${order.underwriteId})`)
        }

        if (swapState.additionalSendAssetDetails?.toAsset == undefined) {
            throw new Error(`Expire evaluation fail: swap's toAsset not found (toChainId: ${order.toChainId}, toInterface: ${order.toInterface}, underwriteId: ${order.underwriteId})`)
        }


        // Verify the time that has passed since the underwrite was committed (safety net to
        // prevent expirying recent self-underwritten transactions).
        const underwriteTimestamp = activeUnderwriteState.swapUnderwrittenEvent!.blockTimestamp;
        const timeElapsedSinceUnderwrite = Date.now() - underwriteTimestamp * 1000;   //NOTE 'underwriteTimestamp' is in seconds.
        if (
            timeElapsedSinceUnderwrite < this.minUnderwriteDuration
        ) {
            this.logger.warn(
                {
                    toInterface: order.toInterface,
                    underwriteId: order.underwriteId,
                    underwriteTimestamp,
                    minUnderwriteDuration: this.minUnderwriteDuration
                },
                `Not enough time elapsed since underwrite to execute expiry. (POSSIBLE UNDERWRITER MISCONFIGURATION).`
            );
            return null;
        }


        // //TODO simulate expiry?

        //TODO check if already expired/makes economical sense to expire
        if (true) {
            const result: ExpireOrder = {
                toChainId: order.toChainId,
                toInterface: order.toInterface,
                underwriteId: order.underwriteId,
                expireAt: order.expireAt,
                channelId: swapState.ambMessageSendAssetDetails.fromChannelId,
                toVault: swapState.ambMessageSendAssetDetails.toVault,
                toAccount: swapState.ambMessageSendAssetDetails.toAccount,
                toAsset: swapState.additionalSendAssetDetails.toAsset,
                minOut: swapState.ambMessageSendAssetDetails.minOut,
                units: swapState.ambMessageSendAssetDetails.units,
                underwriteIncentiveX16: swapState.ambMessageSendAssetDetails.underwriteIncentiveX16,
                calldata: swapState.ambMessageSendAssetDetails.calldata,
            };
            return { result };
        } else {
            this.logger.info(
                {
                    toChainId: order.toChainId,
                    toInterface: order.toInterface,
                    underwriteId: order.underwriteId,
                    try: retryCount + 1
                },
                `Dropping expiry on evaluation`
            );

            return null;
        }
    }

    protected async handleFailedOrder(order: ExpireEvalOrder, retryCount: number, error: any): Promise<boolean> {

        const errorDescription = {
            toChainId: order.toChainId,
            toInterface: order.toInterface,
            underwriteId: order.underwriteId,
            error: tryErrorToString(error),
            try: retryCount + 1
        };

        //TODO add retries when swap data is not found

        this.logger.warn(
            errorDescription,
            `Error on expiry evaluation.`,
        );

        return true;
    }

    protected override async onOrderCompletion(
        order: ExpireEvalOrder,
        success: boolean,
        _result: ExpireOrder | null,
        retryCount: number
    ): Promise<void> {

        const orderDescription = {
            toChainId: order.toChainId,
            toInterface: order.toInterface,
            underwriteId: order.underwriteId,
            try: retryCount + 1
        };

        if (success) {
            this.logger.debug(
                orderDescription,
                `Successful expire evaluation.`,
            );

        } else {
            this.logger.error(
                orderDescription,
                `Unsuccessful expire evaluation.`,
            );
        }
    }
}