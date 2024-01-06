import { BigNumber } from 'ethers';

export interface SendAssetEvent { //TODO why not load this from loaded abis/contracts?
  fromVault: string;
  chainId: string;
  swapIdentifier: string;
  channelId: string;
  toVault: string;
  toAccount: string;
  fromAsset: string;
  toAssetIndex: number;
  fromAmount: BigNumber;
  minOut: BigNumber;
  units: BigNumber;
  fee: BigNumber;
  underwriteIncentiveX16: number;
}
