import { JsonRpcProvider, Log, LogDescription } from "ethers";
import pino from "pino";
import { workerData } from 'worker_threads';
import { ListenerWorkerData } from "./listener.service";
import { CatalystChainInterface__factory, ICatalystV1VaultEvents__factory } from "src/contracts";
import { CatalystChainInterfaceInterface } from "src/contracts/CatalystChainInterface";
import { ICatalystV1VaultEventsInterface } from "src/contracts/ICatalystV1VaultEvents";
import { wait } from "src/common/utils";

class ListenerWorker {
    readonly logger: pino.Logger;

    readonly config: ListenerWorkerData;

    readonly provider: JsonRpcProvider;

    readonly chainId: string;
    readonly chainName: string;
    readonly vaults: string[];
    readonly interfaces: string[];

    readonly vaultEventsInterface: ICatalystV1VaultEventsInterface;
    readonly chainInterfaceEventsInterface: CatalystChainInterfaceInterface;
    readonly addresses: string[];
    readonly topics: string[][];


    constructor() {
        this.config = workerData as ListenerWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;
        this.vaults = this.config.vaults.map((vault) => vault.toLowerCase());   // 'toLowerCase' important for later, when comparing addresses
        this.interfaces = this.config.interfaces.map((vault) => vault.toLowerCase());   // 'toLowerCase' important for later, when comparing addresses
        this.addresses = [...this.vaults, ...this.interfaces];

        this.logger = this.initializeLogger(this.chainId);
        this.provider = this.initializeProvider(this.config.rpc);

        const contractTypes = this.initializeContractTypes();
        this.vaultEventsInterface = contractTypes.vaultInterface;
        this.chainInterfaceEventsInterface = contractTypes.chainInterfaceInterface;
        this.topics = contractTypes.topics;
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(chainId: string): pino.Logger {
        return pino(this.config.loggerOptions).child({
            worker: 'listener',
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

    private initializeContractTypes(): {
        vaultInterface: ICatalystV1VaultEventsInterface,
        chainInterfaceInterface: CatalystChainInterfaceInterface,
        topics: string[][]
    } {

        const vaultInterface = ICatalystV1VaultEvents__factory.createInterface();
        const chainInterfaceInterface = CatalystChainInterface__factory.createInterface();
        const topics = [
            [
                vaultInterface.getEvent('SendAsset').topicHash,
                chainInterfaceInterface.getEvent('SwapUnderwritten').topicHash,
                chainInterfaceInterface.getEvent('FulfillUnderwrite').topicHash,
                chainInterfaceInterface.getEvent('ExpireUnderwrite').topicHash
            ]
        ];

        return {
            vaultInterface,
            chainInterfaceInterface,
            topics
        }
    }



    // Main handler
    // ********************************************************************************************
    async run(): Promise<void> {
        const addressesString = this.addresses.join(', ');
        this.logger.info(
            `Listener worker started (searching events of address(es) ${addressesString} on ${this.chainName} (${this.chainId}))`
        );

        let startBlock = this.config.startingBlock ?? (await this.provider.getBlockNumber());

        await wait(this.config.interval);

        while (true) {
            try {
                let endBlock = await this.provider.getBlockNumber();
                if (startBlock > endBlock || !endBlock) {
                    await wait(this.config.interval);
                    continue;
                }

                let isCatchingUp = false;
                const blocksToProcess = endBlock - startBlock;
                if (this.config.maxBlocks != null && blocksToProcess > this.config.maxBlocks) {
                    endBlock = startBlock + this.config.maxBlocks;
                    isCatchingUp = true;
                }

                this.logger.info(
                    `Scanning swaps from block ${startBlock} to ${endBlock} on ${this.chainName} (${this.chainId})`,
                );
                await this.queryAndProcessEvents(startBlock, endBlock);

                startBlock = endBlock + 1;
                if (isCatchingUp) {
                    // Skip loop delay
                    continue;
                }
            }
            catch (error) {
                this.logger.error(error, `Failed on listener.service`);
            }

            await wait(this.config.interval);
        }
    }

    private async queryAndProcessEvents(
        fromBlock: number,
        toBlock: number
    ): Promise<void> {

        const addresses = [...this.vaults, ...this.interfaces];

        const logs = await this.provider.getLogs({
            address: addresses,
            topics: this.topics,
            fromBlock,
            toBlock
        });

        const vaultLogs = logs.filter((log) => this.vaults.includes(log.address.toLowerCase()));
        await this.handleVaultEvents(vaultLogs);

        const interfaceLogs = logs.filter((log) => this.interfaces.includes(log.address.toLowerCase()));
        await this.handleInterfaceEvents(interfaceLogs);
    }

    // Event handlers
    // ********************************************************************************************

    private async handleVaultEvents(logs: Log[]): Promise<void> {
        for (const log of logs) {
            const parsedLog = this.vaultEventsInterface.parseLog({
                topics: Object.assign([], log.topics),
                data: log.data,
            });

            if (parsedLog == null) {
                this.logger.error(
                    `Failed to parse Catalyst vault contract event. Topics: ${log.topics}, data: ${log.data}`,
                );
                continue;
            }

            switch (parsedLog.name) {
                case 'SendAsset':
                    await this.handleSendAssetEvent(
                        log.address,
                        parsedLog
                    );
                    break;

                default:
                    this.logger.warn(
                        `Event with unknown name/topic received: ${parsedLog.name}/${parsedLog.topic}`,
                    );
            }
        }

    }

    private async handleInterfaceEvents(logs: Log[]): Promise<void> {
        for (const log of logs) {
            const parsedLog = this.chainInterfaceEventsInterface.parseLog({
                topics: Object.assign([], log.topics),
                data: log.data,
            });

            if (parsedLog == null) {
                this.logger.error(
                    `Failed to parse Catalyst chain interface contract event. Topics: ${log.topics}, data: ${log.data}`,
                );
                continue;
            }

            switch (parsedLog.name) {
                case 'SwapUnderwritten':
                    await this.handleSwapUnderwrittenEvent(
                        log.address,
                        parsedLog
                    );
                    break;

                case 'FulfillUnderwrite':
                    await this.handleFulfillUnderwriteEvent(
                        log.address,
                        parsedLog
                    );
                    break;

                case 'ExpireUnderwrite':
                    await this.handleExpireUnderwriteEvent(
                        log.address,
                        parsedLog
                    );
                    break;

                default:
                    this.logger.warn(
                        `Event with unknown name/topic received: ${parsedLog.name}/${parsedLog.topic}`,
                    );
            }
        }

    }
    
    private async handleSendAssetEvent (
        vaultAddress: string,
        event: LogDescription
    ): Promise<void> {
    
        this.logger.info(`SendAsset ${event.args} (${vaultAddress})`);
    
        // TODO
    };

    
    private async handleSwapUnderwrittenEvent (
        interfaceAddress: string,
        event: LogDescription
    ): Promise<void> {
    
        this.logger.info(`SwapUnderwritten ${event.args} (${interfaceAddress})`);
    
        // TODO
    };

    
    private async handleFulfillUnderwriteEvent (
        interfaceAddress: string,
        event: LogDescription
    ): Promise<void> {
    
        this.logger.info(`FulfillUnderwrite ${event.args} (${interfaceAddress})`);
    
        // TODO
    };

    
    private async handleExpireUnderwriteEvent (
        interfaceAddress: string,
        event: LogDescription
    ): Promise<void> {
    
        this.logger.info(`ExpireUnderwrite ${event.args} (${interfaceAddress})`);
    
        // TODO
    };

}

void new ListenerWorker().run();