import { getChainByID } from '../chains/chains';
import { ChainID } from '../chains/enums/chainid.enum';
import { Chain } from '../chains/interfaces/chain.interface';
import { listenToSendAsset } from '../listener/listenSwapEvents';
import { getForkChain } from './utils/common';
import { swap } from './utils/swap';

describe('Testing Listener can find a swap', () => {
  it('should find a swap and ', async () => {
    const fromChain: Chain = getForkChain(getChainByID(ChainID.Mumbai));
    const toChain: Chain = getForkChain(getChainByID(ChainID.Sepolia));

    const blockNumber = await swap(fromChain, toChain);
    fromChain.startingBlock = blockNumber - 1;

    const sendAsset = await listenToSendAsset(0, fromChain, true);

    //Expect to find the swap
    expect(sendAsset).toBeTruthy();
  }, 20000);
});
