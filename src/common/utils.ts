import { AbiCoder, keccak256 } from "ethers";

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const add0X = (address: string): string => `0x${address}`;

export const calcAssetSwapIdentifier = (
    toAccount: string,
    units: bigint,
    swapAmount: bigint, // fromAmount - fee
    fromAsset: string,
    blockNumber: number,
) => {
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ['bytes', 'uint256', 'uint256', 'address', 'uint32'],
            [toAccount, units, swapAmount, fromAsset, blockNumber % (2**32)],
        ),
    );
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
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint256', 'uint256', 'address', 'uint16', 'bytes'],
            [targetVault, toAsset, units, minOut, toAccount, underwriteIncentiveX16, cdata],
        ),
    )
}