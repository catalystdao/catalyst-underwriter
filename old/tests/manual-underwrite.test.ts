import { getChainByID } from '../chains/chains';
import { Chain } from '../chains/interfaces/chain.interface';

import { ChainID } from '../chains/enums/chainid.enum';
import { getForkChain } from './utils/common';
import { JsonRpcProvider, StaticJsonRpcProvider } from '@ethersproject/providers';
import { BigNumber, Wallet, ethers } from 'ethers';
import { defaultAbiCoder, hexZeroPad, parseEther, parseUnits, solidityPack } from 'ethers/lib/utils';
import { strict as assert } from 'assert';
import { CatalystChainInterface__factory, CatalystVaultCommon__factory, WETH__factory } from '../contracts';

async function setAccountBalance(
  provider: JsonRpcProvider,
  account: string,
  ethBalance='10000'
): Promise<any> {
  return provider.send('anvil_setBalance', [
    account,
    parseEther(ethBalance).toHexString(),
  ]);
}

function encode65ByteAddress(
  address: string
): string {
  assert(address.length == 2 + 20*2); // Expect a '0x...' encoded address
  return solidityPack(
    ['uint8', 'bytes32', 'address'],
    [20, ethers.constants.HashZero, hexZeroPad(address, 32)],
  );
}

function decodeEventMessage(
  message: string,
): [string, string, string] {
  // The 'message' field within the 'Message' event is encoded as:
  // - Source identifier: 32 bytes
  // - Destination identifier: 32 bytes
  // - App message: bytes

  // Note that on a hex-encoded string one byte is 2 characters

  const sourceIdentifier = add0X(message.slice(2, 2 + 32 * 2));
  const destinationIdentifier = add0X(
    message.slice(2 + 32 * 2, 2 + 32 * 2 + 32 * 2),
  );
  const baseMessage = add0X(message.slice(2 + 32 * 2 + 32 * 2));

  return [sourceIdentifier, destinationIdentifier, baseMessage];
};

function add0X(val: string): string {
  return `0x${val}`;
}

