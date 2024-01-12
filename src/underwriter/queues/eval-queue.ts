import { calcAssetSwapIdentifier } from 'src/common/utils';
import { Wallet } from "ethers";
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "./processing-queue";
import { EvalOrder, UnderwriteOrder } from "../underwriter.types";
import { PoolConfig } from "src/config/config.service";
import { CatalystVaultCommon__factory, Token__factory } from "src/contracts";
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
            order.txHash,
            interfaceAddress,
            order.fromVault,
            order.swapIdentifier
        );

        if (calldata == undefined) {
            throw new Error(`Underwrite evaluation fail: AMB of txHash ${order.txHash} (chain ${order.fromChainId}) not found`);
        }

        const toVaultContract = CatalystVaultCommon__factory.connect(
            order.toVault,
            this.signer
        );
        const toAsset = await toVaultContract._tokenIndexing(order.toAssetIndex);


        // Estimate return
        const expectedReturn = await toVaultContract.calcReceiveAsset(toAsset, order.units);
        const toAssetAllowance = expectedReturn * 11n / 10n;    //TODO set customizable allowance margin

        // Set allowance
        // TODO overhaul approval logic
        // - what if there are multiple pending tx
        // - what if there aren't enough funds
        const tokenContract = Token__factory.connect(
            toAsset,
            this.signer
        );
        const approveTx = await tokenContract.approve(
            interfaceAddress,
            2n**256n-1n, // Set unlimited approval
            {gasLimit: 1000000} //TODO required for anvil, remove
        );
        await approveTx.wait();


        // Set approval

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
                `Dropping order ${'TODO'} on evaluation (try ${retryCount + 1})`   //TODO set order id
            );

            return null;
        }
    }

    protected async handleFailedOrder(order: EvalOrder, retryCount: number, error: any): Promise<boolean> {

        if (typeof error.message == "string") {
            if (
                /^Unknown pool id (0x)?[0-9a-f]*/.test(error.message)
                || /^No vault (0x)?[0-9a-f]* defined on pool (0x)?[0-9a-f]*/.test(error.message)
            ) {
                this.logger.warn(
                    error,
                    `Error on underwrite eval ${'TODO'}. Dropping message. (try ${retryCount + 1})`,   //TODO set order id
                );
                return false;   // Do not retry eval
            }
        }

        //TODO improve error filtering?
        if (error.code === 'CALL_EXCEPTION') {
            this.logger.error(
                error,
                `Error on underwrite eval ${'TODO'}: CALL_EXCEPTION. Dropping message. (try ${retryCount + 1})`,   //TODO set order id
            );
            return false;   // Do not retry eval
        }

        this.logger.warn(
            error,
            `Error on underwrite eval ${'TODO'} (try ${retryCount + 1})`,   //TODO set order id
        );

        return true;
    }

    protected async onOrderCompletion(
        order: EvalOrder,
        success: boolean,
        _result: UnderwriteOrder | null,
        retryCount: number
    ): Promise<void> {
        if (success) {
            this.logger.debug(
              `Successful underwrite eval of swap ${order.swapIdentifier} (swap txHash ${order.txHash}). (try ${retryCount + 1})`,
            );

        } else {
            this.logger.error(
              `Unsuccessful underwrite eval of swap ${order.swapIdentifier} (swap txHash ${order.txHash}). (try ${retryCount + 1})`,
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