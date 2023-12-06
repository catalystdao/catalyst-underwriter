import { Chain } from '../../chains/interfaces/chain.interface';

export const getForkChain = (chain: Chain) => ({
  ...chain,
  rpc: `http://localhost:${process.env.FORK_PORT}`,
});
