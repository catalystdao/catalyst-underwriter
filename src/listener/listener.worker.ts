import { JsonRpcProvider, Log, LogDescription } from "ethers";
import pino from "pino";
import { workerData, MessagePort } from 'worker_threads';
import { ListenerWorkerData, VaultConfig } from "./listener.service";
import { CatalystChainInterface__factory, ICatalystV1VaultEvents__factory } from "src/contracts";
import { CatalystChainInterfaceInterface, ExpireUnderwriteEvent, FulfillUnderwriteEvent, SwapUnderwrittenEvent } from "src/contracts/CatalystChainInterface";
import { ICatalystV1VaultEventsInterface, SendAssetEvent } from "src/contracts/ICatalystV1VaultEvents";
import { calcAssetSwapIdentifier, wait } from "src/common/utils";
import { Store } from "src/store/store.lib";
import { decodeBytes65Address } from "src/common/decode.payload";
import { ReceiveAssetEvent } from "src/contracts/CatalystVaultCommon";
import { SwapState, SwapStatus, UnderwriteState, UnderwriteStatus } from "src/store/store.types";
import { MonitorInterface, MonitorStatus } from "src/monitor/monitor.interface";

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

    private currentStatus: MonitorStatus | null;


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

        this.startListeningToMonitor(this.config.monitorPort);
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
                vaultInterface.getEvent('ReceiveAsset').topicHash,
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

    private startListeningToMonitor(port: MessagePort): MonitorInterface {
        const monitor = new MonitorInterface(port);

        monitor.addListener((status) => {
            this.currentStatus = status;
        });

        return monitor;
    }



    // Main handler
    // ********************************************************************************************
    async run(): Promise<void> {
        this.logger.info(
            { addresses: this.addresses },
            `Listener worker started.`
        );

        let startBlock = null;
        while (startBlock == null) {
            // Do not initialize 'startBlock' whilst 'currentStatus' is null, even if
            // 'startingBlock' is specified.
            if (this.currentStatus != null) {
                startBlock = (
                    this.config.startingBlock ?? this.currentStatus.blockNumber
                );
            }
            
            await wait(this.config.processingInterval);
        }

        while (true) {
            try {
                let endBlock = this.currentStatus?.blockNumber;
                if (!endBlock || startBlock > endBlock) {
                    await wait(this.config.processingInterval);
                    continue;
                }

                let isCatchingUp = false;
                const blocksToProcess = endBlock - startBlock;
                if (this.config.maxBlocks != null && blocksToProcess > this.config.maxBlocks) {
                    endBlock = startBlock + this.config.maxBlocks;
                    isCatchingUp = true;
                }

                this.logger.info(
                    `Scanning swaps from block ${startBlock} to ${endBlock}.`,
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

            await wait(this.config.processingInterval);
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

            this.logger.warn(
                { address: log.address },
                `No vault/interface configuration found for the contract address ${log.address}.`
            );
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
                { topics: log.topics, data: log.data },
                `Failed to parse Catalyst vault contract event.`,
            );
            return;
        }

        switch (parsedLog.name) {
            case 'SendAsset':
                await this.handleSendAssetEvent(log, parsedLog, vaultConfig);
                break;

            case 'ReceiveAsset':
                await this.handleReceiveAssetEvent(log, parsedLog, vaultConfig);
                break;

            default:
                this.logger.warn(
                    { name: parsedLog.name, topic: parsedLog.topic },
                    `Event with unknown name/topic received.`,
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
                { topics: log.topics, data: log.data },
                `Failed to parse Catalyst chain interface contract event.`,
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
                    { name: parsedLog.name, topic: parsedLog.topic },
                    `Event with unknown name/topic received.`,
                );
        }

    }
    
    private async handleSendAssetEvent (
        log: Log,
        parsedLog: LogDescription,
        vaultConfig: VaultConfig
    ): Promise<void> {

        const vaultAddress = log.address;
        const event = parsedLog.args as unknown as SendAssetEvent.OutputObject;

        const toVault = decodeBytes65Address(event.toVault);
        const toAccount = decodeBytes65Address(event.toAccount);
        //TODO the way in which the hash is calculated should depend on the fromVault template
        const swapId = calcAssetSwapIdentifier(
            toAccount,
            event.units,
            event.fromAmount - event.fee,
            event.fromAsset,
            log.blockNumber
        );
    
        this.logger.info(
            { vaultAddress: vaultAddress, txHash: log.transactionHash, swapId },
            `SendAsset event captured.`
        );

        const toChainId = vaultConfig.channels[event.channelId.toLowerCase()];

        if (toChainId == undefined) {
            this.logger.warn(
                { channelId: event.channelId },
                `Dropping SendAsset event. No mapping for the event's channelId found.`
            );
            return;
        }

        const swapState: SwapState = {
            poolId: vaultConfig.poolId,
            fromChainId: this.chainId,
            fromVault: vaultAddress,
            status: SwapStatus.Pending,
            toChainId,
            swapId,
            toVault,
            toAccount,
            fromAsset: event.fromAsset,
            swapAmount: event.fromAmount - event.fee,
            units: event.units,
            sendAssetEvent: {
                txHash: log.transactionHash,
                blockHash: log.blockHash,
                blockNumber: log.blockNumber,
                fromChannelId: event.channelId,
                toAssetIndex: event.toAssetIndex,
                fromAmount: event.fromAmount,
                fee: event.fee,
                minOut: event.minOut,
                underwriteIncentiveX16: event.underwriteIncentiveX16,
                observedAtBlockNumber: this.currentStatus!.blockNumber
            },
        }
    
        await this.store.saveSwapState(swapState);
    };

    private async handleReceiveAssetEvent(
        log: Log,
        parsedLog: LogDescription,
        vaultConfig: VaultConfig
    ): Promise<void> {

        const vaultAddress = log.address;
        const event = parsedLog.args as unknown as ReceiveAssetEvent.OutputObject;

        //TODO the way in which the hash is calculated should depend on the fromVault template
        const fromVault = decodeBytes65Address(event.fromVault);
        const fromAsset = decodeBytes65Address(event.fromAsset);

        const swapId = calcAssetSwapIdentifier(
            event.toAccount,
            event.units,
            event.fromAmount,
            fromAsset,
            Number(event.sourceBlockNumberMod)
        );
    
        this.logger.info(
            { vaultAddress: vaultAddress, txHash: log.transactionHash, swapId },
            `ReceiveAsset event captured.`
        );

        const fromChainId = vaultConfig.channels[event.channelId.toLowerCase()];

        if (fromChainId == undefined) {
            this.logger.warn(
                { channelId: event.channelId },
                `Dropping ReceiveAsset event. No mapping for the event's channelId found.`
            );
            return;
        }

        const swapState: SwapState = {
            poolId: vaultConfig.poolId,
            fromChainId,
            fromVault,
            status: SwapStatus.Completed,
            toChainId: this.chainId,
            swapId,
            toVault: vaultAddress,
            toAccount: event.toAccount,
            fromAsset,
            swapAmount: event.fromAmount,
            units: event.units,
            receiveAssetEvent: {
                txHash: log.transactionHash,
                blockHash: log.blockHash,
                blockNumber: log.blockNumber,
                toChannelId: event.channelId,
                toAsset: event.toAsset,
                toAmount: event.toAmount,
                sourceBlockNumberMod: Number(event.sourceBlockNumberMod),
            },
        }
    
        await this.store.saveSwapState(swapState);
    };

    
    private async handleSwapUnderwrittenEvent (
        log: Log,
        parsedLog: LogDescription,
        vaultConfig: VaultConfig
    ): Promise<void> {

        const interfaceAddress = log.address;
        const event = parsedLog.args as unknown as SwapUnderwrittenEvent.OutputObject;
        
        const underwriteId = event.identifier;
    
        this.logger.info(
            { interfaceAddress: log.address, txHash: log.transactionHash, underwriteId },
            `SwapUnderwritten event captured.`
        );
    
        const underwriteState: UnderwriteState = {
            poolId: vaultConfig.poolId,
            toChainId: this.chainId,
            toInterface: interfaceAddress,
            status: UnderwriteStatus.Underwritten,
            underwriteId,
            swapUnderwrittenEvent: {
                txHash: log.transactionHash,
                blockHash: log.blockHash,
                blockNumber: log.blockNumber,
                underwriter: event.underwriter,
                expiry: Number(event.expiry),
                targetVault: event.targetVault,
                toAsset: event.toAsset,
                units: event.U,
                toAccount: event.toAccount,
                outAmount: event.outAmount,
            },
        }

        await this.store.saveActiveUnderwriteState(underwriteState);
    };

    
    private async handleFulfillUnderwriteEvent (
        log: Log,
        parsedLog: LogDescription,
        vaultConfig: VaultConfig
    ): Promise<void> {

        const interfaceAddress = log.address;
        const event = parsedLog.args as unknown as FulfillUnderwriteEvent.OutputObject;
        
        const underwriteId = event.identifier;
    
        this.logger.info(
            { interfaceAddress: log.address, txHash: log.transactionHash, underwriteId },
            `FulfillUnderwrite event captured.`
        );
    
        const underwriteState: UnderwriteState = {
            poolId: vaultConfig.poolId,
            toChainId: this.chainId,
            toInterface: interfaceAddress,
            status: UnderwriteStatus.Underwritten,
            underwriteId,
            fulfillUnderwriteEvent: {
                txHash: log.transactionHash,
                blockHash: log.blockHash,
                blockNumber: log.blockNumber,
            }
        }

        await this.store.saveActiveUnderwriteState(underwriteState);
    };

    
    private async handleExpireUnderwriteEvent (
        log: Log,
        parsedLog: LogDescription,
        vaultConfig: VaultConfig
    ): Promise<void> {

        const interfaceAddress = log.address;
        const event = parsedLog.args as unknown as ExpireUnderwriteEvent.OutputObject;
        
        const underwriteId = event.identifier;
    
        this.logger.info(
            { interfaceAddress: log.address, txHash: log.transactionHash, underwriteId },
            `ExpireUnderwrite event captured.`
        );
    
        const underwriteState: UnderwriteState = {
            poolId: vaultConfig.poolId,
            toChainId: this.chainId,
            toInterface: interfaceAddress,
            status: UnderwriteStatus.Underwritten,
            underwriteId,
            expireUnderwriteEvent: {
                txHash: log.transactionHash,
                blockHash: log.blockHash,
                blockNumber: log.blockNumber,
                expirer: event.expirer,
                reward: event.reward,

            }
        }

        await this.store.saveActiveUnderwriteState(underwriteState);
    };

}

void new ListenerWorker().run();
