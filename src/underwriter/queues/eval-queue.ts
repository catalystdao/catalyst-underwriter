import { calcAssetSwapIdentifier } from 'src/common/utils';
import { Wallet } from "ethers";
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "processing-queue/lib-esm/processing-queue";
import { EvalOrder, UnderwriteOrder } from "../underwriter.types";
import { PoolConfig } from "src/config/config.service";
import { CatalystVaultCommon__factory } from "src/contracts";
import fetch from 'node-fetch';
import { CatalystContext, catalystParse } from 'src/common/decode.catalyst';
import { parsePayload } from 'src/common/decode.payload';

export class EvalQueue extends ProcessingQueue<EvalOrder, UnderwriteOrder> {

    constructor(
        readonly pools: PoolConfig[],
        readonly retryInterval: number,
        readonly maxTries: number,
        private readonly signer: Wallet,
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

        const toVaultConfig = poolConfig.vaults.find((vault) => vault.vaultAddress == order.toVault);
        if (toVaultConfig == undefined) {
            // NOTE: The following error is matched on `handleFailedOrder`
            throw new Error(`No vault ${order.toVault} defined on pool ${order.poolId}`);
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
            this.signer
        );
        const toAsset = await toVaultContract._tokenIndexing(order.toAssetIndex);


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
                /^Unknown pool id (0x)?[0-9a-f]*/.test(error.message)
                || /^No vault (0x)?[0-9a-f]* defined on pool (0x)?[0-9a-f]*/.test(error.message)
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

}