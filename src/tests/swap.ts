import { BigNumber, ethers } from 'ethers';
import { defaultAbiCoder, parseEther, parseUnits } from 'ethers/lib/utils';
import { CHAINS } from '../chains/chains';
import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';

export const swap = async (
  underwriteIncentiveX16: BigNumber = BigNumber.from(1),
): Promise<number> => {
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

  const chainIdentifier = defaultAbiCoder.encode(
    ['uint256'],
    [fromChain.chainId],
  );

  const zero = BigNumber.from(0);
  const toVault = toChain.catalystVault;
  const incentive = {
    maxGasDelivery: 2000000,
    maxGasAck: 2000000,
    refundGasTo: account,
    priceOfDeliveryGas: parseUnits('5', 'gwei'),
    priceOfAckGas: parseUnits('5', 'gwei'),
    targetDelta: zero,
  };

  const amount = parseEther('1');
  const fromasset = await vault._tokenIndexing('0x0');
  const tokenContract = fromEvmChain.getTokenContract(fromasset);
  const approveTx = await tokenContract.approve(account, amount);
  await approveTx.wait();

  const toassetindex = zero;
  const minOut = zero;
  const cdata = ethers.constants.HashZero;

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
    { gasLimit: 3000000 },
  );

  await tx.wait();

  return tx.blockNumber!;
};
