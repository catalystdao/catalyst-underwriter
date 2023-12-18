import { BigNumber } from 'ethers';

export interface SendAssetEvent {
  messageIdentifier: string;
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
