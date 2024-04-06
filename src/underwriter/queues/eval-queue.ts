import { tryErrorToString } from 'src/common/utils';
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "../../processing-queue/processing-queue";
import { EvalOrder, UnderwriteOrder } from "../underwriter.types";
import { TokenConfig } from "src/config/config.types";
import { CatalystVaultCommon__factory } from "src/contracts";
import { JsonRpcProvider } from 'ethers';
import { TokenHandler } from '../token-handler/token-handler';

export class EvalQueue extends ProcessingQueue<EvalOrder, UnderwriteOrder> {

    constructor(
        private enabled: boolean,
        readonly chainId: string,
        readonly tokens: Record<string, TokenConfig>,
        readonly retryInterval: number,
        readonly maxTries: number,
        private readonly underwriteBlocksMargin: number,
        private readonly minRelayDeadlineDuration: bigint,
        private readonly minMaxGasDelivery: bigint,
        private readonly tokenHandler: TokenHandler,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    //TODO also implement on the 'underwrite' queue
    isUnderwritingEnabled(): boolean {
        return this.enabled;
    }

    protected async handleOrder(order: EvalOrder, retryCount: number): Promise<HandleOrderResult<UnderwriteOrder> | null> {

        if (!this.enabled) {
            this.logger.debug(
                {
                    swapId: order.swapIdentifier,
                    swapTxHash: order.swapTxHash,
                    swapBlockNumber: order.swapBlockNumber,
                },
                "Skipping underwrite: underwriter disabled."
            )
            return null;
        }

        // Never underwrite if too much time has passed since the original swap transaction
        if (order.swapObservedAtBlockNumber > order.swapBlockNumber + this.underwriteBlocksMargin) {
            this.logger.warn(
                {
                    swapId: order.swapIdentifier,
                    swapTxHash: order.swapTxHash,
                    swapBlockNumber: order.swapBlockNumber,
                },
                "Skipping underwrite: too many blocks have passed since the swap transaction."
            );
            return null;
        }

        // Never underwrite if the incentives deadline is too low.
        // NOTE: '0' means no deadline.
        if (order.deadline != 0n) {
            const relayDeadlineDurationSeconds = order.deadline - BigInt(order.swapBlockTimestamp);
            if (relayDeadlineDurationSeconds < this.minRelayDeadlineDuration / 1000n) {
                this.logger.info(
                    {
                        swapId: order.swapIdentifier,
                        swapTxHash: order.swapTxHash,
                        swapBlockNumber: order.swapBlockNumber,
                        deadline: order.deadline
                    },
                    "Skipping underwrite: incentivised message deadline is too short"
                );
                return null;
            }
        }

        // Never underwrite if the specified 'maxGasDelivery' is too low.
        if (order.maxGasDelivery < this.minMaxGasDelivery) {
            this.logger.info(
                {
                    swapId: order.swapIdentifier,
                    swapTxHash: order.swapTxHash,
                    swapBlockNumber: order.swapBlockNumber,
                    maxGasDelivery: order.maxGasDelivery,
                    minMaxGasDelivery: this.minMaxGasDelivery
                },
                "Skipping underwrite: incentivised message maxGasDelivery is too small."
            );
            return null;
        }

        // Verify the token to underwrite is supported
        const tokenConfig = this.tokens[order.toAsset.toLowerCase()];
        if (tokenConfig == undefined) {
            this.logger.warn(
                {
                    swapId: order.swapIdentifier,
                    swapTxHash: order.swapTxHash,
                    swapBlockNumber: order.swapBlockNumber,
                    toAsset: order.toAsset
                },
                "Skipping underwrite: token to underwrite not supported."
            );
            return null;
        }

        // Estimate return
        const toVaultContract = CatalystVaultCommon__factory.connect(
            order.toVault,
            this.provider
        );
        const expectedReturn = await toVaultContract.calcReceiveAsset(order.toAsset, order.units);
        const toAssetAllowance = expectedReturn * 11n / 10n;    //TODO set customizable allowance margin

        // Verify the token balances involed are acceptable
        if (
            tokenConfig.maxUnderwriteAllowed
            && toAssetAllowance > tokenConfig.maxUnderwriteAllowed
        ) {
            this.logger.info(
                {
                    swapId: order.swapIdentifier,
                    swapTxHash: order.swapTxHash,
                    swapBlockNumber: order.swapBlockNumber,
                    toAsset: order.toAsset,
                    toAssetAllowance,
                    maxUnderwriteAllowed: tokenConfig.maxUnderwriteAllowed
                },
                "Skipping underwrite: underwrite exceed the 'maxUnderwriteAllowed' configuration."
            );
            return null;
        }

        const expectedReward = (expectedReturn * order.underwriteIncentiveX16) >> 16n;
        if (
            tokenConfig.minUnderwriteReward
            && expectedReward < tokenConfig.minUnderwriteReward
        ) {
            this.logger.info(
                {
                    swapId: order.swapIdentifier,
                    swapTxHash: order.swapTxHash,
                    swapBlockNumber: order.swapBlockNumber,
                    toAsset: order.toAsset,
                    underwriteIncentiveX16: order.underwriteIncentiveX16,
                    expectedReward,
                    minUnderwriteReward: tokenConfig.minUnderwriteReward
                },
                "Skipping underwrite: expected underwrite reward is less than the 'minUnderwriteReward' configuration."
            );
            return null;
        }

        // Verify the underwriter has enough assets to perform the underwrite
        const enoughBalanceToUnderwrite = await this.tokenHandler.hasEnoughBalance(
            toAssetAllowance,
            order.toAsset
        );
        if (!enoughBalanceToUnderwrite) {
            this.logger.warn(
                {
                    swapId: order.swapIdentifier,
                    swapTxHash: order.swapTxHash,
                    swapBlockNumber: order.swapBlockNumber,
                    toAsset: order.toAsset,
                    requiredAllowance: toAssetAllowance,
                },
                "Skipping underwrite: not enough token balance to perform underwrite."
            );
            return null;
        }

        // Set the maximum allowed gasLimit for the transaction. This will be checked on the
        // 'underwrite' queue with an 'estimateGas' call.
        // ! It is not possible to 'estimateGas' of the underwrite transaction at this point, as
        // ! before doing it the allowance for underwriting must be set. The allowance for
        // ! underwriting is set **after** the evaluation step, as the allowance amount is not
        // ! known until the evaluation step completes.
        const maxGasLimit = null;  //TODO
        
        //TODO add economical evaluation

        if (true) {
            await this.tokenHandler.registerBalanceUse(
                toAssetAllowance,
                order.toAsset
            );

            const result: UnderwriteOrder = {
                ...order,
                maxGasLimit,
                toAssetAllowance,
            }
            return { result };
        } else {
            this.logger.info(
                {
                    fromVault: order.fromVault,
                    fromChainId: order.fromChainId,
                    swapTxHash: order.swapTxHash,
                    swapId: order.swapIdentifier,
                    try: retryCount + 1
                },
                `Dropping order on evaluation`
            );

            return null;
        }
    }

    protected async handleFailedOrder(order: EvalOrder, retryCount: number, error: any): Promise<boolean> {

        const errorDescription = {
            fromVault: order.fromVault,
            fromChainId: order.fromChainId,
            swapTxHash: order.swapTxHash,
            swapId: order.swapIdentifier,
            error: tryErrorToString(error),
            try: retryCount + 1
        };

        if (typeof error.message == "string") {
            if (
                /^Unknown pool id (0x)?[0-9a-fA-F]*/.test(error.message)
                || /^No vault on chain [0-9a-fA-F]* defined on pool (0x)?[0-9a-fA-F]*/.test(error.message)
            ) {
                this.logger.warn(
                    errorDescription,
                    `Error on underwrite evaluation. Dropping message.`,
                );
                return false;   // Do not retry eval
            }

            if (
                /^Failed to get the vault asset at the requested index.$/.test(error.message)
            ) {
                this.logger.warn(
                    {
                        ...errorDescription,
                        toVault: order.toVault,
                        toAssetIndex: order.toAssetIndex
                    },
                    `Failed to get the vault asset at the requested index.`,
                )
                return true;    // Retry eval (in case of an rpc query error)
            }
        }

        //TODO improve error filtering?
        if (error.code === 'CALL_EXCEPTION') {
            this.logger.error(
                errorDescription,
                `Error on underwrite evaluation: CALL_EXCEPTION. Dropping message.`,
            );
            return false;   // Do not retry eval
        }

        this.logger.warn(
            errorDescription,
            `Error on underwrite eval.`,
        );

        return true;
    }

    protected async onOrderCompletion(
        order: EvalOrder,
        success: boolean,
        _result: UnderwriteOrder | null,
        retryCount: number
    ): Promise<void> {

        const orderDescription = {
            fromVault: order.fromVault,
            fromChainId: order.fromChainId,
            swapTxHash: order.swapTxHash,
            swapId: order.swapIdentifier,
            try: retryCount + 1
        };

        if (success) {
            this.logger.debug(
                orderDescription,
                `Successful underwrite evaluation.`,
            );

        } else {
            this.logger.error(
                orderDescription,
                `Unsuccessful underwrite evaluation.`,
            );
        }
    }

    // private async saveSwapDescriptionByActiveUnderwrite(
    //     order: EvalOrder,
    //     toAsset: string,
    //     toInterface: string,
    //     calldata: string,
    // ): Promise<void> {
    //     const expectedUnderwriteId = calcUnderwriteIdentifier(
    //         order.toVault,
    //         toAsset,
    //         order.units,
    //         order.minOut,
    //         order.toAccount,
    //         order.underwriteIncentiveX16,
    //         calldata
    //     );

    //     await this.store.saveSwapDescriptionByExpectedUnderwrite(
    //         {
    //             poolId: order.poolId,
    //             toChainId: this.chainId,
    //             toInterface,
    //             underwriteId: expectedUnderwriteId,
    //         },
    //         {
    //             poolId: order.poolId,
    //             fromChainId: order.fromChainId,
    //             toChainId: this.chainId,
    //             fromVault: order.fromVault,
    //             swapId: order.swapIdentifier,
    //         }
    //     );

    // }



    // Management utils
    // ********************************************************************************************
    enableUnderwrites(): void {
        this.enabled = true;
        this.logger.debug('Underwriting enabled.');
    }

    disableUnderwrite(): void {
        this.enabled = false;
        this.logger.debug('Underwriting disabled.');
    }
}