export interface Chain {
  chainId: string;
  name: string;
  rpc: string;
  underwriterRPC: string;
  catalystVault: string;
  startingBlock?: number;
  mock: string;
}
