export interface Chain {
  chainId: string;
  name: string;
  rpc: string;
  underwriterRPC: string;
  addresses: string[];
  startingBlock?: number;
}
