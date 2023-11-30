import { CHAINS } from '../chains/chains';
import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';

export const swapTest = describe('Testing swap', () => {
  it('should perform a swap', async () => {
    const fromChain: Chain = { ...CHAINS[0], rpc: 'http://localhost:8545' };
    const fromEvmChain = new EvmChain(
      fromChain,
      false,
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
    const account = fromEvmChain.signer.address;

    const toChain: Chain = { ...CHAINS[1], rpc: 'http://localhost:8545' };

    const vault = fromEvmChain.getCatalystVaultContract(
      fromChain.catalystVault,
      true,
    );

    const chainIdentifier = fromChain.chainId;
    const toVault = toChain.catalystVault;
    const incentive = {
      maxGasDelivery: 2000000,
      maxGasAck: 2000000,
      refundGasTo: account,
      priceOfDeliveryGas: 5,
      priceOfAckGas: 5,
      targetDelta: 0,
    };

    const fromasset = await vault._tokenIndexing(0);
    const toassetindex = 0;
    const amount = 1;
    const minOut = 0;
    const underwriteIncentiveX16 = 1;
    const cdata = '';

    const tx = await vault.sendAsset(
      {
        chainIdentifier,
        toVault,
        toAccount: account,
        incentive,
      },
      fromasset,
      toassetindex,
      amount,
      minOut,
      account,
      underwriteIncentiveX16,
      cdata,
    );

    await tx.wait();

    // Verify that the transaction was successful
    expect(tx.confirmations).toBeGreaterThan(1);
  });
});
