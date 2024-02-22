import { BytesLike, TransactionReceipt, TransactionResponse } from "ethers";


export interface Order {
    // Trusted fields (provided by the listener)
    poolId: string;
    fromChainId: string;
    fromVault: string;
    swapTxHash: string;
    swapBlockNumber: number;
    swapObservedAtBlockNumber: number;

    // Derived from the SendAsset event
    swapIdentifier: string;
    sourceIdentifier: string;

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

export interface UnderwriteOrderResult extends UnderwriteOrder {
    tx: TransactionResponse;
    txReceipt: TransactionReceipt;
}

export interface PendingApproval {
    isApproval: boolean;
    interface: string;
    asset: string;
    setAllowance: bigint;
    requiredAllowance: bigint;
}


export interface NewOrder<OrderType> {
    order: OrderType;
    processAt: number;
}
