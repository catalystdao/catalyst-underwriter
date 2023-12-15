import * as dotenv from 'dotenv';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { CHAINS } from './chains/chains';
import { Logger } from './logger';
import { Swap } from './swap_underwriter/interfaces/swap,interface';

const bootstrap = () => {
  dotenv.config();
  const logger = new Logger();

  CHAINS.forEach((chain) => {
    const worker = new Worker(join(__dirname, './listener/index.js'), {
      workerData: {
        chain,
        interval: 4000,
        loggerOptions: logger.loggerOptions,
      },
    });

    worker.on('message', async (swap: Swap) => {
      new Worker(join(__dirname, './swap_underwriter/index.js'), {
        workerData: {
          chain,
          swap,
          loggerOptions: logger.loggerOptions,
        },
      });
    });
  });

  CHAINS.forEach((chain) => {
    const worker = new Worker(join(__dirname, './expirer/index.js'), {
      workerData: {
        chain,
        interval: 4000,
        loggerOptions: logger.loggerOptions,
      },
    });

    worker.on('message', async (swap: Swap) => {
      new Worker(join(__dirname, './swap_underwriter/index.js'), {
        workerData: {
          chain,
          swap,
          loggerOptions: logger.loggerOptions,
        },
      });
    });
  });
};

bootstrap();
