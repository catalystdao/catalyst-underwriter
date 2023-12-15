import { parentPort } from 'worker_threads';
import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';
import { blockScanner } from '../common/utils';
import { CatalystChainInterface, CatalystVaultEvents } from '../contracts';
import { evaulate } from '../evaluator';
import { Logger } from '../logger';
import { Swap } from '../swap_underwriter/interfaces/swap,interface';
import { SendAssetEvent } from './interface/sendasset-event.interface';

export const listenSwapEvents = async (
  interval: number,
  chain: Chain,
  testing: boolean = false,
): Promise<SendAssetEvent | undefined> => {
  const logger = new Logger();
  const evmChain = new EvmChain(chain);
  const vaultContract = evmChain.getCatalystVaultContract(chain.catalystVault);
  const chainInterface = await vaultContract._chainInterface();

  logger.info(
    `Collecting catalyst swap events for contract ${chain.catalystVault} and ${chainInterface} on ${chain.name} Chain...`,
  );

  const sendAsset = blockScanner(
    evmChain,
    interval,
    logger,
    async (startBlock, endBlock) => {
      logger.info(
        `Scanning catalyst swap events from block ${startBlock} to ${endBlock} on ${evmChain.chain.name} Chain`,
      );

      const chainContract = evmChain.getCatalystChainContract(chainInterface);
      const sendAsset = trackSendAsset(
        vaultContract,
        startBlock,
        endBlock,
        testing,
      );

      trackUnderwriteSwap(chainContract, startBlock, endBlock);

      if (sendAsset && testing) return sendAsset;
      if (testing) return;
    },
  );

  if (sendAsset && testing) return sendAsset;
  if (testing) return;
};

const trackSendAsset = async (
  contract: CatalystVaultEvents,
  startBlock: number,
  endBlock: number,
  testing: boolean,
) => {
  const logs = await contract.queryFilter(
    contract.filters.SendAsset(),
    startBlock,
    endBlock,
  );

  for (const event of logs) {
    const sendAsset = {
      channelId: event.args.channelId,
      toVault: event.args.toVault,
      toAccount: event.args.toAccount,
      fromAsset: event.args.fromAsset,
      toAssetIndex: event.args.toAssetIndex,
      fromAmount: event.args.fromAmount,
      minOut: event.args.minOut,
      units: event.args.units,
      fee: event.args.fee,
      underwriteIncentiveX16: event.args.underwriteIncentiveX16,
    };

    if (testing) return sendAsset;

    if (sendAsset.underwriteIncentiveX16 > 0) {
      const delay = evaulate(sendAsset);
      if (delay) {
        const blockNumber = event.blockNumber;
        const swap: Swap = { sendAsset, delay, blockNumber };
        parentPort?.postMessage(swap);
      }
    }
  }
};

const trackUnderwriteSwap = async (
  contract: CatalystChainInterface,
  startBlock: number,
  endBlock: number,
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
    //TODO add to redis
  }
};
