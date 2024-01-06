import pino from 'pino';
import { workerData } from 'worker_threads';
import { Chain } from '../chains/interfaces/chain.interface';
import { listenSwapEvents } from './listenSwapEvents';

const bootstrap = () => {
  const interval: number = workerData.interval;
  const chain: Chain = workerData.chain;
  const loggerOptions: pino.LoggerOptions = workerData.loggerOptions;
  listenSwapEvents(interval, chain, loggerOptions);
};

bootstrap();
