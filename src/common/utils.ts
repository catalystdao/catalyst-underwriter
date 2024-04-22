import { keccak256 } from "ethers";

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const add0X = (address: string): string => `0x${address}`;

export const calcAssetSwapIdentifier = (
    toAccount: string,
    units: bigint,
    swapAmount: bigint, // fromAmount - fee
    fromAsset: string,
    blockNumber: number,
) => {
    const encodedBytes = '0x'
        + toAccount.slice(2)
        + units.toString(16).padStart(64, '0')
        + swapAmount.toString(16).padStart(64, '0')
        + fromAsset.slice(2)
        + (blockNumber % (2 ** 32)).toString(16).padStart(8, '0');

    return keccak256(encodedBytes);
};

export const calcUnderwriteIdentifier = (
    targetVault: string,
    toAsset: string,
    units: bigint,
    minOut: bigint,
    toAccount: string,
    underwriteIncentiveX16: bigint,
    cdata: string
) => {
    const encodedBytes = '0x'
        + targetVault.slice(2)
        + toAsset.slice(2)
        + units.toString(16).padStart(64, '0')
        + minOut.toString(16).padStart(64, '0')
        + toAccount.slice(2)
        + underwriteIncentiveX16.toString(16).padStart(4, '0')
        + cdata.slice(2);

    return keccak256(encodedBytes);
}

export const tryErrorToString = (error: any): string | undefined => {
    if (error == undefined) {
        return undefined;
    }
    if (typeof error == "string") {
        return error;
    }
    try {
        return error.toString();
    } catch {
        return 'Unable to stringify error.';
    }
}