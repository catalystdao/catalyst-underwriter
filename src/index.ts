import * as dotenv from 'dotenv';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { CHAINS } from './chains/chains';

const bootstrap = () => {
  dotenv.config();

  CHAINS.forEach((chain) => {
    chain.addresses.forEach((address) => {
      const worker = new Worker(join(__dirname, './listener/index.js'), {
        workerData: { address, chain, interval: 4000 },
      });

      worker.on('message', async (obj: any) => {
        //TODO
      });
    });
  });
};

bootstrap();
