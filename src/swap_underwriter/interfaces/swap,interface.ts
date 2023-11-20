import { SendAssetEvent } from '../../listener/interface/sendasset-event.interface';

export interface Swap {
  sendAsset: SendAssetEvent;
  delay: number;
}
