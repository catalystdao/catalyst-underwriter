import { EvmChain } from 'src/chains/evm-chain';
import { Chain } from 'src/chains/interfaces/chain.interface';
import { CatalystChainInterface } from 'src/contracts';
import { SendAssetEvent } from 'src/listener/interface/sendasset-event.interface';
import { Logger } from 'src/logger';
import { prioritise } from 'src/relayer';

const checkUnderwriterAllawence = async (contract: CatalystChainInterface) => {
  //TODO
  //contract.estimateGas.underwriteAndCheckConnection()
};

export const underwrite = async (
  chain: Chain,
  address: string,
  sendAsset: SendAssetEvent,
) => {
  const logger = new Logger();
  const evmChain = new EvmChain(chain, true); //Using dedicated RPC
  const contract = evmChain.getCatalystChainContract(address);

  const allowence = checkUnderwriterAllawence(contract);

  try {
    //TODO
    const tx = await contract.underwriteAndCheckConnection(
      'sourceIdentifier',
      address,
      sendAsset.toVault,
      'toAsset',
      'U',
      sendAsset.minOut,
      sendAsset.toAccount,
      sendAsset.underwriteIncentiveX16,
      'cdata',
    );

    prioritise(sendAsset.channelId);

    logger.info(
      `Successfully called underwrite with txHash ${tx.hash} on ${chain.name} chain`,
    );
  } catch (error) {
    logger.error(
      `Failed to underwrite swap ${sendAsset.channelId} on ${chain.name} chain`,
      error,
    );
  }
};
