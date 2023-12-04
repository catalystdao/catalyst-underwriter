import { workerData } from 'worker_threads';
import { Chain } from '../chains/interfaces/chain.interface';
import { listenToSendAsset } from './listenSendAsset';

const bootstrap = () => {
  const interval: number = workerData.interval;
  const chain: Chain = workerData.chain;
  listenToSendAsset(interval, chain);
};

bootstrap();
