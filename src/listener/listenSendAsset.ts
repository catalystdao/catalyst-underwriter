import { parentPort } from 'worker_threads';
import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';
import { wait } from '../common/utils';
import { evaulate } from '../evaluator';
import { Logger } from '../logger';
import { Swap } from '../swap_underwriter/interfaces/swap,interface';
import { SendAssetEvent } from './interface/sendasset-event.interface';

export const listenToSendAsset = async (
  interval: number,
  chain: Chain,
  testing: boolean = false,
): Promise<SendAssetEvent | undefined> => {
  const logger = new Logger();
  const evmChain = new EvmChain(chain);
  logger.info(
    `Collecting catalyst vault events for contract ${chain.catalystVault} on ${chain.name} Chain...`,
  );
  const contract = evmChain.getCatalystVaultEventContract(chain.catalystVault);

  let startBlock =
    evmChain.chain.startingBlock ?? (await evmChain.getCurrentBlock());
  await wait(interval);

  while (true) {
    let endBlock: number;
    try {
      endBlock = await evmChain.getCurrentBlock();
    } catch (error) {
      logger.error(`Failed on the event listener endblock`, error);
      await wait(interval);
      continue;
    }

    if (startBlock === endBlock) {
      await wait(interval);
      continue;
    }

    logger.info(
      `Scanning events from block ${startBlock} to ${endBlock} on ${evmChain.chain.name} Chain`,
    );

    try {
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

      if (testing) return;

      startBlock = endBlock;
      await wait(interval);
    } catch (error) {
      logger.error(`Failed on event listener`, error);
    }
  }
};
