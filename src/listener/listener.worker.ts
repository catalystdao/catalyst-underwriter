import { JsonRpcProvider, Log, LogDescription } from "ethers";
import pino from "pino";
import { workerData } from 'worker_threads';
import { ListenerWorkerData, VaultConfig } from "./listener.service";
import { CatalystChainInterface__factory, ICatalystV1VaultEvents__factory } from "src/contracts";
import { CatalystChainInterfaceInterface } from "src/contracts/CatalystChainInterface";
import { ICatalystV1VaultEventsInterface, SendAssetEvent } from "src/contracts/ICatalystV1VaultEvents";
import { wait } from "src/common/utils";
import { Store } from "src/store/store.lib";

class ListenerWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: ListenerWorkerData;

    readonly provider: JsonRpcProvider;

    readonly chainId: string;
    readonly chainName: string;
    readonly vaults: string[];
    readonly interfaces: string[];
    readonly channels: Record<string, Record<string, string>>;  // Maps a vault address to its channels (bytes32 hex channel => chainId)

    readonly vaultEventsInterface: ICatalystV1VaultEventsInterface;
    readonly chainInterfaceEventsInterface: CatalystChainInterfaceInterface;
    readonly addresses: string[];
    readonly topics: string[][];


    constructor() {
        this.config = workerData as ListenerWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;
        [this.vaults, this.interfaces, this.channels] = this.initializeAddresses(this.config.vaultConfigs);
        this.addresses = [...this.vaults, ...this.interfaces];

        this.store = new Store();
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

    private initializeAddresses(vaultConfigs: VaultConfig[]): [
        vaults: string[],
        interfaces: string[],
        channels: Record<string, Record<string, string>>
    ] {

        const vaults = [];
        const interfaces = [];
        const channels: Record<string, Record<string, string>> = {};

        // NOTE: 'toLowerCase' transaforms are important for when comparing addresses later
        for (const vaultConfig of vaultConfigs) {
            const vaultAddress = vaultConfig.vaultAddress.toLowerCase();
            const interfaceAddress = vaultConfig.interfaceAddress.toLowerCase();

            vaults.push(vaultAddress);
            interfaces.push(interfaceAddress);

            // ! TODO the following logic will yield inconsistent results if there are multiple vaults definitions on the same chain under the same address (this should never happen, but should be protected for still).
            channels[vaultAddress] = {}
            for (const [channelId, chainId] of Object.entries(vaultConfig.channels)) {
                channels[vaultAddress][channelId.toLowerCase()] = chainId;
            }
        }

        return [vaults, interfaces, channels];
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
                        log.transactionHash,
                        parsedLog.args as unknown as SendAssetEvent.OutputObject,   //TODO verify?
                        log.blockNumber,
                        log.blockHash
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
        txHash: string,
        event: SendAssetEvent.OutputObject,
        blockHeight: number,
        blockHash: string
    ): Promise<void> {
    
        this.logger.info(`SendAsset ${event} (${vaultAddress})`);

        const toChainId = this.channels[vaultAddress.toLowerCase()]?.[event.channelId.toLowerCase()];

        if (toChainId == undefined) {
            this.logger.warn(`Dropping SendAsset event. No mapping for the event's channelId (${event.channelId}) found.`);
            return;
        }
    
        await this.store.registerSendAsset(
            this.chainId,
            vaultAddress,
            txHash,
            toChainId,
            'id', //TODO
            event,
            blockHeight,
            blockHash
        )
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