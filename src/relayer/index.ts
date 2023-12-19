import { join } from 'path';
import { AssetSwapMetaData } from './interfaces/asset-swap-metadata.interface';
require('dotenv').config();

const baseEndpoint = process.env.RELAYER_ENDPOINT!;

export const getMetadataBySwap = async (
  swapIdentifier: string,
  fromVault: string,
  chainId: string,
): Promise<AssetSwapMetaData | undefined> => {
  try {
    const res = await fetch(join(baseEndpoint, 'metadata'), {
      method: 'GET',
      body: JSON.stringify({
        swapIdentifier,
        fromVault,
        chainId,
      }),
    });
    const data = (await res.json()) as AssetSwapMetaData;

    return data;
  } catch (error) {
    console.error(
      `Failed to get amb metadata for swap ${swapIdentifier} from the relayer`,
    );
  }
};

export const prioritiseSwap = async (
  swapIdentifier: string,
  fromVault: string,
  chainId: string,
) => {
  try {
    await fetch(join(baseEndpoint, 'prioritise'), {
      method: 'POST',
      body: JSON.stringify({
        swapIdentifier,
        fromVault,
        chainId,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error(`Failed to prioritise bounty for swap ${swapIdentifier}`);
  }
};
