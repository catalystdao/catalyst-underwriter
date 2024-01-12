import { JsonRpcProvider, Log, LogDescription } from "ethers";
import pino from "pino";
import { workerData } from 'worker_threads';
import { ListenerWorkerData, VaultConfig } from "./listener.service";
import { CatalystChainInterface__factory, ICatalystV1VaultEvents__factory } from "src/contracts";
import { CatalystChainInterfaceInterface } from "src/contracts/CatalystChainInterface";
import { ICatalystV1VaultEventsInterface, SendAssetEvent } from "src/contracts/ICatalystV1VaultEvents";
import { calcAssetSwapIdentifier, wait } from "src/common/utils";
import { Store } from "src/store/store.lib";
import { decodeBytes65Address } from "src/common/decode.payload";

class ListenerWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: ListenerWorkerData;

    readonly provider: JsonRpcProvider;

    readonly chainId: string;
    readonly chainName: string;

    readonly vaultConfigs: VaultConfig[];

    readonly vaultEventsInterface: ICatalystV1VaultEventsInterface;
    readonly chainInterfaceEventsInterface: CatalystChainInterfaceInterface;
    readonly addresses: string[];
    readonly topics: string[][];


    constructor() {
        this.config = workerData as ListenerWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;

        this.vaultConfigs = this.normalizeVaultConfig(this.config.vaultConfigs);
        this.addresses = this.getAllAddresses(this.vaultConfigs);

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

    private normalizeVaultConfig(vaultConfigs: VaultConfig[]): VaultConfig[] {

        const normalizedConfigs: VaultConfig[] = [];

        // NOTE: 'toLowerCase' transaforms are important for when comparing addresses later
        for (const vaultConfig of vaultConfigs) {
            const vaultAddress = vaultConfig.vaultAddress.toLowerCase();
            const interfaceAddress = vaultConfig.interfaceAddress.toLowerCase();

            // Make sure that there are no vault/interface address duplicates
            if (normalizedConfigs.some((config) => config.vaultAddress === vaultAddress)) {
                throw new Error(`Vault address ${vaultAddress} is defined more than once.`);
            }
            if (normalizedConfigs.some((config) => config.interfaceAddress === interfaceAddress)) {
                throw new Error(`Interface address ${interfaceAddress} is defined more than once.`);
            }

            // The following logic only works if vault addresses are unique
            const normalizedChannels: Record<string, string> = {}
            for (const [channelId, chainId] of Object.entries(vaultConfig.channels)) {
                normalizedChannels[channelId.toLowerCase()] = chainId;
            }

            normalizedConfigs.push({
                poolId: vaultConfig.poolId,
                vaultAddress,
                interfaceAddress,
                channels: normalizedChannels
            });
        }

        return normalizedConfigs;
    }

    private getAllAddresses(vaultConfigs: VaultConfig[]): string[] {
        return [
            ...vaultConfigs.map((config) => config.vaultAddress),
            ...vaultConfigs.map((config) => config.interfaceAddress)
        ]
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

    private getVaultConfig(address: string): VaultConfig | undefined {
        return this.vaultConfigs.find((config) => {
            return config.vaultAddress == address.toLowerCase()
        });
    }

    private getInterfaceConfig(address: string): VaultConfig | undefined {
        return this.vaultConfigs.find((config) => {
            return config.interfaceAddress == address.toLowerCase()
        });
    }

    private async queryAndProcessEvents(
        fromBlock: number,
        toBlock: number
    ): Promise<void> {

        const logs = await this.provider.getLogs({
            address: this.addresses,
            topics: this.topics,
            fromBlock,
            toBlock
        });

        for (const log of logs) {

            const vaultConfig = this.getVaultConfig(log.address);
            if (vaultConfig != undefined) {
                await this.handleVaultEvent(log, vaultConfig);
                continue;
            }

            const interfaceConfig = this.getInterfaceConfig(log.address);
            if (interfaceConfig != undefined) {
                await this.handleInterfaceEvent(log, interfaceConfig);
                continue;
            }

            this.logger.warn(`No vault/interface configuration found for the address ${log.address}`);
        }
    }

    // Event handlers
    // ********************************************************************************************

    private async handleVaultEvent(log: Log, vaultConfig: VaultConfig): Promise<void> {
        const parsedLog = this.vaultEventsInterface.parseLog({
            topics: Object.assign([], log.topics),
            data: log.data,
        });

        if (parsedLog == null) {
            this.logger.error(
                `Failed to parse Catalyst vault contract event. Topics: ${log.topics}, data: ${log.data}`,
            );
            return;
        }

        switch (parsedLog.name) {
            case 'SendAsset':
                await this.handleSendAssetEvent(log, parsedLog, vaultConfig);
                break;

            default:
                this.logger.warn(
                    `Event with unknown name/topic received: ${parsedLog.name}/${parsedLog.topic}`,
                );
        }
    }

    private async handleInterfaceEvent(log: Log, vaultConfig: VaultConfig): Promise<void> {
        const parsedLog = this.chainInterfaceEventsInterface.parseLog({
            topics: Object.assign([], log.topics),
            data: log.data,
        });

        if (parsedLog == null) {
            this.logger.error(
                `Failed to parse Catalyst chain interface contract event. Topics: ${log.topics}, data: ${log.data}`,
            );
            return;
        }

        switch (parsedLog.name) {
            case 'SwapUnderwritten':
                await this.handleSwapUnderwrittenEvent(log, parsedLog, vaultConfig);
                break;

            case 'FulfillUnderwrite':
                await this.handleFulfillUnderwriteEvent(log, parsedLog, vaultConfig);
                break;

            case 'ExpireUnderwrite':
                await this.handleExpireUnderwriteEvent(log, parsedLog, vaultConfig);
                break;

            default:
                this.logger.warn(
                    `Event with unknown name/topic received: ${parsedLog.name}/${parsedLog.topic}`,
                );
        }

    }
    
    private async handleSendAssetEvent (
        log: Log,
        parsedLog: LogDescription,
        vaultConfig: VaultConfig
    ): Promise<void> {

        const vaultAddress = log.address;
        const sendAssetEvent = parsedLog.args as unknown as SendAssetEvent.OutputObject;
    
        this.logger.info(`SendAsset ${sendAssetEvent} (${vaultAddress})`);

        const toChainId = vaultConfig.channels[sendAssetEvent.channelId.toLowerCase()];

        if (toChainId == undefined) {
            this.logger.warn(`Dropping SendAsset event. No mapping for the event's channelId (${sendAssetEvent.channelId}) found.`);
            return;
        }

        const toVault = decodeBytes65Address(sendAssetEvent.toVault);
        const toAccount = decodeBytes65Address(sendAssetEvent.toAccount);
        const swapId = calcAssetSwapIdentifier(
            toAccount,
            sendAssetEvent.units,
            sendAssetEvent.fromAmount - sendAssetEvent.fee,
            sendAssetEvent.fromAsset,
            log.blockNumber
        );
    
        await this.store.registerSendAsset(
            vaultConfig.poolId,
            this.chainId,
            vaultAddress,
            log.transactionHash,
            toChainId,
            swapId,
            log.blockNumber,
            log.blockHash,
            sendAssetEvent.channelId,
            toVault,
            toAccount,
            sendAssetEvent.fromAsset,
            sendAssetEvent.toAssetIndex,
            sendAssetEvent.fromAmount,
            sendAssetEvent.minOut,
            sendAssetEvent.units,
            sendAssetEvent.fee,
            sendAssetEvent.underwriteIncentiveX16
        )
    };

    
    private async handleSwapUnderwrittenEvent (
        log: Log,
        parsedLog: LogDescription,
        _vaultConfig: VaultConfig
    ): Promise<void> {
    
        this.logger.info(`SwapUnderwritten ${parsedLog.args} (${log.address})`);
    
        // TODO
    };

    
    private async handleFulfillUnderwriteEvent (
        log: Log,
        parsedLog: LogDescription,
        _vaultConfig: VaultConfig
    ): Promise<void> {
    
        this.logger.info(`FulfillUnderwrite ${parsedLog.args} (${log.address})`);
    
        // TODO
    };

    
    private async handleExpireUnderwriteEvent (
        log: Log,
        parsedLog: LogDescription,
        _vaultConfig: VaultConfig
    ): Promise<void> {
    
        this.logger.info(`ExpireUnderwrite ${parsedLog.args} (${log.address})`);
    
        // TODO
    };

}

void new ListenerWorker().run();