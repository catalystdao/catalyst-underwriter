import { defaultAbiCoder } from '@ethersproject/abi';
import { keccak256 } from 'ethers/lib/utils';
import { add0X } from '../common/utils';
import { SendAssetEvent } from '../listener/interface/sendasset-event.interface';

export const getMessageIdentifier = (
  sendAsset: SendAssetEvent,
  blockNumber: number,
) => {
  return keccak256(
    defaultAbiCoder.encode(
      ['bytes', 'uint256', 'uint256', 'address', 'uint32'],
      [
        sendAsset.toAccount,
        sendAsset.units,
        sendAsset.fromAmount,
        sendAsset.fromAsset,
        blockNumber,
      ],
    ),
  );
};

export const getcdataByPayload = (payload: string): string => {
  return add0X(payload.substring(364, payload.length));
};
