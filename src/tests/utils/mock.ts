import { EvmChain } from '../../chains/evm-chain';
import { Chain } from '../../chains/interfaces/chain.interface';
import { add0X } from '../../common/utils';

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
    const destinationChain = BigInt(
      event.args.destinationIdentifier,
    ).toString();
    const messageIdentifier = add0X(payload.substring(132, 198));
    const amb = {
      messageIdentifier,
      destinationChain,
      payload,
    };
    return amb;
  }
};
