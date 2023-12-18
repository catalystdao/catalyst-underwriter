import { defaultAbiCoder } from '@ethersproject/abi';
import { BigNumber } from 'ethers';
import { keccak256 } from 'ethers/lib/utils';
import { add0X } from '../common/utils';

export const getMessageIdentifier = (
  toAccount: string,
  units: BigNumber,
  fromAmount: BigNumber,
  fromAsset: string,
  blockNumber: number,
) => {
  return keccak256(
    defaultAbiCoder.encode(
      ['bytes', 'uint256', 'uint256', 'address', 'uint32'],
      [toAccount, units, fromAmount, fromAsset, blockNumber],
    ),
  );
};

export const getcdataByPayload = (payload: string): string => {
  return add0X(payload.substring(364, payload.length));
};
