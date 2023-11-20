import { workerData } from 'worker_threads';
import { EvmChain } from '../chains/evm-chain';
import { wait } from '../common/utils';
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

export const underwrite = async () => {
  const delay = workerData.delay;
  await wait(delay);

  const logger = new Logger();
  const address = workerData.address;
  const sendAsset: SendAssetEvent = workerData.sendAsset;
  const chain = workerData.chain;
  const evmChain = new EvmChain(workerData.chain, true); //Using dedicated RPC
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

underwrite();
