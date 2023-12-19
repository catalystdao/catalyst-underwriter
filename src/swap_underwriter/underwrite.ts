import { defaultAbiCoder } from '@ethersproject/abi';
import { getChainByID } from '../chains/chains';
import { ChainID } from '../chains/enums/chainid.enum';
import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';
import { decodeVaultOrAccount, wait } from '../common/utils';
import { SendAssetEvent } from '../listener/interface/sendasset-event.interface';

import { getForkChain } from '../tests/utils/common';
import { MOCK_UNDERWRITE_PRIVATE_KEY } from '../tests/utils/constants';

import pino from 'pino';
import { getMetadataBySwap, prioritiseSwap } from '../relayer';
import { AssetSwapMetaData } from '../relayer/interfaces/asset-swap-metadata.interface';
import { Swap } from './interfaces/swap,interface';

export const underwrite = async (
  swap: Swap,
  sourceChain: Chain,
  loggerOptions: pino.LoggerOptions,
  testMock?: AssetSwapMetaData,
): Promise<string | undefined> => {
  const delay = swap.delay;
  await wait(delay);

  const logger = pino(loggerOptions).child({
    worker: 'Underwrite',
    chain: sourceChain.chainId,
  });
  const sendAsset: SendAssetEvent = swap.sendAsset;
  if (sendAsset.underwriteIncentiveX16 === 0) return;

  const swapIdentifier = sendAsset.swapIdentifier;

  try {
    const metaData =
      testMock ??
      (await getMetadataBySwap(
        swapIdentifier,
        sendAsset.fromVault,
        sendAsset.chainId,
      )) ??
      undefined;

    if (metaData) {
      const destChain = getChainByID(metaData.destinationChain as ChainID);
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
        metaData.cdata,
        { gasLimit: 3000000, from: destEvmChain.signer.address }, //cdata
      );

      if (testMock) {
        await tx.wait();
        return tx.hash;
      }

      prioritiseSwap(swapIdentifier, sendAsset.fromVault, sendAsset.chainId);

      logger.info(
        `Successfully called underwrite with txHash ${tx.hash} from ${sourceChain.name} chain to ${destChain.name} chain`,
      );

      return tx.hash;
    }
  } catch (error) {
    logger.error(`Failed to underwrite swap ${swapIdentifier}`, error);
  }
};
