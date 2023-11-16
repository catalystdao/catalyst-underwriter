import { SendAssetEvent } from 'src/listener/interface/sendasset-event.interface';

const MIN_EARN = 0;
const LARGE_SWAP = 0;
const GAS_COST = 0;

export const evaulate = (sendAsset: SendAssetEvent): number | undefined => {
  const underwritingIncentivePercentage = sendAsset.underwriteIncentiveX16;
  const estimatedSizeInFiat = 0;

  //Additional 24 seconds delay for large swaps
  const secondsToAdd = estimatedSizeInFiat > LARGE_SWAP ? 24 : 0;

  if (
    estimatedSizeInFiat * underwritingIncentivePercentage <
    GAS_COST * (1 + MIN_EARN)
  ) {
    //Meaning not to underwrite
    return undefined;
  }

  if (underwritingIncentivePercentage < 0.5) return 60 + secondsToAdd;

  if (underwritingIncentivePercentage < 1) return 36 + secondsToAdd;

  if (underwritingIncentivePercentage < 2) return 12 + secondsToAdd;
};
