
export enum UnderwriteStatus {
    NoUnderwrite,
    Underwritten,
    Fulfilled,
    Expired
}

export interface SwapStatus {

    // Trusted fields (provided by the listener)
    poolId: string;
    fromChainId: string;
    fromVault: string;
    txHash: string;

    // Derived from the SendAsset event
    toChainId: string;
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


    // Metadata
    eventBlockHeight: number;
    eventBlockHash: string;
    observedTimestamp: number;

    swapComplete: boolean;

    underwritten: boolean;
    expired: boolean;
    // observedUnderwriteStatus: UnderwriteStatus;  //TODO implement
    //expiryTimestamp: number;  //TODO implement

}

export interface SwapDescription {
    poolId: string;
    fromChainId: string;
    fromVault: string;
    txHash: string;

    toChainId: string;
}