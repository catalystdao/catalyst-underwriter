import * as dotenv from 'dotenv';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { CHAINS } from './chains/chains';
import { Logger } from './logger';
import { Swap } from './swap_underwriter/interfaces/swap,interface';

const bootstrap = () => {
  dotenv.config();
  const logger = new Logger();

  bootstrapListener(logger);
  bootstrapExpirer(logger);
};

const bootstrapListener = (logger: Logger) => {
  CHAINS.forEach((chain) => {
    const worker = new Worker(join(__dirname, './listener/index.js'), {
      workerData: {
        chain,
        interval: 4000,
        loggerOptions: logger.loggerOptions,
      },
    });

    worker.on('message', async (swap: Swap) => {
      const worker = new Worker(
        join(__dirname, './swap_underwriter/index.js'),
        {
          workerData: {
            chain,
            swap,
            loggerOptions: logger.loggerOptions,
          },
        },
      );

      worker.on('error', (error) =>
        logger.fatal(error, 'Error on Underwriter worker.'),
      );

      worker.on('exit', (exitCode) =>
        logger.fatal(`Underwriter worker exited with code ${exitCode}.`),
      );
    });

    worker.on('error', (error) =>
      logger.fatal(error, 'Error on Listener worker.'),
    );

    worker.on('exit', (exitCode) =>
      logger.fatal(`Listener worker exited with code ${exitCode}.`),
    );
  });
};

const bootstrapExpirer = (logger: Logger) => {
  CHAINS.forEach((chain) => {
    const worker = new Worker(join(__dirname, './expirer/index.js'), {
      workerData: {
        chain,
        interval: 4000,
        loggerOptions: logger.loggerOptions,
      },
    });

    worker.on('error', (error) =>
      logger.fatal(error, 'Error on Expirer worker.'),
    );

    worker.on('exit', (exitCode) =>
      logger.fatal(`Expirer worker exited with code ${exitCode}.`),
    );
  });
};

bootstrap();
