import fetch from 'node-fetch';
import { join } from 'path';
import { AssetSwapMetaData } from './interfaces/asset-swap-metadata.interface';
require('dotenv').config();

const baseEndpoint = process.env.RELAYER_ENDPOINT!;

export const getMetadataBySwap = async (
  id: string,
  fromVault: string,
  chainId: string,
): Promise<AssetSwapMetaData | undefined> => {
  try {
    const res = await fetch(join(baseEndpoint, 'metadata'), {
      method: 'POST',
      body: JSON.stringify({
        id,
        fromVault,
        chainId,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    return undefined;
  } catch (error) {
    console.error(`Failed to get amb ${id} from the relayer`);
  }
};

export const prioritiseSwap = async (
  id: string,
  fromVault: string,
  chainId: string,
) => {
  try {
    await fetch(join(baseEndpoint, 'metadata'), {
      method: 'POST',
      body: JSON.stringify({
        id,
        fromVault,
        chainId,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error(`Failed to prioritise bounty ${id}`);
  }
};
