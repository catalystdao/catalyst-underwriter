import { CHAINS } from '../chains/chains';
import { Chain } from '../chains/interfaces/chain.interface';
import { listenToSendAsset } from '../listener';
import { underwrite } from '../swap_underwriter';
import { Swap } from '../swap_underwriter/interfaces/swap,interface';
import { swap } from './swap';

describe('Testing Underwrite', () => {
  it('should perform an underwrite', async () => {
    const chain: Chain = { ...CHAINS[0], rpc: 'http://localhost:8545' };
    const blockNumber = await swap();
    chain.startingBlock = blockNumber - 1;

    const sendAsset = await listenToSendAsset(1000, chain, true);

    const swapObj: Swap = {
      blockNumber,
      sendAsset,
      delay: 0,
    };
    const tx = await underwrite(swapObj, chain);

    expect(tx).toBeTruthy();
  });
});

describe('Testing Underwrite expected failure', () => {
  it('should NOT perform an underwrite because incentive is too low', async () => {
    const chain: Chain = { ...CHAINS[0], rpc: 'http://localhost:8545' };
    const blockNumber = await swap(0);
    chain.startingBlock = blockNumber - 1;

    const sendAsset = await listenToSendAsset(1000, chain, true);

    const swapObj: Swap = {
      blockNumber,
      sendAsset,
      delay: 0,
    };
    const tx = await underwrite(swapObj, chain);

    expect(tx).toBeFalsy();
  });
});
