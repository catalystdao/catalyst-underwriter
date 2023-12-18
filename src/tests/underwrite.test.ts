import { getChainByID } from '../chains/chains';
import { Chain } from '../chains/interfaces/chain.interface';

import { ChainID } from '../chains/enums/chainid.enum';
import { EvmChain } from '../chains/evm-chain';
import { trackSendAsset } from '../listener/listenSwapEvents';
import { Swap } from '../swap_underwriter/interfaces/swap,interface';
import { underwrite } from '../swap_underwriter/underwrite';
import { getForkChain } from './utils/common';
import { getMockMessage } from './utils/mock';
import { swap } from './utils/swap';

describe('Testing Underwrite', () => {
  it('should perform an underwrite', async () => {
    const fromChain: Chain = getForkChain(getChainByID(ChainID.Mumbai));
    const toChain: Chain = getForkChain(getChainByID(ChainID.Sepolia));

    const blockNumber = await swap(fromChain, toChain, 1);
    const startingBlock = blockNumber - 1;

    fromChain.startingBlock = startingBlock;

    const evmChain = new EvmChain(fromChain);
    const vaultContract = evmChain.getCatalystVaultContract(
      fromChain.catalystVault,
    );

    const sendAsset = await trackSendAsset(
      vaultContract,
      startingBlock,
      undefined,
      undefined,
      true,
    );
    if (!sendAsset) fail('Failed to get sendAsset Event');

    const swapObj: Swap = {
      blockNumber,
      sendAsset,
      delay: 0,
    };

    const mock = await getMockMessage(startingBlock, fromChain);
    if (!mock) fail('Failed to get mock');

    const tx = await underwrite(swapObj, toChain, { base: undefined }, mock);

    expect(tx).toBeTruthy();
  }, 20000);
});

describe('Testing Underwrite expected failure', () => {
  it('should NOT perform an underwrite because incentive is too low', async () => {
    const fromChain: Chain = getForkChain(getChainByID(ChainID.Mumbai));
    const toChain: Chain = getForkChain(getChainByID(ChainID.Sepolia));

    const blockNumber = await swap(fromChain, toChain, 0);
    const startingBlock = blockNumber - 1;
    fromChain.startingBlock = startingBlock;

    const evmChain = new EvmChain(fromChain);
    const vaultContract = evmChain.getCatalystVaultContract(
      fromChain.catalystVault,
    );
    const sendAsset = await trackSendAsset(
      vaultContract,
      startingBlock,
      undefined,
      undefined,
      true,
    );
    if (!sendAsset) fail('Failed to get sendAsset Event');

    const swapObj: Swap = {
      blockNumber,
      sendAsset,
      delay: 0,
    };

    const mock = await getMockMessage(startingBlock, fromChain);
    if (!mock) fail('Failed to get amb');

    const tx = await underwrite(swapObj, fromChain, { base: undefined }, mock);

    expect(tx).toBeFalsy();
  }, 20000);
});
