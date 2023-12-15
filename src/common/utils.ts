import { EvmChain } from '../chains/evm-chain';
import { Logger } from '../logger';

export const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

export const add0X = (address: string): string => `0x${address}`;

export const convertHexToDecimal = (hex: string) => BigInt(hex).toString();

export const decodeVaultOrAccount = (encodedAddress: string) => {
  return add0X(encodedAddress.substring(92));
};

export const blockScanner = async (
  evmChain: EvmChain,
  interval: number,
  logger: Logger,
  callBack: (startBlock: number, endBlock: number) => void,
) => {
  let startBlock =
    evmChain.chain.startingBlock ?? (await evmChain.getCurrentBlock());
  await wait(interval);

  while (true) {
    let endBlock: number;
    try {
      endBlock = await evmChain.getCurrentBlock();
    } catch (error) {
      logger.error(error, `Failed to get End Block`);
      await wait(interval);
      continue;
    }

    if (startBlock > endBlock || !endBlock) {
      await wait(interval);
      continue;
    }

    try {
      callBack(startBlock, endBlock);

      startBlock = endBlock + 1;
      await wait(interval);
    } catch (error) {
      logger.error(error, `Block Scanner Failed`);
      await wait(interval);
    }
  }
};
