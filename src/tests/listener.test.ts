import { getChainByID } from '../chains/chains';
import { ChainID } from '../chains/enums/chainid.enum';
import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';
import { trackSendAsset } from '../listener/listenSwapEvents';
import { getForkChain } from './utils/common';
import { swap } from './utils/swap';

describe('Testing Listener can find a swap', () => {
  it('should find a swap and ', async () => {
    const fromChain: Chain = getForkChain(getChainByID(ChainID.Mumbai));
    const toChain: Chain = getForkChain(getChainByID(ChainID.Sepolia));

    const blockNumber = await swap(fromChain, toChain);
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

    //Expect to find the swap
    expect(sendAsset).toBeTruthy();
  }, 20000);
});