describe('Perform manual underwrite', () => {
  it('perform an underwrite', async () => {

    // This test expects the Sepolia and Mumbai chains to be forked with Anvil.

    const fromChain: Chain = getForkChain(getChainByID(ChainID.Sepolia));
    const toChain: Chain = getForkChain(getChainByID(ChainID.Mumbai));

    const mockKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Anvil mock account 0
    const underwriterKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // Anvil mock account 1

    // Get the fromChain and toChain providers/wallets
    const fromProvider = new StaticJsonRpcProvider(fromChain.rpc);
    const fromWallet = new Wallet(mockKey);
    const fromSigner = fromWallet.connect(fromProvider);

    const toProvider = new StaticJsonRpcProvider(toChain.rpc);
    const toWallet = new Wallet(mockKey);

    const underwriterWallet = new Wallet(underwriterKey);
    const underwriterSigner = underwriterWallet.connect(toProvider);

    // Get the GeneralisedIncentives signer (impersonate account)
    const generalisedIncentivesAddress = "0x0000006aA532b110f36f393887079b35F6C6979a";
    const generalisedIncentivesSigner = toProvider.getSigner(generalisedIncentivesAddress);

    await fromProvider.send('anvil_impersonateAccount', [generalisedIncentivesAddress]);
    await toProvider.send('anvil_impersonateAccount', [generalisedIncentivesAddress]);

    setAccountBalance(fromProvider, fromWallet.address);
    setAccountBalance(toProvider, toWallet.address);
    setAccountBalance(fromProvider, generalisedIncentivesAddress);
    setAccountBalance(toProvider, generalisedIncentivesAddress);



    // Verify the correct configuration of the vaults

    // Verify the vault exists (check supply)
    // const fromEvmChain = new EvmChain(fromChain, false, MOCK_SWAP_PRIVATE_KEY);
    const fromVault = CatalystVaultCommon__factory.connect(
      fromChain.catalystVault,
      fromProvider
    );
    assert(await fromVault.totalSupply() > BigNumber.from(0));

    const toVault = CatalystVaultCommon__factory.connect(
      toChain.catalystVault,
      toProvider
    );
    assert(await toVault.totalSupply() > BigNumber.from(0));


    // Check connections
    const toChainIdentifier = defaultAbiCoder.encode(['uint256'], [toChain.chainId]);
    const toVaultAddress = encode65ByteAddress(toChain.catalystVault);
    assert(await fromVault._vaultConnection(toChainIdentifier, toVaultAddress) === true);

    const fromChainIdentifier = defaultAbiCoder.encode(['uint256'], [fromChain.chainId]);
    const fromVaultAddress = encode65ByteAddress(fromChain.catalystVault);
    assert(await toVault._vaultConnection(fromChainIdentifier, fromVaultAddress) === true);


    // Perform a swap
    const swapRecipientAddress = toWallet.address;
    const swapRecipientEncodedAddress = encode65ByteAddress(swapRecipientAddress);

    const swapAmount = parseEther('0.0001');
    const incentivePayment = parseEther('0.1');

    const fromAssetIndex = 0;
    const toAssetIndex = 0;
    const fromAsset = await fromVault._tokenIndexing(fromAssetIndex);

    // Wrap gas
    const wethContract = WETH__factory.connect(fromAsset, fromProvider); // NOTE: this only works because the first asset hold by the vault is the 'weth' asset
    const wethTx = await wethContract.connect(fromSigner).deposit({ value: swapAmount });
    await wethTx.wait();

    // Set approval
    const approveTx = await wethContract.connect(fromSigner).approve(
      fromChain.catalystVault,
      swapAmount,
    );
    await approveTx.wait();

    const incentive = {
      maxGasDelivery: 2000000,
      maxGasAck: 2000000,
      refundGasTo: toWallet.address,
      priceOfDeliveryGas: parseUnits('5', 'gwei'),
      priceOfAckGas: parseUnits('5', 'gwei'),
      targetDelta: 0,
    };

    const underwriteIncentiveX16 = 0;

    const tx = await fromVault.connect(fromSigner).sendAsset(
      {
        chainIdentifier: toChainIdentifier,
        toVault: toVaultAddress,
        toAccount: swapRecipientEncodedAddress,
        incentive,
      },
      fromAsset,
      toAssetIndex,
      swapAmount,
      0,
      fromWallet.address,
      underwriteIncentiveX16,
      [],
      { gasLimit: 3000000, value: incentivePayment },
    );

    await tx.wait();
    const sendAssetReceipt = await fromProvider.getTransactionReceipt(tx.hash);



    // Get the swap packet/data
    const eventsLogs = sendAssetReceipt.logs;

    // Find the 'mock' implementation 'Message' event
    const giMockMessage = eventsLogs.find(log => log.topics[0].startsWith("0x55d98696b2"))!;

    // Decode the 'Message' event fields
    const messageField = defaultAbiCoder.decode(['bytes32', 'bytes', 'bytes'], giMockMessage.data);

    const [, , baseMessage] = decodeEventMessage(messageField[2]);

    const messageIdentifier =  add0X(baseMessage.slice(2+1*2, 2+33*2));
    const fromApplication =  add0X(baseMessage.slice(2+33*2, 2+98*2));
    const catalystMessage =  add0X(baseMessage.slice(2+169*2));

    const unitsRaw = add0X(catalystMessage.slice(2+196*2,2+228*2));
    const units = BigNumber.from(unitsRaw);



    // Underwrite the swap
    const toCCIAddress = "0xa55eAf1c45cDAbe41c374862982F1543A60A8139";

    // Fund underwriter with wrapped gas
    const toAsset = await toVault._tokenIndexing(toAssetIndex);
    const toWethContract = WETH__factory.connect(toAsset, toProvider); // NOTE: this only works because the first asset hold by the vault is the 'weth' asset
    const underwriteWethTx = await toWethContract.connect(underwriterSigner).deposit({ value: swapAmount.mul(BigNumber.from(10)) });  //TODO amount
    await underwriteWethTx.wait();

    // Set approval
    const underwriterApproveTx = await toWethContract.connect(underwriterSigner).approve(
      toCCIAddress,
      swapAmount.mul(BigNumber.from(10)), //TODO amount
    );
    await underwriterApproveTx.wait();


    const toCCI = CatalystChainInterface__factory.connect(toCCIAddress, toProvider);
    const underwriteTx = await toCCI.connect(underwriterSigner).underwrite(
      toChain.catalystVault,
      toAsset,
      units,
      0,
      swapRecipientAddress,
      underwriteIncentiveX16,
      "0x0000",
      { gasLimit: 20000000 }
    );

    await underwriteTx.wait();



    // Complete the swap (impersonate the GeneralisedIncentives contract)
    const receiveTx = await toCCI.connect(generalisedIncentivesSigner).receiveMessage(
      fromChainIdentifier,
      messageIdentifier,
      fromApplication,
      catalystMessage,
      { gasLimit: 2000000 }
    );

    await receiveTx.wait();

    const receiveLogs = (await toProvider.getTransactionReceipt(receiveTx.hash)).logs;

    // Verify the 'FulfillUnderwrite' is included in the logs
    const fulfillUnderwriteLog = receiveLogs.find(log => log.topics[0].startsWith("8ff233d8"));
    console.log(fulfillUnderwriteLog);
    assert(fulfillUnderwriteLog != undefined);

  }, 60000);
});
