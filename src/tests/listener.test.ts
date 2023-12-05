import { CHAINS } from '../chains/chains';
import { Chain } from '../chains/interfaces/chain.interface';
import { listenToSendAsset } from '../listener/listenSendAsset';
import { swap } from './swap';

describe('Testing Listener can find a swap', () => {
  it('should find a swap and ', async () => {
    const chain: Chain = { ...CHAINS[0], rpc: 'http://localhost:8545' };
    const blockNumber = await swap();
    chain.startingBlock = blockNumber - 1;

    const sendAsset = await listenToSendAsset(0, chain, true);

    //Expect to find the swap
    expect(sendAsset).toBeTruthy();
  });
});
