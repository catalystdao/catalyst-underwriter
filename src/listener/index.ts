import { parentPort, workerData } from 'worker_threads';
import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';
import { wait } from '../common/utils';
import { evaulate } from '../evaluator';
import { Logger } from '../logger';
import { Swap } from '../swap_underwriter/interfaces/swap,interface';
import { getcdataByPayload } from '../swap_underwriter/utils';

const bootstrap = async () => {
  const logger = new Logger();

  const interval: number = workerData.interval;
  const chain: Chain = workerData.chain;
  const evmChain = new EvmChain(chain);
  logger.info(
    `Collecting catalyst vault events for contract ${chain.catalystVault} on ${chain.name} Chain...`,
  );

  const contract = evmChain.getCatalystVaultEventContract(chain.catalystVault);
  const cdata = getcdataByPayload(
    '0x00000000000000000000000000000000000000000000000000000000000000050014d62cfe83343de3bc9aad4cc38818b79cca8be501ba7c978df368e21aa4e37e14000000000000000000000000000000000000000000000000000000000000000000000000000000000000000019dc9f1c9c49b431103ba80a28c206c4a65dc80c14000000000000000000000000000000000000000000000000000000000000000000000000000000000000000019dc9f1c9c49b431103ba80a28c206c4a65dc80c000000030d400123456789abcdeffedcba9876543210',
  );

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
