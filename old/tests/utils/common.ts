import { Chain } from '../../chains/interfaces/chain.interface';

export const getForkChain = (chain: Chain) => ({
  ...chain,
  rpc: `http://localhost:${chain.forkPort}`,
});
