import { workerData } from 'worker_threads';
import { Chain } from '../chains/interfaces/chain.interface';
import { Swap } from './interfaces/swap,interface';
import { underwrite } from './underwrite';

const bootstrap = () => {
  const swap: Swap = workerData.swap;
  const sourceChain: Chain = workerData.chain;
  underwrite(swap, sourceChain);
};

bootstrap();
