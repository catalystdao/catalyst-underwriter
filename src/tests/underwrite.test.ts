import { BigNumber } from 'ethers';
import { CHAINS } from '../chains/chains';
import { Chain } from '../chains/interfaces/chain.interface';
import { listenToSendAsset } from '../listener/listenSendAsset';

import { Swap } from '../swap_underwriter/interfaces/swap,interface';
import { underwrite } from '../swap_underwriter/underwrite';
import { getWormholeAMB } from './ambs/wormhole';
import { swap } from './swap';

describe('Testing Underwrite', () => {
  it('should perform an underwrite', async () => {
    const chain: Chain = { ...CHAINS[0], rpc: 'http://localhost:8545' };
    const blockNumber = await swap(chain);
    const startingBlock = blockNumber - 1;
    chain.startingBlock = startingBlock;

    const sendAsset = await listenToSendAsset(0, chain, true);
    if (!sendAsset) fail('Failed to get sendAsset Event');

    const swapObj: Swap = {
      blockNumber,
      sendAsset,
      delay: 0,
    };

    const amb = await getWormholeAMB(startingBlock, chain);
    if (!amb) fail('Failed to get amb');

    const tx = await underwrite(swapObj, chain, amb);

    expect(tx).toBeTruthy();
  });
});

describe('Testing Underwrite expected failure', () => {
  it('should NOT perform an underwrite because incentive is too low', async () => {
    const chain: Chain = { ...CHAINS[0], rpc: 'http://localhost:8545' };
    const blockNumber = await swap(chain, BigNumber.from(0));
    chain.startingBlock = blockNumber - 1;

    const sendAsset = await listenToSendAsset(0, chain, true);
    if (!sendAsset) fail('Failed to get sendAsset Event');

    const swapObj: Swap = {
      blockNumber,
      sendAsset,
      delay: 0,
    };
    const tx = await underwrite(swapObj, chain);

    expect(tx).toBeFalsy();
  });
});
