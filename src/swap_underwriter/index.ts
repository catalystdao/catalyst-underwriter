import { workerData } from 'worker_threads';
import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';
import { wait } from '../common/utils';
import { SendAssetEvent } from '../listener/interface/sendasset-event.interface';
import { Logger } from '../logger';
import { getAMBByID, prioritise } from '../relayer';
import { Swap } from './interfaces/swap,interface';
import { getMessageIdentifier } from './utils';

export const underwrite = async () => {
  const swap: Swap = workerData.swap;
  const delay = swap.delay;
  await wait(delay);

  const logger = new Logger();
  const sendAsset: SendAssetEvent = swap.sendAsset;
  const address: string = workerData.address;
  const chain: Chain = workerData.chain;
  const evmChain = new EvmChain(chain, true); //Using dedicated RPC
  const catalystChainContract = evmChain.getCatalystChainContract(address);
  const catalystVaultContract = evmChain.getCatalystVaultContract(address);

  const messageIdentifier = getMessageIdentifier(sendAsset, swap.blockNumber);

  try {
    const toAsset = await catalystVaultContract._tokenIndexing(
      sendAsset.toAssetIndex,
    );
    const callData = await getAMBByID(messageIdentifier);

    const tx = await catalystChainContract.underwriteAndCheckConnection(
      chain.chainId, //sourceIdentifier
      address, //fromVault
      sendAsset.toVault, //targetVault
      toAsset, //toAsset
      sendAsset.units, //U
      sendAsset.minOut, //minOut
      sendAsset.toAccount, //toAccount
      sendAsset.underwriteIncentiveX16, //underwriteIncentiveX16
      callData, //cdata
    );

    prioritise(messageIdentifier);

    logger.info(
      `Successfully called underwrite with txHash ${tx.hash} on ${chain.name} chain`,
    );
  } catch (error) {
    logger.error(
      `Failed to underwrite swap ${messageIdentifier} on ${chain.name} chain`,
      error,
    );
  }
};

underwrite();
