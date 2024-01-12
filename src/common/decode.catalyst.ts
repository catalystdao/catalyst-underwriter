// NOTE: The following file has been adapted from the generalised-incentives-explorer repo (2024/01/11)
/* 
    Catalyst IBC payload structure 
    Note: Addresses have 65 bytes reserved, however, the first byte should only be used for the address size.

    Common Payload (beginning)
    CONTEXT               0   (1 byte)
    + FROM_VAULT_LENGTH   1   (1 byte)
    + FROM_VAULT          2   (64 bytes)
    + TO_VAULT_LENGTH     66  (1 byte)
    + TO_VAULT            67  (64 bytes)
    + TO_ACCOUNT_LENGTH   131 (1 byte)
    + TO_ACCOUNT          132 (64 bytes)
    + UNITS               196 (32 bytes)

    Context-depending Payload
    CTX0 - 0x00 - Asset Swap Payload
        + TO_ASSET_INDEX   228 (1 byte)
        + MIN_OUT          229 (32 bytes)
        + FROM_AMOUNT      261 (32 bytes)
        + FROM_ASSET_LEN   293 (1 byte)
        + FROM_ASSET       294 (64 bytes)
        + BLOCK_NUMBER     358 (4 bytes)
        (Underwrite Logic)
        + UW_INCENTIVE     362 (2 bytes)

    CTX1 - 0x01 - Liquidity Swap Payload
        + MIN_OUT          228 (32 bytes)
        + MIN_REFERENCE    260 (32 bytes)
        + FROM_AMOUNT      292 (32 bytes)
        + BLOCK_NUMBER     324 (4 bytes)

    Common Payload (end)
    + DATA_LENGTH         LENGTH-N-2 (2 bytes)
    + DATA                LENGTH-N   (N bytes)
 */

import { decodeBytes65Address } from "./decode.payload";


export enum CatalystContext {
    ASSET_SWAP,
    LIQUIDITY_SWAP,
}

type COMMON_CATALYST = {
    context: CatalystContext;
    rawFromVault: string;
    fromVault: string;
    rawToVault: string;
    toVault: string;
    rawToAccount: string;
    toAccount: string;
    units: bigint;
    cdata: string;
}

export type ASSET_SWAP = COMMON_CATALYST & {
    context: CatalystContext.ASSET_SWAP;
    toAssetIndex: number;
    minOut: bigint;
    fromAmount: bigint;
    rawFromAsset: string;
    fromAsset: string;
    blockNumber: number;
    underwritingIncentive: number;
}
export type LIQUIDITY_SWAP = COMMON_CATALYST & {
    context: CatalystContext.LIQUIDITY_SWAP;
    minOut: bigint;
    minReference: bigint;
    fromAmount: bigint;
    blockNumber: number;
}

export type CatalystMessage = ASSET_SWAP | LIQUIDITY_SWAP;

export function catalystParse(catalystPayload: string): CatalystMessage {
    let counter = catalystPayload.includes("0x") ? 2 : 0;
    const context: CatalystContext = parseInt(catalystPayload.slice(counter, counter += 2), 16);
    const rawFromVault = "0x" + catalystPayload.slice(counter, counter += (32 * 2 * 2 + 2));
    const rawToVault = "0x" + catalystPayload.slice(counter, counter += (32 * 2 * 2 + 2));
    const rawToAccount = "0x" + catalystPayload.slice(counter, counter += (32 * 2 * 2 + 2));
    const units = BigInt("0x" + catalystPayload.slice(counter, counter += (32 * 2)));
    const common_message = {
        rawFromVault,
        fromVault: decodeBytes65Address(rawFromVault),
        rawToVault,
        toVault: decodeBytes65Address(rawToVault),
        rawToAccount,
        toAccount: decodeBytes65Address(rawToAccount),
        units,
    };
    if (context === CatalystContext.ASSET_SWAP) {
        const toAssetIndex = parseInt(catalystPayload.slice(counter, counter += (1 * 2)), 16);
        const minOut = BigInt("0x" + catalystPayload.slice(counter, counter += (32 * 2)));
        const fromAmount = BigInt("0x" + catalystPayload.slice(counter, counter += (32 * 2)));
        const rawFromAsset = "0x" + catalystPayload.slice(counter, counter += (32 * 2 * 2 + 2));
        const blockNumber = parseInt(catalystPayload.slice(counter, counter += (4 * 2)), 16);
        const underwritingIncentive = parseInt(catalystPayload.slice(counter, counter += (2 * 2)), 16);
        const cdata = "0x" + catalystPayload.slice(counter);
        return {
            ...common_message,
            context: context,
            toAssetIndex,
            minOut,
            fromAmount,
            rawFromAsset,
            fromAsset: decodeBytes65Address(rawFromAsset),
            blockNumber,
            underwritingIncentive,
            cdata,
        }
    } else if (context === CatalystContext.LIQUIDITY_SWAP) {
        const minOut = BigInt("0x" + catalystPayload.slice(counter, counter += (32 * 2)));
        const minReference = BigInt("0x" + catalystPayload.slice(counter, counter += (32 * 2)));
        const fromAmount = BigInt("0x" + catalystPayload.slice(counter, counter += (32 * 2)));
        const blockNumber = parseInt(catalystPayload.slice(counter, counter += (4 * 2)), 16);
        const cdata = "0x" + catalystPayload.slice(counter);
        return {
            ...common_message,
            context: context,
            minOut,
            minReference,
            fromAmount,
            blockNumber,
            cdata,
        }
    } else {
        throw Error(`Context not found? Could be incorrectly decoded message. Context: ${context}`)
    }
}

export type UnderwriteInformation = {
    targetVault: string,
    toAssetIndex: number,
    U: bigint,
    minOut: bigint,
    toAccount: string,
    underwriteIncentiveX16: number,
    cdata: string,
};

export function UnderwriteIdentifier(message: CatalystMessage): UnderwriteInformation | undefined {
    /* 
    function underwrite(
        address targetVault,  // -- Swap information
        address toAsset,
        uint256 U,
        uint256 minOut,
        address toAccount,
        uint16 underwriteIncentiveX16,
        bytes calldata cdata
    )
     */
    if (message.context === CatalystContext.LIQUIDITY_SWAP) return;
    return {
        targetVault: message.toVault,
        toAssetIndex: message.toAssetIndex,
        U: message.units,
        minOut: message.minOut,
        toAccount: message.toAccount,
        underwriteIncentiveX16: message.underwritingIncentive,
        cdata: message.cdata
    };
}