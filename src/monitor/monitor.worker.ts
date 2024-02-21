import { Block, JsonRpcProvider } from "ethers";
import pino, { LoggerOptions } from "pino";
import { workerData, parentPort, MessageChannel, MessagePort } from 'worker_threads';
import { Store } from "src/store/store.lib";
import { MonitorWorkerData } from "./monitor.service";
import { MonitorGetPortMessage, MonitorGetPortResponse, MonitorStatusMessage } from "./monitor.types";
import { wait } from "src/common/utils";

class MonitorWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: MonitorWorkerData;

    readonly provider: JsonRpcProvider;

    readonly chainId: string;
    readonly chainName: string;

    private portsCount = 0;
    readonly ports: Record<number, MessagePort> = {};

    private lastBroadcastBlockNumber = -1;
    private latestBlock: Block | null;

    constructor() {
        this.config = workerData as MonitorWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;

        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );
        this.provider = this.initializeProvider(this.config.rpc);

        this.initializePorts();
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(
        chainId: string,
        loggerOptions: LoggerOptions,
    ): pino.Logger {
        return pino(loggerOptions).child({
            worker: 'monitor',
            chain: chainId,
        });
    }

    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(
            rpc,
            undefined,
            { staticNetwork: true }
        )
    }

    private initializePorts(): void {
        parentPort!.on('message', (message: MonitorGetPortMessage) => {
            const port = this.registerNewPort();
            const response: MonitorGetPortResponse = {
                messageId: message.messageId,
                port
            };
            parentPort!.postMessage(response, [port])
        });
    }

    private registerNewPort(): MessagePort {

        const portId = this.portsCount++;

        const { port1, port2 } = new MessageChannel();

        this.ports[portId] = port1;

        return port2;
    }



    // Main handler
    // ********************************************************************************************

    async run(): Promise<void> {
        this.logger.info(
            `Monitor worker started.`
        );

        while (true) {
            try {
                const newBlock = await this.provider.getBlock(-this.config.blockDelay);
                if (!newBlock || newBlock.number <= this.lastBroadcastBlockNumber) {
                    await wait(this.config.interval);
                    continue;
                }

                this.logger.debug(
                    `Monitor at block ${newBlock.number}.`,
                );

                this.latestBlock = newBlock;
                this.broadcastStatus();
            }
            catch (error) {
                this.logger.error(error, `Failed on monitor.service`);
            }

            await wait(this.config.interval);
        }
    }

    private broadcastStatus(): void {
        if (!this.latestBlock) {
            this.logger.warn('Unable to broadcast status. \'latestBlock\' is null.');
            return;
        }

        const status: MonitorStatusMessage = {
            blockNumber: this.latestBlock.number,
            hash: this.latestBlock.hash,
            timestamp: this.latestBlock.timestamp
        };

        for (const port of Object.values(this.ports)) {
            port.postMessage(status);
        }

        this.lastBroadcastBlockNumber = status.blockNumber;
    }

}

void new MonitorWorker().run();
