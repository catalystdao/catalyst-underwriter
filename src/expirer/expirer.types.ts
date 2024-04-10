import { TransactionReceipt, TransactionResponse } from "ethers";

export interface ExpireEvalOrder {
    toChainId: string;
    toInterface: string;
    underwriteId: string;
    expireAt: number;
}

export interface ExpireOrder extends ExpireEvalOrder {
    channelId: string;
    toVault: string;
    toAccount: string;
    toAsset: string;
    minOut: bigint;
    units: bigint;
    underwriteIncentiveX16: bigint;
    calldata: string;
}

export interface ExpireOrderResult extends ExpireOrder {
    tx: TransactionResponse;
    txReceipt: TransactionReceipt;
}