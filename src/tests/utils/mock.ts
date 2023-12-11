import { EvmChain } from '../../chains/evm-chain';
import { Chain } from '../../chains/interfaces/chain.interface';

export const getMockMessage = async (startBlock: number, chain: Chain) => {
  const evmChain = new EvmChain(chain);
  const contract = evmChain.getMockContract(chain.mock);
  const endBlock = await evmChain.getCurrentBlock();

  const logs = await contract.queryFilter(
    contract.filters.Message(),
    startBlock,
    endBlock,
  );

  for (const event of logs) {
    const payload = event.args.message;
    const destinationChain = event.args.destinationIdentifier;
    const messageIdentifier = '';
    const amb = {
      messageIdentifier,
      destinationChain,
      payload,
    };
    return amb;
  }
};
