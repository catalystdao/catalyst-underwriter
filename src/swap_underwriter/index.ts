import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';
import { CatalystChainInterface } from '../contracts';
import { SendAssetEvent } from '../listener/interface/sendasset-event.interface';
import { Logger } from '../logger';
import { prioritise } from '../relayer';

const checkUnderwriterGasCost = async (
  contract: CatalystChainInterface,
  sendAsset: SendAssetEvent,
) => {
  const gasCost = await contract.estimateGas.underwriteAndCheckConnection(
    'sourceIdentifier',
    contract.address,
    sendAsset.toVault,
    'toAsset',
    'U',
    sendAsset.minOut,
    sendAsset.toAccount,
    sendAsset.underwriteIncentiveX16,
    'cdata',
  );

  return gasCost;
};

export const underwrite = async (
  chain: Chain,
  address: string,
  sendAsset: SendAssetEvent,
) => {
  const logger = new Logger();
  const evmChain = new EvmChain(chain, true); //Using dedicated RPC
  const contract = evmChain.getCatalystChainContract(address);

  const gas = checkUnderwriterGasCost(contract, sendAsset);

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
