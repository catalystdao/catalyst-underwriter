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
    fromChainId: string;
    toChainId: string;
    fromVault: string;
    swapId: string;
}

export interface SwapState {

    // Trusted fields (these define the entry)
    fromChainId: string;
    fromVault: string;
    swapId: string;

    // Derived from event-specific details
    status: SwapStatus;

    // Event-specific details
    ambMessageSendAssetDetails?: AMBMessageSendAssetDetails;
    sendAssetCompletionDetails?: ReceiveAssetEventDetails | FulfillUnderwriteEventDetails;
}

// ! The following must be populated using AMB message data, **NOT** using SendAsset events, as
// ! these could be malicious.
export interface AMBMessageSendAssetDetails extends TransactionDescription {
    // Relayer AMB message data
    amb: string;
    toChainId: string;
    fromChannelId: string;

    // Decoded GeneralisedIncentives data
    toIncentivesAddress: string;
    toApplication: string;
    messageIdentifier: string;
    deadline: bigint;
    maxGasDelivery: bigint;

    // Decoded swap data (from AMB message)
    fromVault: string; // ! It must be verified that this field matches the 'fromVault' of the 'SwapState'.
    toVault: string;
    toAccount: string;
    units: bigint;
    toAssetIndex: bigint;
    minOut: bigint;
    swapAmount: bigint;
    fromAsset: string;
    blockNumberMod: bigint;
    underwriteIncentiveX16: bigint;
    calldata: string;

    // Additional data
    blockTimestamp: number;
    observedAtBlockNumber: number;
}

export interface ReceiveAssetEventDetails extends TransactionDescription {
}

export interface SwapUnderwrittenEvent extends TransactionDescription {
}



export enum UnderwriteStatus {
    Underwritten,
    Fulfilled,
    Expired
}

export interface ExpectedUnderwriteDescription {
    toChainId: string;
    toInterface: string;
    underwriteId: string;
}

export interface ActiveUnderwriteDescription {
    toChainId: string;
    toInterface: string;
    underwriter: string;
    underwriteId: string;
    expiry: number;
}

export interface CompletedUnderwriteDescription {
    toChainId: string;
    toInterface: string;
    underwriteId: string;
    underwriter: string;
    underwriteTxHash: string;
}

export interface UnderwriteState {

    // Trusted fields (provided by the listener)
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