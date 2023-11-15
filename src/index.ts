import * as dotenv from 'dotenv';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { CHAINS } from './chains/chains';
import { SendAssetEvent } from './listener/interface/sendasset-event.interface';
import { underwrite } from './swap_underwriter';

const bootstrap = () => {
  dotenv.config();

  CHAINS.forEach((chain) => {
    chain.addresses.forEach((address) => {
      const worker = new Worker(join(__dirname, './listener/index.js'), {
        workerData: { address, chain, interval: 4000 },
      });

      worker.on('message', async (sendAsset: SendAssetEvent) => {
        underwrite(chain, address, sendAsset);
      });
    });
  });
};

bootstrap();
