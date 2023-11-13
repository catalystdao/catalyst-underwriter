import chains from '../chains.config.json';
import { ChainID } from './enums/chainid.enum';
import { Chain } from './interfaces/chain.interface';

/**
 * These chains are being used to look at bounties being placed.
 * The getter service will be running any chain that will be added to this list and will monitor bounties coming in.
 */
export const CHAINS: Chain[] = chains;

export const getChainByID = (chainID: ChainID) => {
  const chain = CHAINS.find((x) => x.chainId === chainID);

  if (!chain) throw new Error(`Missing chain with id: ${chainID}`);

  return chain;
};
