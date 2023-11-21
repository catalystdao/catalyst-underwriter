import { parentPort, workerData } from 'worker_threads';
import { EvmChain } from '../chains/evm-chain';
import { wait } from '../common/utils';
import { evaulate } from '../evaluator';
import { Logger } from '../logger';
import { Swap } from '../swap_underwriter/interfaces/swap,interface';

const bootstrap = async () => {
  const logger = new Logger();

  const interval = workerData.interval;
  const address = workerData.address;
  const chain = new EvmChain(workerData.chain);
  logger.info(
    `Collecting catalyst vault events for contract ${address} on ${chain.chain.name} Chain...`,
  );

  const contract = chain.getCatalystVaultEventContract(address);

  let startBlock = await chain.getCurrentBlock();
  await wait(interval);

  while (true) {
    let endBlock: number;
    try {
      endBlock = await chain.getCurrentBlock();
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
      `Scanning events from block ${startBlock} to ${endBlock} on ${chain.chain.name} Chain`,
    );

    try {
      const logs = await contract.queryFilter(
        contract.filters.SendAsset(),
        startBlock,
        endBlock,
      );

      logs.forEach(async (event) => {
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

        if (sendAsset.underwriteIncentiveX16 > 0) {
          const delay = evaulate(sendAsset);
          if (delay) {
            const blockNumber = event.blockNumber;
            const swap: Swap = { sendAsset, delay, blockNumber };
            parentPort?.postMessage(swap);
          }
        }
      });

      startBlock = endBlock;
      await wait(interval);
    } catch (error) {
      logger.error(`Failed on event listener`, error);
    }
  }
};

bootstrap();
