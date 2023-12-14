import { workerData } from 'worker_threads';
import { Chain } from '../chains/interfaces/chain.interface';
import { listenSwapEvents } from './listenSwapEvents';

const bootstrap = () => {
  const interval: number = workerData.interval;
  const chain: Chain = workerData.chain;
  listenSwapEvents(interval, chain);
};

bootstrap();
