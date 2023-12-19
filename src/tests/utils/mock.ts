import { EvmChain } from '../../chains/evm-chain';
import { Chain } from '../../chains/interfaces/chain.interface';
import { getcdataByPayload } from '../../swap_underwriter/utils';

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
    const cdata = getcdataByPayload(payload);

    const assetSwapMetaData = {
      destinationChain,
      cdata,
    };
    return assetSwapMetaData;
  }
};
