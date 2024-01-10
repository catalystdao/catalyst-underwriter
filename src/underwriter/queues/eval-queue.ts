import { Wallet } from "ethers";
import pino from "pino";
import { RetryQueue } from "./retry-queue";
import { EvalOrder, UnderwriteOrder } from "../underwriter.types";
import { PoolConfig } from "src/config/config.service";
import { CatalystVaultCommon__factory, Token__factory } from "src/contracts";

export class EvalQueue extends RetryQueue<EvalOrder, UnderwriteOrder> {

    constructor(
        readonly pools: PoolConfig[],
        readonly retryInterval: number,
        readonly maxTries: number,
        private readonly signer: Wallet,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    async init(): Promise<void> {
        // No init required for the eval queue
    }

    protected async onRetryOrderDrop(order: EvalOrder, retryCount: number): Promise<void> {
        this.logger.error(
          `Failed to eval underwrite for swap ${order.swapIdentifier} (swap txHash ${order.txHash}). Dropping message (try ${retryCount + 1}).`,
        );
    }

    protected async handleOrder(order: EvalOrder, retryCount: number): Promise<UnderwriteOrder | null> {

        const poolConfig = this.pools.find((pool) => pool.id == order.poolId);
        if (poolConfig == undefined) {
            this.logger.error(`Unknown pool id ${order.poolId}`);
            return null;
        }

        const toVaultConfig = poolConfig.vaults.find((vault) => vault.vaultAddress == order.toVault);
        if (toVaultConfig == undefined) {
            this.logger.error(`No vault ${order.toVault} defined on pool ${order.poolId}`);
            return null;
        }

        const toVaultContract = CatalystVaultCommon__factory.connect(
            order.toVault,
            this.signer
        );
        const toAsset = await toVaultContract._tokenIndexing(order.toAssetIndex);

        const interfaceAddress = toVaultConfig.interfaceAddress;

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
            return {
                ...order,
                toAsset,
                toAssetAllowance,
                interfaceAddress,
                calldata: '0x0000', //TODO
                gasLimit: 1000000 //TODO
            };
        } else {
            this.logger.info(
                `Dropping order ${'TODO'} on evaluation (try ${retryCount + 1})`   //TODO set order id
            );

            return null;
        }
    }

    protected async handleFailedOrder(order: EvalOrder, retryCount: number, error: any): Promise<boolean> {
        //TODO improve error filtering?
        if (error.code === 'CALL_EXCEPTION') {
            this.logger.error(
                error,
                `Failed to evaluate message ${order}: CALL_EXCEPTION. Dropping message (try ${retryCount + 1}).`,
            );
            return false;
        }

        this.logger.warn(
            error,
            `Failed to eval order ${'TODO'} (try ${retryCount + 1})`,   //TODO set order id
        );

        return true;
    }

}