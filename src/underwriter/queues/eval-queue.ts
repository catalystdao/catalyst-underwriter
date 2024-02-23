import { calcAssetSwapIdentifier, calcUnderwriteIdentifier } from 'src/common/utils';
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "../../processing-queue/processing-queue";
import { EvalOrder, UnderwriteOrder } from "../underwriter.types";
import { PoolConfig } from "src/config/config.service";
import { CatalystVaultCommon__factory } from "src/contracts";
import fetch from 'node-fetch';
import { CatalystContext, catalystParse } from 'src/common/decode.catalyst';
import { parsePayload } from 'src/common/decode.payload';
import { JsonRpcProvider } from 'ethers';
import { Store } from 'src/store/store.lib';

export class EvalQueue extends ProcessingQueue<EvalOrder, UnderwriteOrder> {

    constructor(
        readonly chainId: string,
        readonly pools: PoolConfig[],
        readonly retryInterval: number,
        readonly maxTries: number,
        private readonly underwriteBlocksMargin: number,
        private readonly store: Store,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    protected async handleOrder(order: EvalOrder, retryCount: number): Promise<HandleOrderResult<UnderwriteOrder> | null> {

        const poolConfig = this.pools.find((pool) => pool.id == order.poolId);
        if (poolConfig == undefined) {
            // NOTE: The following error is matched on `handleFailedOrder`
            throw new Error(`Unknown pool id ${order.poolId}`);
        }

        const toVaultConfig = poolConfig.vaults.find((vault) => vault.chainId == this.chainId);
        if (toVaultConfig == undefined) {
            // NOTE: The following error is matched on `handleFailedOrder`
            throw new Error(`No vault on chain ${this.chainId} defined on pool ${order.poolId}`);
        }

        // Get the amb
        const interfaceAddress = toVaultConfig.interfaceAddress;
        const calldata = await this.queryAMBCalldata(
            order.fromChainId,
            order.swapTxHash,
            interfaceAddress,
            order.fromVault,
            order.swapIdentifier
        );

        if (calldata == undefined) {
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
            calldata,
        );

        // Save the map 'underwrite-to-swap' for later use by the expirer
        await this.saveSwapDescriptionByActiveUnderwrite(
            order,
            toAsset,
            interfaceAddress,
            calldata
        );

        // Never underwrite if too much time has passed since the original swap transaction
        // ! This code snippet cannot be moved before the query/save calldata methods, as those are
        // ! required by the expirer service.
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

        // Estimate return
        const expectedReturn = await toVaultContract.calcReceiveAsset(toAsset, order.units);
        const toAssetAllowance = expectedReturn * 11n / 10n;    //TODO set customizable allowance margin

        //TODO evaluation
        if (true) {
            const result: UnderwriteOrder = {
                ...order,
                toAsset,
                toAssetAllowance,
                interfaceAddress,
                calldata,
                gasLimit: 1000000 //TODO
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
            error,
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

    private async queryAMBCalldata(
        chainId: string,
        txHash: string,
        sourceInterface: string,
        sourceVault: string,
        swapId: string
    ): Promise<string | undefined> {

        const relayerEndpoint = `http://${process.env.RELAYER_HOST}:${process.env.RELAYER_PORT}/getAMBs?`;

        const res = await fetch(relayerEndpoint + new URLSearchParams({chainId, txHash}));
        const ambs = (await res.json());    //TODO type

        // Find the AMB that matches the SendAsset event
        for (const amb of ambs) {
            try {
                const giPayload = parsePayload(amb.payload);

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

                return catalystPayload.cdata;

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

}