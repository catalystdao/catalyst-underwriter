import { EvmChain } from '../chains/evm-chain';
import { Chain } from '../chains/interfaces/chain.interface';
import { blockScanner } from '../common/utils';
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

  blockScanner(evmChain, interval, logger, async (startBlock, endBlock) => {
    logger.info(
      `Scanning catalyst chain events from block ${startBlock} to ${endBlock} on ${evmChain.chain.name} Chain`,
    );

    const contract = evmChain.getCatalystChainContract(chainInterface);
    const logs = await contract.queryFilter(
      contract.filters.FulfillUnderwrite(),
      startBlock,
      endBlock,
    );

    for (const event of logs) {
      const identifier = event.args.identifier;
      //TODO remove from redis
    }
  });
};
