import { tryErrorToString } from 'src/common/utils';
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "../../processing-queue/processing-queue";
import { EvalOrder, UnderwriteOrder, UnderwriterTokenConfig } from "../underwriter.types";
import { CatalystVaultCommon__factory } from "src/contracts";
import { JsonRpcProvider, MaxUint256 } from 'ethers';
import { TokenHandler } from '../token-handler/token-handler';
import { WalletInterface } from 'src/wallet/wallet.interface';

const DECIMAL_RESOLUTION = 1_000_000;
const DECIMAL_RESOLUTION_BIGINT = BigInt(DECIMAL_RESOLUTION);

export class EvalQueue extends ProcessingQueue<EvalOrder, UnderwriteOrder> {

    private readonly effectiveAllowanceBuffer: bigint;    // NOTE: this includes the underwriting collateral

    constructor(
        private enabled: boolean,
        private readonly chainId: string,
        private readonly tokens: Record<string, UnderwriterTokenConfig>,
        retryInterval: number,
        maxTries: number,
        underwritingCollateral: number,
        private readonly allowanceBuffer: number,
        private readonly maxUnderwriteDelay: number,
        private readonly minRelayDeadlineDuration: bigint,
        private readonly minMaxGasDelivery: bigint,
        private readonly tokenHandler: TokenHandler,
        private readonly wallet: WalletInterface,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);

