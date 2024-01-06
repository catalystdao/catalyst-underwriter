export interface Chain {
  chainId: string;
  name: string;
  rpc: string;
  underwriterRPC: string;
  catalystVault: string;
  mock: string;
  forkPort: string;
  startingBlock?: number;
}
