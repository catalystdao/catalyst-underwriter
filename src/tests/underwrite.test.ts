import { BigNumber } from 'ethers';
import { getChainByID } from '../chains/chains';
import { Chain } from '../chains/interfaces/chain.interface';
import { listenToSendAsset } from '../listener/listenSendAsset';

import { ChainID } from '../chains/enums/chainid.enum';
import { Swap } from '../swap_underwriter/interfaces/swap,interface';
import { underwrite } from '../swap_underwriter/underwrite';
import { getWormholeAMB } from './ambs/wormhole';
import { getForkChain } from './utils/common';
import { swap } from './utils/swap';

describe('Testing Underwrite', () => {
  it('should perform an underwrite', async () => {
    const fromChain: Chain = getForkChain(getChainByID(ChainID.Sepolia));
    const toChain: Chain = getForkChain(getChainByID(ChainID.Mumbai));

    const blockNumber = await swap(fromChain, toChain);
    const startingBlock = blockNumber - 1;

    fromChain.startingBlock = startingBlock;

    const sendAsset = await listenToSendAsset(0, fromChain, true);
    if (!sendAsset) fail('Failed to get sendAsset Event');

    const swapObj: Swap = {
      blockNumber,
      sendAsset,
      delay: 0,
    };

    const amb = await getWormholeAMB(startingBlock, toChain);
    if (!amb) fail('Failed to get amb');

    const tx = await underwrite(swapObj, toChain, amb);

    expect(tx).toBeTruthy();
  });
});

describe('Testing Underwrite expected failure', () => {
  it('should NOT perform an underwrite because incentive is too low', async () => {
    const fromChain: Chain = getForkChain(getChainByID(ChainID.Sepolia));
    const toChain: Chain = getForkChain(getChainByID(ChainID.Mumbai));

    const blockNumber = await swap(fromChain, toChain, BigNumber.from(0));
    const startingBlock = blockNumber - 1;
    fromChain.startingBlock = startingBlock;

    const sendAsset = await listenToSendAsset(0, fromChain, true);
    if (!sendAsset) fail('Failed to get sendAsset Event');

    const swapObj: Swap = {
      blockNumber,
      sendAsset,
      delay: 0,
    };

    const amb = await getWormholeAMB(startingBlock, fromChain);
    if (!amb) fail('Failed to get amb');

    const tx = await underwrite(swapObj, fromChain);

    expect(tx).toBeFalsy();
  });
});