        this.effectiveAllowanceBuffer = this.calcEffectiveAllowanceBuffer(
            underwritingCollateral,
            allowanceBuffer,
        );
    }

    private calcEffectiveAllowanceBuffer(
        underwritingCollateral: number,
        allowanceBuffer: number
    ): bigint {
        return BigInt(
            Math.floor((1 + underwritingCollateral) * (1 + allowanceBuffer) * DECIMAL_RESOLUTION)
        );
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
                },
                "Skipping underwrite: underwriter disabled."
            )
            return null;
        }

        // Never underwrite if too much time has passed since the original swap transaction
        // NOTE: 'swapBlockTimestamp' is in seconds, whereas 'maxUnderwriteDelay' is in milliseconds
        if (Date.now() > order.swapBlockTimestamp * 1000 + this.maxUnderwriteDelay) {
            this.logger.warn(
                {
                    swapId: order.swapIdentifier,
                    swapTxHash: order.swapTxHash,
                    swapBlockTimestamp: order.swapBlockTimestamp,
                    maxUnderwriteDelay: this.maxUnderwriteDelay
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
                        swapBlockTimestamp: order.swapBlockTimestamp,
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
        const toAssetAllowance = expectedReturn * this.effectiveAllowanceBuffer / DECIMAL_RESOLUTION_BIGINT;

        // Set the maximum allowed gasLimit for the transaction. This will be checked on the
        // 'underwrite' queue with an 'estimateGas' call.
        // ! It is not possible to 'estimateGas' of the underwrite transaction at this point, as
        // ! before doing it the allowance for underwriting must be set. The allowance for
        // ! underwriting is set **after** the evaluation step, as the allowance amount is not
        // ! known until the evaluation step completes.

        const relayFiatProfitEstimate = await this.querySwapRelayProfitEstimate(
            this.chainId,
            order.messageIdentifier,
            order.relayDeliveryCosts.gasUsage,
            order.relayDeliveryCosts.gasObserved,
            order.relayDeliveryCosts.fee,
            order.relayDeliveryCosts.value,
        );

        const underwriteFiatAmount = await this.getTokenValue(
            this.chainId,
            tokenConfig.tokenId,
            expectedReturn
        );

        // Verify the underwrite value is allowed
        if (
            tokenConfig.maxUnderwriteAllowed
            && underwriteFiatAmount * (1 + this.allowanceBuffer) > tokenConfig.maxUnderwriteAllowed
        ) {
            this.logger.info(
                {
                    swapId: order.swapIdentifier,
                    swapTxHash: order.swapTxHash,
                    toAsset: order.toAsset,
                    allowanceBuffer: this.allowanceBuffer,
                    underwriteAmount: underwriteFiatAmount,
                    maxUnderwriteAllowed: tokenConfig.maxUnderwriteAllowed
                },
                "Skipping underwrite: underwrite exceeds the 'maxUnderwriteAllowed' configuration."
            );
            return null;
        }

        const underwriteIncentiveShare = Number(order.underwriteIncentiveX16) / 2**16;
        const rewardFiatAmount = underwriteFiatAmount * underwriteIncentiveShare;

        const gasPrice = await this.getGasPrice(this.chainId);
        const maxGasLimit = await this.calcMaxGasLimit(
            underwriteFiatAmount,
            rewardFiatAmount,
            gasPrice,
            tokenConfig,
            relayFiatProfitEstimate,
        );

        this.logger.info(
            {
                swapId: order.swapIdentifier,
                swapTxHash: order.swapTxHash,
                toAsset: order.toAsset,
                underwriteAmount: expectedReturn,
                underwriteFiatAmount,
                underwriteIncentiveX16: order.underwriteIncentiveX16,
                rewardFiatAmount,
                gasPrice,
                tokenConfig,
                relayFiatProfitEstimate,
                maxGasLimit,
            },
            "Underwrite evaluation."
        )

        if (maxGasLimit <= 0n) {
            this.logger.info(
                {
                    swapId: order.swapIdentifier,
                    swapTxHash: order.swapTxHash,
                    maxGasLimit                    
                },
                "Skipping underwrite: calculated maximum gas limit is 0 or negative."
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
                    toAsset: order.toAsset,
                    requiredAllowance: toAssetAllowance,
                },
                "Skipping underwrite: not enough token balance to perform underwrite."
            );
            return null;
        }


        await this.tokenHandler.registerBalanceUse(
            toAssetAllowance,
            order.toAsset
        );

        const result: UnderwriteOrder = {
            ...order,
            maxGasLimit,
            gasPrice,
            toAssetAllowance,
        }
        return { result };
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

    protected override async onOrderCompletion(
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
            this.logger.info(
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

    async calcMaxGasLimit(
        underwriteFiatAmount: number,
        rewardFiatAmount: number,
        gasPrice: bigint,
        tokenConfig: UnderwriterTokenConfig,
        relayFiatProfitEstimate: number,
    ): Promise<bigint> {

        // Use the 'profitabilityFactor' to bias the profitability calculation: a larger factor
        // implies a larger profitability guarantee. If set to '0', effectively disable the 
        // evaluation step.
        const adjustedRewardFiatAmount = tokenConfig.profitabilityFactor == 0
            ? Infinity
            : rewardFiatAmount / tokenConfig.profitabilityFactor;

        if (Math.floor(adjustedRewardFiatAmount * DECIMAL_RESOLUTION) == 0) {
            return 0n;
        }

        // Only take into account the relay profit if it's negative.
        const relayFiatProfit = Math.min(relayFiatProfitEstimate, 0);
        const maxFiatTxCostToBreakEven = adjustedRewardFiatAmount + relayFiatProfit; 

        const gasFiatPrice = await this.getGasValue(this.chainId, gasPrice);


        // TODO is the following logic enough? This logic would allow unrealistically large
        // TODO `maxGasLimit`s.
        // Compute the limit based on the 'minUnderwriteReward'
        const maxGasLimitMinReward = (
            maxFiatTxCostToBreakEven - tokenConfig.minUnderwriteReward
        ) / gasFiatPrice;

        // Compute the limit based on the 'relativeMinUnderwriteReward'
        const maxGasLimitMinRelativeReward = (
            maxFiatTxCostToBreakEven - tokenConfig.relativeMinUnderwriteReward * underwriteFiatAmount
        ) / (gasFiatPrice * (1 + tokenConfig.relativeMinUnderwriteReward));

        const maxGasLimit = maxGasLimitMinReward < maxGasLimitMinRelativeReward
            ? maxGasLimitMinReward
            : maxGasLimitMinRelativeReward;

        return maxGasLimit == Infinity
            ? MaxUint256
            : BigInt(Math.floor(maxGasLimit));
    }

    async getGasValue(
        chainId: string,
        amount: bigint,
    ): Promise<number> {
        return this.queryRelayerAssetPrice(chainId, amount);
    }

    async getTokenValue(
        chainId: string,
        tokenId: string,
        amount: bigint
    ): Promise<number> {
        return this.queryRelayerAssetPrice(chainId, amount, tokenId);
    }

    private async queryRelayerAssetPrice(
        chainId: string,
        amount: bigint,
        tokenId?: string,
    ): Promise<number> {

        if (amount == 0n) {
            return 0;
        }
        
        const relayerEndpoint = `http://${process.env['RELAYER_HOST']}:${process.env['RELAYER_PORT']}/getPrice?`;

        const queryParameters: Record<string, string> = {
            chainId,
            amount: amount.toString(),
        }

        if (tokenId != undefined) {
            queryParameters['tokenId'] = tokenId;
        }

        const res = await fetch(relayerEndpoint + new URLSearchParams(queryParameters));
        const priceResponse = (await res.json());    //TODO type

        if (priceResponse.price == undefined) {
            this.logger.warn(
                {
                    chainId,
                    tokenId,
                    amount,
                },
                `Failed to query token value.`
            );
            return 0;
        }

        return priceResponse.price;
    }

    private async getGasPrice(chainId: string): Promise<bigint> {
        const feeData = await this.wallet.getFeeData(chainId);
        // If gas fee data is missing or incomplete, default the gas price to an extremely high
        // value.
        // ! Use 'gasPrice' over 'maxFeePerGas', as 'maxFeePerGas' defines the highest gas fee
        // ! allowed, which does not necessarilly represent the real gas fee at which the
        // ! transactions are going through.
        const gasPrice = feeData?.gasPrice
            ?? feeData?.maxFeePerGas
            ?? MaxUint256;

        return gasPrice;
    }

    private async querySwapRelayProfitEstimate(
        chainId: string,
        messageIdentifier: string,
        gasEstimate: bigint,
        observedGasEstimate: bigint,
        additionalFeeEstimate: bigint,
        value: bigint,
    ): Promise<number> {

        const relayerEndpoint = `http://${process.env['RELAYER_HOST']}:${process.env['RELAYER_PORT']}/evaluateDelivery?`;

        const queryParameters: Record<string, string> = {
            chainId,
            messageIdentifier,
            gasEstimate: gasEstimate.toString(),
            observedGasEstimate: observedGasEstimate.toString(),
            additionalFeeEstimate: additionalFeeEstimate.toString(),
            value: value.toString(),
        }

        try {
            const res = await fetch(relayerEndpoint + new URLSearchParams(queryParameters));
            const evaluationResponse = (await res.json());    //TODO type

            return evaluationResponse.securedDeliveryFiatProfit;
        }
        catch (error) {
            this.logger.error(
                {
                    queryParameters,
                    error: tryErrorToString(error),
                },
                `Failed to query swap relay profit estimate.`
            );
            throw new Error(`Failed to query swap relay profit estimate.`);
        }
    }



    // Management utils
    // ********************************************************************************************
    enableUnderwrites(): void {
        this.enabled = true;
        this.logger.info('Underwriting enabled.');
    }

    disableUnderwrite(): void {
        this.enabled = false;
        this.logger.info('Underwriting disabled.');
    }
}