import { calcAssetSwapIdentifier, calcUnderwriteIdentifier, tryErrorToString } from 'src/common/utils';
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "../../processing-queue/processing-queue";
import { EvalOrder, UnderwriteOrder } from "../underwriter.types";
import { PoolConfig, TokenConfig } from "src/config/config.types";
import { CatalystVaultCommon__factory } from "src/contracts";
import fetch from 'node-fetch';
import { CatalystContext, catalystParse } from 'src/common/decode.catalyst';
import { MessageContext, parsePayload } from 'src/common/decode.payload';
import { JsonRpcProvider } from 'ethers';
import { Store } from 'src/store/store.lib';
import { TokenHandler } from '../token-handler/token-handler';

export class EvalQueue extends ProcessingQueue<EvalOrder, UnderwriteOrder> {

    constructor(
        private enabled: boolean,
        readonly chainId: string,
        readonly tokens: Record<string, TokenConfig>,
        readonly pools: PoolConfig[],
        readonly retryInterval: number,
        readonly maxTries: number,
        private readonly underwriteBlocksMargin: number,
        private readonly minRelayDeadlineDuration: bigint,
        private readonly tokenHandler: TokenHandler,
        private readonly store: Store,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    isUnderwritingEnabled(): boolean {
        return this.enabled;
    }

    protected async handleOrder(order: EvalOrder, retryCount: number): Promise<HandleOrderResult<UnderwriteOrder> | null> {

        const poolConfig = this.pools.find((pool) => pool.id == order.poolId);
        if (poolConfig == undefined) {
            // NOTE: The following error is matched on `handleFailedOrder`
            throw new Error(`Unknown pool id ${order.poolId}`);
        }

        const fromVaultConfig = poolConfig.vaults.find((vault) => vault.chainId == order.fromChainId);
        if (fromVaultConfig == undefined) {
            // NOTE: The following error is matched on `handleFailedOrder`
            throw new Error(`No vault on chain ${order.fromChainId} defined on pool ${order.poolId}`);
        }

        const toVaultConfig = poolConfig.vaults.find((vault) => vault.chainId == this.chainId);
        if (toVaultConfig == undefined) {
            // NOTE: The following error is matched on `handleFailedOrder`
            throw new Error(`No vault on chain ${this.chainId} defined on pool ${order.poolId}`);
        }

        // Get the amb
        const ambMessageData = await this.queryAMBMessageData(
            order.fromChainId,
            order.swapTxHash,
            fromVaultConfig.interfaceAddress,
            order.fromVault,
            order.swapIdentifier
        );

        if (ambMessageData == undefined) {
            throw new Error(`Underwrite evaluation fail: AMB of txHash ${order.swapTxHash} (chain ${order.fromChainId}) not found`);
        }

        const toVaultContract = CatalystVaultCommon__factory.connect(
            order.toVault,
            this.provider
        );
        const toAsset = await toVaultContract._tokenIndexing(order.toAssetIndex);

        // Save the 'toAsset' and 'calldata' for later use by the expirer
        await this.saveAdditionalSwapData(
            order,
            toAsset,
            ambMessageData.calldata,
        );

        // Save the map 'underwrite-to-swap' for later use by the expirer
        const interfaceAddress = toVaultConfig.interfaceAddress;
        await this.saveSwapDescriptionByActiveUnderwrite(
            order,
            toAsset,
            interfaceAddress,
            ambMessageData.calldata,
        );

        // ! The 'don't underwrite' code snippets cannot be moved before the query/save calldata
        // ! methods, as those are required by the expirer service.

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
        if (ambMessageData.deadline != 0n) {
            const relayDeadlineDurationSeconds = ambMessageData.deadline - BigInt(order.swapBlockTimestamp);
            if (relayDeadlineDurationSeconds < this.minRelayDeadlineDuration / 1000n) {
                this.logger.info(
                    {
                        swapId: order.swapIdentifier,
                        swapTxHash: order.swapTxHash,
                        swapBlockNumber: order.swapBlockNumber,
                        deadline: ambMessageData.deadline
                    },
                    "Skipping underwrite: incentivised message deadline is too short"
                );
                return null;
            }
        }

        // Verify the token to underwrite is supported
        const tokenConfig = this.tokens[toAsset.toLowerCase()];
        if (tokenConfig == undefined) {
            this.logger.warn(
                {
                    swapId: order.swapIdentifier,
                    swapTxHash: order.swapTxHash,
                    swapBlockNumber: order.swapBlockNumber,
                    toAsset
                },
                "Skipping underwrite: token to underwrite not supported."
            );
            return null;
        }

        // Estimate return
        const expectedReturn = await toVaultContract.calcReceiveAsset(toAsset, order.units);
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
                    toAsset,
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
                    toAsset,
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
            toAsset
        );
        if (!enoughBalanceToUnderwrite) {
            this.logger.warn(
                {
                    swapId: order.swapIdentifier,
                    swapTxHash: order.swapTxHash,
                    swapBlockNumber: order.swapBlockNumber,
                    toAsset,
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
                toAsset
            );

            const result: UnderwriteOrder = {
                ...order,
                toAsset,
                toAssetAllowance,
                interfaceAddress,
                calldata: ambMessageData.calldata,
                maxGasLimit,
                ambMessageData: {
                    messageIdentifier: ambMessageData.messageIdentifier,
                    amb: ambMessageData.amb,
                    sourceChainId: ambMessageData.sourceChainId,
                    destinationChainId: ambMessageData.destinationChainId,
                }
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

    private async queryAMBMessageData(
        chainId: string,
        txHash: string,
        sourceInterface: string,
        sourceVault: string,
        swapId: string
    ): Promise<{
        calldata: string;
        messageIdentifier: string;
        amb: string;
        sourceChainId: string;
        destinationChainId: string;
        deadline: bigint;        
    } | undefined> {

        const relayerEndpoint = `http://${process.env.RELAYER_HOST}:${process.env.RELAYER_PORT}/getAMBs?`;

        const res = await fetch(relayerEndpoint + new URLSearchParams({chainId, txHash}));
        const ambs = (await res.json());    //TODO type

        // Find the AMB that matches the SendAsset event
        for (const amb of ambs) {
            try {
                const giPayload = parsePayload(amb.payload);

                if (giPayload.context != MessageContext.CTX_SOURCE_TO_DESTINATION) continue;

                if (giPayload.sourceApplicationAddress.toLowerCase() != sourceInterface.toLowerCase()) continue;

                const catalystPayload = catalystParse(giPayload.message);

                if (catalystPayload.context != CatalystContext.ASSET_SWAP) continue;

                if (catalystPayload.fromVault.toLowerCase() != sourceVault.toLowerCase()) continue;

                const ambSwapId = calcAssetSwapIdentifier(
                    catalystPayload.toAccount,
                    catalystPayload.units,
                    catalystPayload.fromAmount,
                    catalystPayload.fromAsset,
                    catalystPayload.blockNumber
                )

                if (ambSwapId.toLowerCase() != swapId.toLowerCase()) continue;

                return {
                    calldata: catalystPayload.cdata,
                    messageIdentifier: amb.messageIdentifier,
                    amb: amb.amb,
                    sourceChainId: amb.sourceChain,
                    destinationChainId: amb.destinationChain,
                    deadline: giPayload.deadline
                };

            } catch {
                // Continue
            }
        }

        return undefined;
    }

    private async saveAdditionalSwapData(
        order: EvalOrder,
        toAsset: string,
        calldata: string
    ): Promise<void> {
        await this.store.saveAdditionalSwapData(
            order.fromChainId,
            order.fromVault,
            order.swapIdentifier,
            toAsset,
            calldata,
        );
    }

    private async saveSwapDescriptionByActiveUnderwrite(
        order: EvalOrder,
        toAsset: string,
        toInterface: string,
        calldata: string,
    ): Promise<void> {
        const expectedUnderwriteId = calcUnderwriteIdentifier(
            order.toVault,
            toAsset,
            order.units,
            order.minOut,
            order.toAccount,
            order.underwriteIncentiveX16,
            calldata
        );

        await this.store.saveSwapDescriptionByExpectedUnderwrite(
            {
                poolId: order.poolId,
                toChainId: this.chainId,
                toInterface,
                underwriteId: expectedUnderwriteId,
            },
            {
                poolId: order.poolId,
                fromChainId: order.fromChainId,
                toChainId: this.chainId,
                fromVault: order.fromVault,
                swapId: order.swapIdentifier,
            }
        );

    }



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