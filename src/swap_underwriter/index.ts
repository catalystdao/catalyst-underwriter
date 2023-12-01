import { workerData } from 'worker_threads';
import { getChainByID } from '../chains/chains';
import { ChainID } from '../chains/enums/chainid.enum';
import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';
import { wait } from '../common/utils';
import { SendAssetEvent } from '../listener/interface/sendasset-event.interface';
import { Logger } from '../logger';
import { getAMBByID, prioritise } from '../relayer';
import { Swap } from './interfaces/swap,interface';
import { getMessageIdentifier, getcdataByPayload } from './utils';

const bootstrap = () => {
  const swap: Swap = workerData.swap;
  const sourceChain: Chain = workerData.chain;
  underwrite(swap, sourceChain);
};

export const underwrite = async (
  swap: Swap,
  sourceChain: Chain,
): Promise<string | undefined> => {
  const delay = swap.delay;
  await wait(delay);

  const logger = new Logger();
  const sendAsset: SendAssetEvent = swap.sendAsset;
  if (sendAsset.underwriteIncentiveX16 < 0) return;

  const messageIdentifier = getMessageIdentifier(sendAsset, swap.blockNumber);

  try {
    const amb = await getAMBByID(messageIdentifier);

    if (amb) {
      const destChain = getChainByID(amb.destinationChain as ChainID);
      const destEvmChain = new EvmChain(destChain, true); //Using dedicated RPC

      const destVaultContract = destEvmChain.getCatalystVaultContract(
        destChain.catalystVault,
      );
      const toAsset = await destVaultContract._tokenIndexing(
        sendAsset.toAssetIndex,
      );
      const destChainInterface = await destVaultContract._chainInterface();
      const catalystDestChainContract =
        destEvmChain.getCatalystChainContract(destChainInterface);

      const cdata = getcdataByPayload(amb.payload);

      const tx = await catalystDestChainContract.underwriteAndCheckConnection(
        sourceChain.chainId, //sourceIdentifier
        sourceChain.catalystVault, //fromVault
        sendAsset.toVault, //targetVault
        toAsset, //toAsset
        sendAsset.units, //U
        sendAsset.minOut, //minOut
        sendAsset.toAccount, //toAccount
        sendAsset.underwriteIncentiveX16, //underwriteIncentiveX16
        cdata, //cdata
      );

      prioritise(messageIdentifier);

      logger.info(
        `Successfully called underwrite with txHash ${tx.hash} from ${sourceChain.name} chain to ${destChain.name} chain`,
      );

      return tx.hash;
    }
  } catch (error) {
    logger.error(`Failed to underwrite swap ${messageIdentifier}`, error);
  }
};

bootstrap();
