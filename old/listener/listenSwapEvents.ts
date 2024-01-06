import pino from 'pino';
import { parentPort } from 'worker_threads';
import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';
import { blockScanner } from '../common/utils';
import { CatalystChainInterface, CatalystVaultEvents } from '../contracts';
import { evaulate } from '../evaluator';
import { RedisStore } from '../redis';
import { Swap } from '../swap_underwriter/interfaces/swap,interface';
import { getSwapIdentifier } from '../swap_underwriter/utils';

export const listenSwapEvents = async (
  interval: number,
  chain: Chain,
  loggerOptions: pino.LoggerOptions,
) => {
  const logger = pino(loggerOptions).child({
    worker: 'Swap-Events',
    chain: chain.chainId,
  });

  const redis = new RedisStore();

  const evmChain = new EvmChain(chain);
  const vaultContract = evmChain.getCatalystVaultContract(chain.catalystVault);
  const chainInterface = await vaultContract._chainInterface();

  logger.info(
    `Collecting catalyst swap events for contract ${chain.catalystVault} and ${chainInterface} on ${chain.name} Chain...`,
  );

  blockScanner(evmChain, interval, logger, async (startBlock, endBlock) => {
    logger.info(
      `Scanning catalyst swap events from block ${startBlock} to ${endBlock} on ${evmChain.chain.name} Chain`,
    );

    const chainContract = evmChain.getCatalystChainContract(chainInterface);
    trackSendAsset(vaultContract, chain.chainId, startBlock, endBlock, redis);

    trackUnderwriteSwap(chainContract, startBlock, endBlock, redis);
  });
};

export const trackSendAsset = async (
  contract: CatalystVaultEvents,
  chainId: string,
  startBlock: number,
  endBlock?: number,
  redis?: RedisStore,
  testing: boolean = false,
) => {
  const logs = await contract.queryFilter(
    contract.filters.SendAsset(),
    startBlock,
    endBlock,
  );

  for (const event of logs) {
    const channelId = event.args.channelId;
    const toVault = event.args.toVault;
    const toAccount = event.args.toAccount;
    const fromAsset = event.args.fromAsset;
    const toAssetIndex = event.args.toAssetIndex;
    const fromAmount = event.args.fromAmount;
    const minOut = event.args.minOut;
    const units = event.args.units;
    const fee = event.args.fee;
    const underwriteIncentiveX16 = event.args.underwriteIncentiveX16;
    const blockNumber = event.blockNumber;

    const swapIdentifier = getSwapIdentifier(
      toAccount,
      units,
      fromAmount,
      fee,
      fromAsset,
      blockNumber,
    );

    const sendAsset = {
      swapIdentifier,
      fromVault: event.address,
      chainId,
      channelId,
      toVault,
      toAccount,
      fromAsset,
      toAssetIndex,
      fromAmount,
      minOut,
      units,
      fee,
      underwriteIncentiveX16,
    };

    if (testing) return sendAsset;

    if (sendAsset.underwriteIncentiveX16 > 0) {
      const delay = evaulate(sendAsset);
      if (delay) {
        const swap: Swap = { sendAsset, delay, blockNumber };
        redis?.set(swapIdentifier, JSON.stringify(sendAsset));
        parentPort?.postMessage(swap);
      }
    }
  }
};

const trackUnderwriteSwap = async (
  contract: CatalystChainInterface,
  startBlock: number,
  endBlock: number,
  redis?: RedisStore,
) => {
  const logs = await contract.queryFilter(
    contract.filters.UnderwriteSwap(),
    startBlock,
    endBlock,
  );

  for (const event of logs) {
    const identifier = event.args.identifier;
    const underwriter = event.args.underwriter;
    const expiry = event.args.expiry;

    const underwriteSwap = {
      identifier,
      underwriter,
      expiry,
    };

    redis?.set(identifier, JSON.stringify(underwriteSwap));
  }
};
