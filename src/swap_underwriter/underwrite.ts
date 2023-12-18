import { defaultAbiCoder } from '@ethersproject/abi';
import { getChainByID } from '../chains/chains';
import { ChainID } from '../chains/enums/chainid.enum';
import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';
import { decodeVaultOrAccount, wait } from '../common/utils';
import { SendAssetEvent } from '../listener/interface/sendasset-event.interface';
import { getAMBByID, prioritise } from '../relayer';
import { AMB } from '../relayer/interfaces/amb.interface';
import { getForkChain } from '../tests/utils/common';
import { MOCK_UNDERWRITE_PRIVATE_KEY } from '../tests/utils/constants';

import pino from 'pino';
import { Swap } from './interfaces/swap,interface';
import { getcdataByPayload } from './utils';

export const underwrite = async (
  swap: Swap,
  sourceChain: Chain,
  loggerOptions: pino.LoggerOptions,
  testMock?: AMB,
): Promise<string | undefined> => {
  const delay = swap.delay;
  await wait(delay);

  const logger = pino(loggerOptions).child({
    worker: 'Underwrite',
    chain: sourceChain.chainId,
  });
  const sendAsset: SendAssetEvent = swap.sendAsset;
  if (sendAsset.underwriteIncentiveX16 === 0) return;

  const messageIdentifier = sendAsset.messageIdentifier;

  try {
    const amb = testMock ?? (await getAMBByID(messageIdentifier)) ?? undefined;

    if (amb) {
      const destChain = getChainByID(amb.destinationChain as ChainID);
      const destEvmChain = testMock
        ? new EvmChain(
            getForkChain(destChain),
            true,
            MOCK_UNDERWRITE_PRIVATE_KEY,
          )
        : new EvmChain(destChain, true); //Using dedicated RPC

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

      const sourceIdentifier = defaultAbiCoder.encode(
        ['uint256'],
        [sourceChain.chainId],
      );
      const targetVault = decodeVaultOrAccount(sendAsset.toVault);
      const toAccount = decodeVaultOrAccount(sendAsset.toAccount);

      const tx = await catalystDestChainContract.underwriteAndCheckConnection(
        sourceIdentifier, //sourceIdentifier
        sourceChain.catalystVault, //fromVault
        targetVault, //targetVault
        toAsset, //toAsset
        sendAsset.units, //U
        sendAsset.minOut, //minOut
        toAccount, //toAccount
        sendAsset.underwriteIncentiveX16, //underwriteIncentiveX16
        cdata,
        { gasLimit: 3000000, from: destEvmChain.signer.address }, //cdata
      );

      if (testMock) {
        await tx.wait();
        return tx.hash;
      }

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
