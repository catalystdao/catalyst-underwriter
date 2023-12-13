import { constants, ethers } from 'ethers';
import {
  defaultAbiCoder,
  hexZeroPad,
  parseEther,
  parseUnits,
  solidityPack,
} from 'ethers/lib/utils';
import { EvmChain } from '../../chains/evm-chain';
import { Chain } from '../../chains/interfaces/chain.interface';
import { MOCK_SWAP_PRIVATE_KEY } from './constants';

export const swap = async (
  fromChain: Chain,
  toChain: Chain,
  underwriteIncentiveX16: number = 0,
): Promise<number> => {
  const fromEvmChain = new EvmChain(fromChain, false, MOCK_SWAP_PRIVATE_KEY);
  const account = fromEvmChain.signer.address;

  const fromVault = fromEvmChain.getCatalystVaultContract(
    fromChain.catalystVault,
    true,
  );

  const chainIdentifier = defaultAbiCoder.encode(
    ['uint256'],
    [toChain.chainId],
  );

  const toVault = solidityPack(
    ['uint8', 'bytes32', 'address'],
    [20, ethers.constants.HashZero, hexZeroPad(toChain.catalystVault, 32)],
  );
  const toAccount = solidityPack(
    ['uint8', 'bytes32', 'address'],
    [20, ethers.constants.HashZero, hexZeroPad(account, 32)],
  );
  const incentive = {
    maxGasDelivery: 2000000,
    maxGasAck: 2000000,
    refundGasTo: account,
    priceOfDeliveryGas: parseUnits('5', 'gwei'),
    priceOfAckGas: parseUnits('5', 'gwei'),
    targetDelta: 0,
  };

  const amount = parseEther('0.0001');
  const value = parseEther('0.1');

  const toAssetIndex = 0;
  const fromasset = await fromVault._tokenIndexing(toAssetIndex);

  const tokenContract = fromEvmChain.getTokenContract(fromasset);
  const approveTx = await tokenContract.approve(
    fromChain.catalystVault,
    constants.MaxUint256,
  );
  await approveTx.wait();

  const wethContract = await fromEvmChain.getWethContract(fromasset);
  const wethTx = await wethContract.deposit({ value: amount });
  await wethTx.wait();

  const minOut = 0;
  const cdata: any[] = [];

  const tx = await fromVault.sendAsset(
    {
      chainIdentifier,
      toVault,
      toAccount,
      incentive,
    },
    fromasset,
    toAssetIndex,
    amount,
    minOut,
    account,
    underwriteIncentiveX16,
    cdata,
    { gasLimit: 3000000, value },
  );

  await tx.wait();
  const anvil = await fromEvmChain.provider.getTransaction(tx.hash);

  if (!anvil.blockNumber) fail('no block');

  return anvil.blockNumber;
};
