import { defaultAbiCoder } from '@ethersproject/abi';
import { BigNumber } from 'ethers';
import { keccak256 } from 'ethers/lib/utils';
import { add0X } from '../common/utils';

export const getSwapIdentifier = (
  toAccount: string,
  units: BigNumber,
  fromAmount: BigNumber,
  fee: BigNumber,
  fromAsset: string,
  blockNumber: number,
) => {
  return keccak256(
    defaultAbiCoder.encode(
      ['bytes', 'uint256', 'uint256', 'address', 'uint32'],
      [toAccount, units, fromAmount.sub(fee), fromAsset, blockNumber],
    ),
  );
};

export const getcdataByPayload = (payload: string): string => {
  return add0X(payload.substring(169 + 366, payload.length));
};
