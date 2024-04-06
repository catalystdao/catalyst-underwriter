import { HandleOrderResult, ProcessingQueue } from "src/processing-queue/processing-queue";
import { DiscoverOrder, EvalOrder } from "../underwriter.types";
import { JsonRpcProvider } from "ethers";
import pino from "pino";
import { TokenConfig } from "src/config/config.types";
import { tryErrorToString } from "src/common/utils";
import { CatalystVaultCommon__factory } from "src/contracts";
import { Store } from "src/store/store.lib";


export class DiscoverQueue extends ProcessingQueue<DiscoverOrder, EvalOrder> {

    private vaultAssets = new Map<string, string>();    // Maps a key formed by the vault+assetIndex to the asset address.

    constructor(
        readonly chainId: string,
        readonly tokens: Record<string, TokenConfig>,
        readonly retryInterval: number,
        readonly maxTries: number,
        private readonly store: Store,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    // NOTE: The discover queue must not be disabled when the underwriter gets disabled, as it is
    // used to store the underwrite parameters for later use by the expirer service.
    
    protected async handleOrder(order: DiscoverOrder, _retryCount: number): Promise<HandleOrderResult<EvalOrder> | null> {
        
        //TODO validate escrow
        //TODO validate interface
        //TODO validate vault template

        const toAsset = await this.getVaultAsset(order.toVault, order.toAssetIndex);
        if (toAsset == undefined) {
            // NOTE: The following error is matched on `handleFailedOrder`
            throw new Error('Failed to get the vault asset at the requested index.')
        }

        const result: EvalOrder = {
            ...order,
            toAsset
        }

        return { result };

    }

    protected async handleFailedOrder(order: DiscoverOrder, retryCount: number, error: any): Promise<boolean> {
        
        const errorDescription = {
            fromVault: order.fromVault,
            fromChainId: order.fromChainId,
            swapTxHash: order.swapTxHash,
            swapId: order.swapIdentifier,
            error: tryErrorToString(error),
            try: retryCount + 1
        };

        this.logger.warn(
            errorDescription,
            `Error on underwrite parameters discovery.`,
        );

        return true;
    }

    protected async onOrderCompletion(
        order: DiscoverOrder,
        success: boolean,
        _result: EvalOrder | null,
        retryCount: number
    ): Promise<void> {

        const orderDescription = {
            fromVault: order.fromVault,
            fromChainId: order.fromChainId,
            swapTxHash: order.swapTxHash,
            swapId: order.swapIdentifier,
            try: retryCount + 1
        };

        //TODO store params for expirer

        if (success) {
            this.logger.debug(
                orderDescription,
                `Successful underwrite discovery.`,
            );

        } else {
            this.logger.error(
                orderDescription,
                `Unsuccessful underwrite discovery.`,
            );
        }
    }

    private async getVaultAsset(vault: string, assetIndex: bigint): Promise<string | undefined> {
        const cachedAsset = this.vaultAssets.get(`${vault.toLowerCase()}.${assetIndex}`);
        if (cachedAsset != undefined) {
            return cachedAsset;
        }
        
        return this.queryVaultAsset(vault, assetIndex);
    }

    private async queryVaultAsset(vault: string, assetIndex: bigint): Promise<string | undefined> {
        try {
            const vaultContract = CatalystVaultCommon__factory.connect(
                vault,
                this.provider
            );
            const asset = await vaultContract._tokenIndexing(assetIndex);
            this.vaultAssets.set(`${vault.toLowerCase()}.${assetIndex}`, asset);
            return asset;
        } catch {
            return undefined;
        }
    }


}