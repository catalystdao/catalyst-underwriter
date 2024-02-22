//TODO store AMB data?

export interface TransactionDescription {
    txHash: string;
    blockHash: string;
    blockNumber: number;
}

export enum SwapStatus {
    Pending,
    Completed
}

export interface SwapDescription {
    poolId: string;
    fromChainId: string;
    toChainId: string;
    fromVault: string;
    swapId: string;
}

export interface SwapState {

    // Trusted fields (provided by the listener)
    poolId: string;
    fromChainId: string;
    fromVault: string;

    // Common swap fields (derived from events)
    status: SwapStatus;
    toChainId: string;
    swapId: string;
    toVault: string;
    toAccount: string;
    fromAsset: string;
    swapAmount: bigint;
    units: bigint;

    toAsset?: string;
    calldata?: string;

    underwriteId?: string;
    underwriteTxhash?: string;

    // Event-specific details
    sendAssetEvent?: SendAssetEventDetails;
    receiveAssetEvent?: ReceiveAssetEventDetails;
}

export interface SendAssetEventDetails extends TransactionDescription {
    fromChannelId: string;
    toAssetIndex: bigint;
    fromAmount: bigint;
    fee: bigint;
    minOut: bigint;
    underwriteIncentiveX16: bigint;
    observedAtBlockNumber: number;
}

export interface ReceiveAssetEventDetails extends TransactionDescription {
    toChannelId: string;
    toAsset: string;
    toAmount: bigint;
    sourceBlockNumberMod: number;
}



export enum UnderwriteStatus {
    Underwritten,
    Fulfilled,
    Expired
}

export interface ExpectedUnderwriteDescription {
    poolId: string;
    toChainId: string;
    toInterface: string;
    underwriteId: string;
}

export interface ActiveUnderwriteDescription {
    poolId: string;
    toChainId: string;
    toInterface: string;
    underwriter: string;
    underwriteId: string;
    expiry: number;
}

export interface CompletedUnderwriteDescription {
    poolId: string;
    toChainId: string;
    toInterface: string;
    underwriteId: string;
    underwriter: string;
    underwriteTxHash: string;
}

export interface UnderwriteState {

    // Trusted fields (provided by the listener)
    poolId: string;
    toChainId: string;
    toInterface: string;

    // Common underwrite fields (derived from events)
    status: UnderwriteStatus;
    underwriteId: string;

    // Event-specific details
    swapUnderwrittenEvent?: SwapUnderwrittenEventDetails;
    fulfillUnderwriteEvent?: FulfillUnderwriteEventDetails;
    expireUnderwriteEvent?: ExpireUnderwriteEventDetails;
}

export interface SwapUnderwrittenEventDetails extends TransactionDescription {
    underwriter: string;
    expiry: number;
    targetVault: string;
    toAsset: string;
    units: bigint;
    toAccount: string;
    outAmount: bigint;
};

export interface FulfillUnderwriteEventDetails extends TransactionDescription {};

export interface ExpireUnderwriteEventDetails extends TransactionDescription {
    expirer: string;
    reward: bigint;
}