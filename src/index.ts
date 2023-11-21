import * as dotenv from 'dotenv';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { CHAINS } from './chains/chains';
import { Swap } from './swap_underwriter/interfaces/swap,interface';

const bootstrap = () => {
  dotenv.config();

  CHAINS.forEach((chain) => {
    chain.addresses.forEach((address) => {
      const worker = new Worker(join(__dirname, './listener/index.js'), {
        workerData: { address, chain, interval: 4000 },
      });

      worker.on('message', async (swap: Swap) => {
        new Worker(join(__dirname, './swap_underwriter/index.js'), {
          workerData: {
            address,
            chain,
            swap,
          },
        });
      });
    });
  });
};

bootstrap();
