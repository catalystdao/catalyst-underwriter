import { HandleOrderResult, ProcessingQueue } from "src/processing-queue/processing-queue";
import { DiscoverOrder, EvalOrder, UnderwriterEndpointConfig } from "../underwriter.types";
import { JsonRpcProvider } from "ethers";
import pino from "pino";
import { TokenConfig } from "src/config/config.types";
import { calcUnderwriteIdentifier, tryErrorToString } from "src/common/utils";
import { CatalystFactory__factory, CatalystVaultCommon__factory } from "src/contracts";
import { Store } from "src/store/store.lib";


export class DiscoverQueue extends ProcessingQueue<DiscoverOrder, EvalOrder> {

    private validatedVaults = new Map<string, boolean>();   // Maps a vault address to a 'valid' flag.
    private vaultAssets = new Map<string, string>();        // Maps a key formed by the vault+assetIndex to the asset address.

    constructor(
        private readonly chainId: string,
        private readonly endpointConfigs: UnderwriterEndpointConfig[],
        private readonly tokens: Record<string, TokenConfig>,
        retryInterval: number,
        maxTries: number,
        private readonly store: Store,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger
    ) {
        super(retryInterval, maxTries);
    }

    // NOTE: The discover queue must not be disabled when the underwriter gets disabled, as it is
    // used to store the underwrite parameters for later use by the expirer service.

    protected async handleOrder(order: DiscoverOrder, _retryCount: number): Promise<HandleOrderResult<EvalOrder> | null> {

        //TODO validate destination escrow?

        const endpoint = this.endpointConfigs.find((endpointConfig) => {
            return endpointConfig.interfaceAddress == order.interfaceAddress.toLowerCase()
        });

        if (endpoint == undefined) {
            this.logger.info(
                {
                    messageIdentifier: order.messageIdentifier,
                    interfaceAddress: order.interfaceAddress
                },
                "No endpoint found for the given underwrite discover order (no matching destination interface)."
            );
            return null;
        }

        // Verify the vault
        const isVaultValid = await this.isVaultVaild(order.toVault, order.interfaceAddress, endpoint);
        if (!isVaultValid) {
            this.logger.info(
                {
                    messageIdentifier: order.messageIdentifier,
                    interfaceAddress: order.interfaceAddress,
                    vaultAddress: order.toVault
                },
                "Destination vault is invalid. Skipping underwrite."
            );
            return null;
        }

        const toAsset = await this.getVaultAsset(order.toVault, order.toAssetIndex);
        if (toAsset == undefined) {
            // NOTE: The following error is matched on `handleFailedOrder`
            throw new Error('Failed to get the vault asset at the requested index.')
        }

        const result: EvalOrder = {
            ...order,
            toAsset,
            relayDeliveryCosts: endpoint.relayDeliveryCosts,
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

        if (typeof error.message == "string") {
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
                return true;    // Retry discovery (in case of an rpc query error)
            }
        }

        this.logger.warn(
            errorDescription,
            `Error on underwrite parameters discovery.`,
        );

        return true;
    }

    protected override async onOrderCompletion(
        order: DiscoverOrder,
        success: boolean,
        result: EvalOrder | null,
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
            if (result != null) {
                this.logger.info(
                    orderDescription,
                    `Successful underwrite discovery: destination vault valid.`,
                );

                void this.registerSwapDataForTheExpirer(result);
            } else {
                this.logger.info(
                    orderDescription,
                    `Successful underwrite discovery: destination vault invalid.`,
                );
            }
        } else {
            this.logger.error(
                orderDescription,
                `Unsuccessful underwrite discovery.`,
            );
        }
    }

    private async isVaultVaild(vaultAddress: string, interfaceAddress: string, endpointConfig: UnderwriterEndpointConfig): Promise<boolean> {

        const validCache = this.validatedVaults.get(vaultAddress);
        if (validCache != undefined) {
            return validCache;
        }

        const isCreatedByFactory = await this.queryIsVaultCreatedByFactory(
            vaultAddress,
            interfaceAddress,
            endpointConfig.factoryAddress
        );
        if (!isCreatedByFactory) {
            // If 'undefined' do not register the vault as invalid, as the rpc query might have failed.
            if (isCreatedByFactory === false) {
                this.validatedVaults.set(vaultAddress, false);
            }
            return false;
        }

        const vaultTemplate = await this.queryVaultProxyTemplate(vaultAddress);
        if (!vaultTemplate) {
            // If 'undefined' do not register the vault as invalid, as the rpc query might have failed.
            if (vaultTemplate === null) {
                this.validatedVaults.set(vaultAddress, false);
            }
            return false;
        }

        const isTemplateValid = endpointConfig.vaultTemplates.some((template) => template.address === vaultTemplate);
        this.validatedVaults.set(vaultAddress, isTemplateValid);

        return isTemplateValid;

    }

    private async queryIsVaultCreatedByFactory(
        vaultAddress: string,
        interfaceAddress: string,
        factoryAddress: string
    ): Promise<boolean | undefined> {
        // TODO what if this call fails? Implement retry?
        try {
            const factoryContract = CatalystFactory__factory.connect(factoryAddress, this.provider);
            const isCreatedByFactory = await factoryContract.isCreatedByFactory(interfaceAddress, vaultAddress);
            return isCreatedByFactory
        } catch (error) {
            this.logger.error(
                {
                    vaultAddress,
                    interfaceAddress,
                    factoryAddress,
                    error: tryErrorToString(error),
                },
                "Failed to query 'isCreatedByFactory'."
            );
            return undefined;
        }
    }

    private async queryVaultProxyTemplate(vaultAddress: string): Promise<string | null | undefined> {
        // TODO what if this call fails? Implement retry?
        try {
            const contractCode = (await this.provider.getCode(vaultAddress)).toLowerCase();

            const isContractCodeValid =
                contractCode.slice(0, 24) == "0x3d3d3d3d363d3d37363d73" &&
                contractCode.slice(64) == "5af43d3d93803e602a57fd5bf3";

            if (!isContractCodeValid) {
                return null;
            }

            return '0x' + contractCode.slice(24, 64);

        } catch (error) {
            this.logger.error(
                {
                    vaultAddress,
                    error: tryErrorToString(error),
                },
                "Failed to query vault proxy template address."
            );
            return undefined;
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

    private async registerSwapDataForTheExpirer(result: EvalOrder): Promise<void> {

        const expectedUnderwriteId = calcUnderwriteIdentifier(
            result.toVault,
            result.toAsset,
            result.units,
            result.minOut,
            result.toAccount,
            result.underwriteIncentiveX16,
            result.calldata
        );

        try {
            await this.store.saveAdditionalSwapData(
                result.fromChainId,
                result.fromVault,
                result.swapIdentifier,
                result.toAsset,
                expectedUnderwriteId
            );

            await this.store.saveSwapDescriptionByExpectedUnderwrite(
                {
                    toChainId: this.chainId,
                    toInterface: result.interfaceAddress,
                    underwriteId: expectedUnderwriteId,
                },
                {
                    fromChainId: result.fromChainId,
                    toChainId: this.chainId,
                    fromVault: result.fromVault,
                    swapId: result.swapIdentifier,
                }
            );
        } catch (error) {
            this.logger.warn(
                {
                    toChainId: this.chainId,
                    toInterface: result.interfaceAddress,
                    underwriteId: expectedUnderwriteId,
                    error: tryErrorToString(error),
                },
                "Failed to register additional swap data for the expirer."
            );
        }

    }

}