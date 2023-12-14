import { workerData } from 'worker_threads';
import { Chain } from '../chains/interfaces/chain.interface';
import { listenToFulfillUnderwrite } from './listenFulfillUnderwrite';

const bootstrap = () => {
  const interval: number = workerData.interval;
  const chain: Chain = workerData.chain;
  listenToFulfillUnderwrite(interval, chain);
};

bootstrap();
