import { BytesLike, BigNumberish } from "ethers";


export interface Order {
    // Trusted fields (provided by the listener)
    poolId: string;
    fromChainId: string;
    fromVault: string;
    txHash: string;

    // Derived from the SendAsset event
    swapIdentifier: string;

    // SendAsset event fields
    channelId: string;
    toVault: string;
    toAccount: string;
    fromAsset: string;
    toAssetIndex: bigint;
    fromAmount: bigint;
    minOut: bigint;
    units: bigint;
    fee: bigint;
    underwriteIncentiveX16: bigint;
}

export interface EvalOrder extends Order {
}

export interface UnderwriteOrder extends Order {
    calldata: BytesLike;
    gasLimit: number | undefined;
    toAsset: string;
    toAssetAllowance: bigint;
    interfaceAddress: string;
}


export interface NewOrder<OrderType> {
    order: OrderType;
    processAt: number;
}


export interface GasFeeOverrides {
    gasPrice?: BigNumberish;
    maxFeePerGas?: BigNumberish;
    maxPriorityFeePerGas?: BigNumberish;
}

export interface GasFeeConfig {
    gasPriceAdjustmentFactor: number | undefined;
    maxAllowedGasPrice: bigint | undefined;
    maxFeePerGas: bigint | undefined;
    maxPriorityFeeAdjustmentFactor: number | undefined;
    maxAllowedPriorityFeePerGas: bigint | undefined;
}