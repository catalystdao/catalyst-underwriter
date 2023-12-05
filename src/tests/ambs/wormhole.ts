import { EvmChain } from '../../chains/evm-chain';
import { Chain } from '../../chains/interfaces/chain.interface';
import { getWormholeInfo } from './utils';

export const getWormholeAMB = async (startBlock: number, chain: Chain) => {
  const evmChain = new EvmChain(chain);
  if (!chain.bridges)
    fail(`No wormhole bridge in config for ${chain.name} chain`);

  const contract = evmChain.getIWormholeContract(chain.bridges.wormhole);

  const logs = await contract.queryFilter(
    contract.filters.LogMessagePublished(),
    startBlock,
  );

  for (const event of logs) {
    const payload = event.args.payload;
    const wormholeInfo = getWormholeInfo(payload);
    const amb = {
      messageIdentifier: wormholeInfo.messageIdentifier,
      destinationChain: wormholeInfo.destinationChain.chainId,
      payload,
    };
    return amb;
  }
};
