import { workerData } from 'worker_threads';
import { EvmChain } from '../chains/evm-chain';
import { wait } from '../common/utils';
import { Logger } from '../logger';

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
      logger.error(`Failed on getter.service endblock, error:`, error);
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
        //TODO
      });

      startBlock = endBlock;
      await wait(interval);
    } catch (error) {
      logger.error(`Failed on event listener`, error);
    }
  }
};

bootstrap();
