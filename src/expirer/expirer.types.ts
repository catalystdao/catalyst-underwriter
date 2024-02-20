import { TransactionReceipt, TransactionResponse } from "ethers";

export interface ExpireEvalOrder {
    poolId: string;
    toChainId: string;
    toInterface: string;
    underwriteId: string;
    expireAt: number;
}

export interface ExpireOrder extends ExpireEvalOrder {
    fromChainId: string;
    fromVault: string;

    // SendAsset event fields
    channelId: string;
    toVault: string;
    toAccount: string;
    fromAsset: string;
    fromAmount: bigint;
    minOut: bigint;
    units: bigint;
    fee: bigint;
    underwriteIncentiveX16: bigint;

    toAsset: string;
    calldata: string;
}

export interface ExpireOrderResult extends ExpireOrder {
    tx: TransactionResponse;
    txReceipt: TransactionReceipt;
}