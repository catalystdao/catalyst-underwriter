import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';
import { wait } from '../common/utils';
import { Logger } from '../logger';

export const listenToFulfillUnderwrite = async (
  interval: number,
  chain: Chain,
) => {
  const logger = new Logger();
  const evmChain = new EvmChain(chain);
  const vaultContract = evmChain.getCatalystVaultContract(chain.catalystVault);
  const chainInterface = await vaultContract._chainInterface();

  logger.info(
    `Collecting catalyst chain events for contract ${chainInterface} on ${chain.name} Chain...`,
  );

  const contract = evmChain.getCatalystChainContract(chainInterface);

  let startBlock =
    evmChain.chain.startingBlock ?? (await evmChain.getCurrentBlock());
  await wait(interval);

  while (true) {
    let endBlock: number;
    try {
      endBlock = await evmChain.getCurrentBlock();
    } catch (error) {
      logger.error(`Failed on expirer endblock`, error);
      await wait(interval);
      continue;
    }

    if (startBlock === endBlock) {
      await wait(interval);
      continue;
    }

    logger.info(
      `Scanning FulfillUnderwrite events from block ${startBlock} to ${endBlock} on ${evmChain.chain.name} Chain`,
    );

    try {
      const logs = await contract.queryFilter(
        contract.filters.FulfillUnderwrite(),
        startBlock,
        endBlock,
      );

      for (const event of logs) {
        const identifier = event.args.identifier;
        //TODO remove from redis
      }

      startBlock = endBlock;
      await wait(interval);
    } catch (error) {
      logger.error(`Failed on expirer`, error);
    }
  }
};
