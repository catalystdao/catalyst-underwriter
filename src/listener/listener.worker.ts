import { JsonRpcProvider, Log, LogDescription } from "ethers";
import pino from "pino";
import { workerData, MessagePort } from 'worker_threads';
import { ListenerWorkerData } from "./listener.service";
import { CatalystChainInterface__factory, ICatalystV1VaultEvents__factory } from "src/contracts";
import { CatalystChainInterfaceInterface, ExpireUnderwriteEvent, FulfillUnderwriteEvent, SwapUnderwrittenEvent } from "src/contracts/CatalystChainInterface";
import { ICatalystV1VaultEventsInterface, SendAssetEvent } from "src/contracts/ICatalystV1VaultEvents";
import { calcAssetSwapIdentifier, tryErrorToString, wait } from "src/common/utils";
import { Store } from "src/store/store.lib";
import { MessageContext, SOURCE_TO_DESTINATION, decodeBytes65Address, parsePayload } from "src/common/decode.payload";
import { ReceiveAssetEvent } from "src/contracts/CatalystVaultCommon";
import { SwapState, SwapStatus, UnderwriteState, UnderwriteStatus } from "src/store/store.types";
import { MonitorInterface, MonitorStatus } from "src/monitor/monitor.interface";
import { ASSET_SWAP, CatalystContext, catalystParse } from "src/common/decode.catalyst";
import { EndpointConfig } from "src/config/config.types";
import WebSocket from "ws";

const BYTES_4_MASK = 4294967295;

class ListenerWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: ListenerWorkerData;

    readonly provider: JsonRpcProvider;

    readonly chainId: string;
    readonly chainName: string;

    readonly vaultEventsInterface: ICatalystV1VaultEventsInterface;
    readonly chainInterfaceEventsInterface: CatalystChainInterfaceInterface;
    readonly addresses: string[];
    readonly topics: string[][];

    private blockTimestamps: Map<number, number>; // Map block number => timestamp

    private currentStatus: MonitorStatus | null;


    constructor() {
        this.config = workerData as ListenerWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;

        this.addresses = this.getAllAddresses(this.config.endpointConfigs);

        this.store = new Store();
        this.logger = this.initializeLogger(this.chainId);
        this.provider = this.initializeProvider(this.config.rpc);

        const contractTypes = this.initializeContractTypes();
        this.vaultEventsInterface = contractTypes.vaultInterface;
        this.chainInterfaceEventsInterface = contractTypes.chainInterfaceInterface;
        this.topics = contractTypes.topics;

        this.blockTimestamps = new Map();

        this.startListeningToMonitor(this.config.monitorPort);
        this.startListeningToRelayer();
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

    private getAllAddresses(endpointConfigs: EndpointConfig[]): string[] {
        const allInterfaceAddresses = endpointConfigs.map((config) => config.interfaceAddress);

        return [
            ...new Set(allInterfaceAddresses)   // Filter out duplicates
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
                // vaultInterface.getEvent('SendAsset').topicHash,
                // vaultInterface.getEvent('ReceiveAsset').topicHash,
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
            this.registerBlockTimestamp(status.blockNumber, status.timestamp);
        });

        return monitor;
    }

    private startListeningToRelayer(): void {
        this.logger.info(`Start listening to the relayer for new AMB messages.`);

        const wsUrl = `http://${process.env.RELAYER_HOST}:${process.env.RELAYER_PORT}/`;
        const ws = new WebSocket(wsUrl);
    
        ws.on("open", () => {
            // Subscribe to new AMB messages
            ws.send(
                JSON.stringify({event: "ambMessage"}),
                (error) => {
                    if (error != null) {
                        this.logger.error("Failed to subscribe to 'ambMessage' events.");
                    }
                }
            );
        });

        ws.on("error", (error) => {
            this.logger.warn(
                {
                    wsUrl,
                    error: tryErrorToString(error)
                },
                'Error on websocket connection.'
            );
        });

        ws.on("close", (exitCode) => {
            this.logger.warn(
                {
                    wsUrl,
                    exitCode,
                    retryInterval: this.config.retryInterval
                },
                'Websocket connection with relayer closed. Will attempt reconnection.'
            );

            setTimeout(() => this.startListeningToRelayer(), this.config.retryInterval);
        });
    
        ws.on("message", (data) => {
            const parsedMessage = JSON.parse(data.toString());

            if (parsedMessage.event == "ambMessage") {
                const ambMessage = parsedMessage.data;
                if (ambMessage == undefined) {
                    this.logger.warn(
                        { parsedMessage },
                        "No data present on 'ambMessage' event."
                    )
                }
                if (ambMessage.sourceChain != this.chainId) return;

                this.logger.info(
                    { messageIdentifier: ambMessage.messageIdentifier },
                    "AMB message received.",
                );

                try {
                    this.processAMBMessage(ambMessage);
                } catch {
                    this.logger.warn(
                        { ambMessage },
                        "Failed to process the AMB message.",
                    )
                }
            } else {
                this.logger.warn(
                    { message: data },
                    "Unknown message type received on websocket connection.",
                )
            }
        });
    }



    // Block helpers
    // ********************************************************************************************
    private registerBlockTimestamp(blockNumber: number, timestamp: number): void {
        this.blockTimestamps.set(blockNumber, timestamp);
    }

    // NOTE: This function will stall the worker until a successful block query is made.
    private async queryBlockTimestamp(blockNumber: number): Promise<number | null> {
        let tryCount = 0;
        let timestamp: number | null | undefined = undefined;
        while (timestamp === undefined) {
            try {
                const block = await this.provider.getBlock(blockNumber);
                timestamp = block?.timestamp ?? null; // ! 'block' may ben null if the 'blockNumber' is invalid. In such case, set the timestamp to 'null'.
            } catch {
                this.logger.warn(
                    {
                        blockNumber,
                        try: tryCount,
                    },
                    'Failed to query the block timestamp'
                );

                tryCount++;
                await wait(this.config.retryInterval); 
            }
        }
        
        return timestamp;
    }

    private async getBlockTimestamp(blockNumber: number): Promise<number | null> {
        const cachedTimestamp = this.blockTimestamps.get(blockNumber);
        if (cachedTimestamp != null) {
            return cachedTimestamp;
        }

        const queriedTimestamp = await this.queryBlockTimestamp(blockNumber);
        if (queriedTimestamp != null) {
            this.registerBlockTimestamp(blockNumber, queriedTimestamp);
            return queriedTimestamp;
        }

        return null;
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

                const blocksToProcess = endBlock - startBlock;
                if (this.config.maxBlocks != null && blocksToProcess > this.config.maxBlocks) {
                    endBlock = startBlock + this.config.maxBlocks;
                }

                this.logger.info(
                    `Scanning swaps from block ${startBlock} to ${endBlock}.`,
                );
                await this.queryAndProcessEvents(startBlock, endBlock);

                startBlock = endBlock + 1;
            }
            catch (error) {
                this.logger.error(error, `Failed on listener.worker`);
            }

            await wait(this.config.processingInterval);
        }
    }

    // private getVaultConfig(address: string): VaultConfig | undefined {
    //     return this.vaultConfigs.find((config) => {
    //         return config.vaultAddress == address.toLowerCase()
    //     });
    // }

    private isInterface(address: string): boolean {
        return this.config.endpointConfigs.some((config) => {
            return config.interfaceAddress == address.toLowerCase()
        });
    }

    private async queryAndProcessEvents(
        fromBlock: number,
        toBlock: number
    ): Promise<void> {

        const logs = await this.queryLogs(fromBlock, toBlock);

        for (const log of logs) {
            try {
                // const vaultConfig = this.getVaultConfig(log.address);
                // if (vaultConfig != undefined) {
                //     await this.handleVaultEvent(log, vaultConfig);
                //     continue;
                // }

                const isInterface = this.isInterface(log.address);
                if (isInterface) {
                    await this.handleInterfaceEvent(log);
                    continue;
                }

                this.logger.warn(
                    { address: log.address },
                    `No vault/interface configuration found for the contract address ${log.address}.`
                );
            } catch (error) {
                this.logger.error(
                    { log, error },
                    `Failed to process event on listener worker.`
                );
            }
        }
    }

    private async queryLogs(
        fromBlock: number,
        toBlock: number
    ): Promise<Log[]> {
        const filter = {
            address: this.addresses,
            topics: this.topics,
            fromBlock,
            toBlock
        };

        let logs: Log[] | undefined;
        let i = 0;
        while (logs == undefined) {
            try {
                logs = await this.provider.getLogs(filter);
            } catch (error) {
                i++;
                this.logger.warn(
                    { ...filter, error: tryErrorToString(error), try: i },
                    `Failed to 'getLogs' on listener. Worker blocked until successful query.`
                );
                await wait(this.config.retryInterval);
            }
        }

        return logs;
    }

    // Event handlers
    // ********************************************************************************************

    // private async handleVaultEvent(log: Log, vaultConfig: VaultConfig): Promise<void> {
    //     const parsedLog = this.vaultEventsInterface.parseLog({
    //         topics: Object.assign([], log.topics),
    //         data: log.data,
    //     });

    //     if (parsedLog == null) {
    //         this.logger.error(
    //             { topics: log.topics, data: log.data },
    //             `Failed to parse Catalyst vault contract event.`,
    //         );
    //         return;
    //     }

    //     switch (parsedLog.name) {
    //         case 'SendAsset':
    //             await this.handleSendAssetEvent(log, parsedLog, vaultConfig);
    //             break;

    //         case 'ReceiveAsset':
    //             await this.handleReceiveAssetEvent(log, parsedLog, vaultConfig);
    //             break;

    //         default:
    //             this.logger.warn(
    //                 { name: parsedLog.name, topic: parsedLog.topic },
    //                 `Event with unknown name/topic received.`,
    //             );
    //     }
    // }

    private async handleInterfaceEvent(log: Log): Promise<void> {
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
                await this.handleSwapUnderwrittenEvent(log, parsedLog);
                break;

            case 'FulfillUnderwrite':
                await this.handleFulfillUnderwriteEvent(log, parsedLog);
                break;

            case 'ExpireUnderwrite':
                await this.handleExpireUnderwriteEvent(log, parsedLog);
                break;

            default:
                this.logger.warn(
                    { name: parsedLog.name, topic: parsedLog.topic },
                    `Event with unknown name/topic received.`,
                );
        }

    }
    
    // private async handleSendAssetEvent (
    //     log: Log,
    //     parsedLog: LogDescription,
    //     vaultConfig: VaultConfig
    // ): Promise<void> {

        // const vaultAddress = log.address;
        // const event = parsedLog.args as unknown as SendAssetEvent.OutputObject;

        // //TODO implement a better (generic) block number fix
        // let blockNumber = log.blockNumber;
        // if (this.chainId == '421614') { // Arbitrum sepolia
        //     const blockData = await this.provider.send(
        //         "eth_getBlockByNumber",
        //         ["0x"+blockNumber.toString(16), false]
        //     );
        //     blockNumber = blockData.l1BlockNumber;
        // }
        
        // //TODO the way in which the hash is calculated should depend on the fromVault template
        // const swapId = calcAssetSwapIdentifier(
        //     decodeBytes65Address(event.toAccount),
        //     event.units,
        //     event.fromAmount - event.fee,
        //     event.fromAsset,
        //     blockNumber
        // );
    
        // this.logger.info(
        //     { vaultAddress: vaultAddress, txHash: log.transactionHash, swapId },
        //     `SendAsset event captured.`
        // );

        // const blockTimestamp = await this.getBlockTimestamp(log.blockNumber);
        // if (blockTimestamp == null) {
        //     this.logger.warn(
        //         { 
        //             blockNumber,
        //             event
        //         },
        //         `Dropping SendAsset event. No timestamp for the block number found.`
        //     );
        //     return;
        // }

        // void this.getAMBMessageData(
        //     log.transactionHash,
        //     swapId,
        //     vaultAddress,
        //     blockNumber
        // ).then(async (ambMessageData) => {
        //     if (ambMessageData == undefined) {
        //         this.logger.info(
        //             {
        //                 txHash: log.transactionHash,
        //                 sourceVault: vaultAddress,
        //                 swapId,
        //             },
        //             `Failed to get the AMB message data for the given asset swap. Swap will not be underwritten.`
        //         );
        //         return;
        //     }
            
        //     const {ambMessageMetadata, incentivesMessage, assetSwapPayload} = ambMessageData;

        //     const originEndpoint = this.getSwapOriginEndpoint(
        //         incentivesMessage.sourceApplicationAddress,
        //         "" // TODO
        //     );

        //     if (originEndpoint == undefined) {
        //         this.logger.info(
        //             {
        //                 txHash: log.transactionHash,
        //                 sourceVault: vaultAddress,
        //                 swapId,
        //             },
        //             'Swap source endpoint not found. Skipping.'
        //         );
        //         return;
        //     }

        //     const fromChannelId = originEndpoint.channelsOnDestination[ambMessageMetadata.destinationChain];
        //     if (fromChannelId == undefined) {
        //         this.logger.info(
        //             {
        //                 txHash: log.transactionHash,
        //                 sourceVault: vaultAddress,
        //                 swapId,
        //                 fromInterfaceAddress: incentivesMessage.sourceApplicationAddress,
        //                 fromIncentivesAddress: "", // TODO,
        //                 toChainId: ambMessageMetadata.destinationChain
        //             },
        //             `'fromChannelId' for the given swap not found. Skipping.`
        //         );
        //         return;
        //     }

        //     // TODO validate the sourceEscrow

        //     const swapState: SwapState = {
        //         fromChainId: this.chainId,
        //         fromVault: vaultAddress,
        //         swapId,
        //         status: SwapStatus.Pending,
        //         ambMessageSendAssetDetails: {
        //             txHash: log.transactionHash,
        //             blockHash: log.blockHash,
        //             blockNumber,
            
        //             amb: ambMessageMetadata.amb,
        //             toChainId: ambMessageMetadata.destinationChain,
        //             fromChannelId,

        //             toIncentivesAddress: "", // ! TODO
        //             toApplication: incentivesMessage.toApplication,
        //             messageIdentifier: ambMessageMetadata.messageIdentifier,
        //             deadline: incentivesMessage.deadline,
        //             maxGasDelivery: incentivesMessage.maxGasLimit,
            
        //             fromVault: assetSwapPayload.fromVault,
        //             toVault: assetSwapPayload.toVault,
        //             toAccount: assetSwapPayload.toAccount,
        //             units: assetSwapPayload.units,
        //             toAssetIndex: BigInt(assetSwapPayload.toAssetIndex),
        //             minOut: assetSwapPayload.minOut,
        //             swapAmount: assetSwapPayload.fromAmount,
        //             fromAsset: assetSwapPayload.fromAsset,
        //             blockNumberMod: BigInt(assetSwapPayload.blockNumber),
        //             underwriteIncentiveX16: BigInt(assetSwapPayload.underwritingIncentive),
        //             calldata: assetSwapPayload.cdata,

        //             blockTimestamp,
        //             observedAtBlockNumber: this.currentStatus!.blockNumber,
        //         },
        //     }
        
        //     await this.store.saveSwapState(swapState);
        // })

    // };


    // private async queryAMBMessageData(
    //     txHash: string,
    //     swapId: string,
    //     sourceVault: string,
    //     blockNumber: number,
    // ): Promise<{
    //     ambMessageMetadata: any, // TODO type
    //     incentivesMessage: SOURCE_TO_DESTINATION,
    //     assetSwapPayload: ASSET_SWAP
    // } | undefined> {
        
    //     const relayerEndpoint = `http://${process.env.RELAYER_HOST}:${process.env.RELAYER_PORT}/getAMBMessages?`;

    //     const res = await fetch(relayerEndpoint + new URLSearchParams({chainId: this.chainId, txHash}));
    //     const ambs = (await res.json());    //TODO type

    //     // Find the AMB that matches the SendAsset event
    //     for (const amb of ambs) {
    //         try {
    //             if (amb.sourceChain != this.chainId) continue;

    //             const giPayload = parsePayload(amb.payload);

    //             if (giPayload.context != MessageContext.CTX_SOURCE_TO_DESTINATION) continue;

    //             // TODO validate 'sourceApplicationAddress' (i.e. is it an approved 'sourceInterface'?)
    //             // if (giPayload.sourceApplicationAddress.toLowerCase() != sourceInterface.toLowerCase()) continue;

    //             const catalystPayload = catalystParse(giPayload.message);

    //             if (catalystPayload.context != CatalystContext.ASSET_SWAP) continue;

    //             // ! It is very important to validate that the 'fromVault' encoded within the swap
    //             // ! message is the same as the address of the contract which emitted the SendAsset
    //             // ! event. (Technically, the address of the vault is irrelevant if the destination
    //             // ! vault accepts the message, but other parts of this underwriter implementation
    //             // ! may rely on this fact.)
    //             if (catalystPayload.fromVault.toLowerCase() != sourceVault.toLowerCase()) continue;
    //             if (catalystPayload.blockNumber != (blockNumber & BYTES_4_MASK)) continue;

    //             const ambSwapId = calcAssetSwapIdentifier(
    //                 catalystPayload.toAccount,
    //                 catalystPayload.units,
    //                 catalystPayload.fromAmount,
    //                 catalystPayload.fromAsset,
    //                 catalystPayload.blockNumber
    //             )

    //             if (ambSwapId.toLowerCase() != swapId.toLowerCase()) continue;

    //             return {
    //                 ambMessageMetadata: amb,
    //                 incentivesMessage: giPayload,
    //                 assetSwapPayload: catalystPayload,
    //             };

    //         } catch {
    //             // Continue
    //         }
    //     }

    //     return undefined;
    // }

    // private async handleReceiveAssetEvent(
    //     log: Log,
    //     parsedLog: LogDescription,
    //     vaultConfig: VaultConfig
    // ): Promise<void> {

        //TODO
        // const vaultAddress = log.address;
        // const event = parsedLog.args as unknown as ReceiveAssetEvent.OutputObject;

        // //TODO the way in which the hash is calculated should depend on the fromVault template
        // const fromVault = decodeBytes65Address(event.fromVault);
        // const fromAsset = decodeBytes65Address(event.fromAsset);

        // const swapId = calcAssetSwapIdentifier(
        //     event.toAccount,
        //     event.units,
        //     event.fromAmount,
        //     fromAsset,
        //     Number(event.sourceBlockNumberMod)
        // );
    
        // this.logger.info(
        //     { vaultAddress: vaultAddress, txHash: log.transactionHash, swapId },
        //     `ReceiveAsset event captured.`
        // );

        // const fromChainId = vaultConfig.channels[event.channelId.toLowerCase()];

        // if (fromChainId == undefined) {
        //     this.logger.warn(
        //         { channelId: event.channelId },
        //         `Dropping ReceiveAsset event. No mapping for the event's channelId found.`
        //     );
        //     return;
        // }

        // const swapState: SwapState = {
        //     poolId: vaultConfig.poolId,
        //     fromChainId,
        //     fromVault,
        //     status: SwapStatus.Completed,
        //     toChainId: this.chainId,
        //     swapId,
        //     toVault: vaultAddress,
        //     toAccount: event.toAccount,
        //     fromAsset,
        //     swapAmount: event.fromAmount,
        //     units: event.units,
        //     receiveAssetEvent: {
        //         txHash: log.transactionHash,
        //         blockHash: log.blockHash,
        //         blockNumber: log.blockNumber,
        //         toChannelId: event.channelId,
        //         toAsset: event.toAsset,
        //         toAmount: event.toAmount,
        //         sourceBlockNumberMod: Number(event.sourceBlockNumberMod),
        //     },
        // }
    
        // await this.store.saveSwapState(swapState);
    // };

    
    private async handleSwapUnderwrittenEvent (
        log: Log,
        parsedLog: LogDescription
    ): Promise<void> {

        const interfaceAddress = log.address;
        const event = parsedLog.args as unknown as SwapUnderwrittenEvent.OutputObject;
        
        const underwriteId = event.identifier;
    
        this.logger.info(
            { interfaceAddress: log.address, txHash: log.transactionHash, underwriteId },
            `SwapUnderwritten event captured.`
        );
    
        const underwriteState: UnderwriteState = {
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
        parsedLog: LogDescription
    ): Promise<void> {

        const interfaceAddress = log.address;
        const event = parsedLog.args as unknown as FulfillUnderwriteEvent.OutputObject;
        
        const underwriteId = event.identifier;
    
        this.logger.info(
            { interfaceAddress: log.address, txHash: log.transactionHash, underwriteId },
            `FulfillUnderwrite event captured.`
        );
    
        const underwriteState: UnderwriteState = {
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
        parsedLog: LogDescription
    ): Promise<void> {

        const interfaceAddress = log.address;
        const event = parsedLog.args as unknown as ExpireUnderwriteEvent.OutputObject;
        
        const underwriteId = event.identifier;
    
        this.logger.info(
            { interfaceAddress: log.address, txHash: log.transactionHash, underwriteId },
            `ExpireUnderwrite event captured.`
        );
    
        const underwriteState: UnderwriteState = {
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



    // Websocket handlers
    // ********************************************************************************************

    private async processAMBMessage(
        ambMessage: any,    //TODO type
    ): Promise<void> {
        
        const giPayload = parsePayload(ambMessage.payload);
        if (giPayload.context != MessageContext.CTX_SOURCE_TO_DESTINATION) return;

        // Verify the sending Catalyst interface and GI escrow are trusted
        const sourceApplication = giPayload.sourceApplicationAddress;   // ! NOTE: this address cannot be trusted until the source escrow implementation is verified

        // TODO implement the following NOTE
        // NOTE: the 'interfaceAddress' fields within the 'endpointConfigs' array are unique (verified on config service)
        const endpointConfig = this.config.endpointConfigs.find((endpointConfig) => {
            return endpointConfig.interfaceAddress == sourceApplication.toLowerCase();
        });

        if (endpointConfig == undefined) {
            this.logger.info(
                { sourceApplication },
                "Skipping AMB message: source application is not a configured endpoint."
            );
            return;
        }

        // ! Verify the sending escrow matches the expected one for the found interface address
        if (endpointConfig.incentivesAddress != ambMessage.sourceEscrow.toLowerCase()) {
            this.logger.info(
                { sourceApplication },
                "Skipping AMB message: source escrow (incentives address) does not match the configured endpoint (possible malicious AMB payload)."
            );
            return;
        }

        const catalystPayload = catalystParse(giPayload.message);
        if (catalystPayload.context != CatalystContext.ASSET_SWAP) return;
        
        let blockNumber = ambMessage.blockNumber;
        if (blockNumber == undefined) {
            // NOTE: this may happen for AMBs which are 'recovered' by the relayer (i.e. old AMBs).
            this.logger.info(
                { messageIdentifier: giPayload.messageIdentifier },
                "Unable to process AMB message. Block number missing"
            );
            return;
        }

        //TODO implement a better (generic) block number fix (should this be implemented on the relayer?)
        if (this.chainId == '421614') { // Arbitrum sepolia
            const blockData = await this.provider.send(
                "eth_getBlockByNumber",
                ["0x"+blockNumber.toString(16), false]
            );
            blockNumber = blockData.l1BlockNumber;
        }

        await this.processCatalystSwap(
            ambMessage,
            giPayload,
            catalystPayload,
            endpointConfig
        );

    }

    private async processCatalystSwap(
        ambMessageMetadata: any,    //TODO type
        incentivesMessage: SOURCE_TO_DESTINATION,
        assetSwapPayload: ASSET_SWAP,
        originEndpoint: EndpointConfig
    ) {

        const fromVault = assetSwapPayload.fromVault;

        const swapId = calcAssetSwapIdentifier(
            assetSwapPayload.toAccount,
            assetSwapPayload.units,
            assetSwapPayload.fromAmount,
            assetSwapPayload.fromAsset,
            assetSwapPayload.blockNumber
        );

        const fromChannelId = originEndpoint.channelsOnDestination[ambMessageMetadata.destinationChain];
        if (fromChannelId == undefined) {
            this.logger.info(
                {
                    txHash: ambMessageMetadata.transactionHash,
                    sourceVault: fromVault,
                    swapId,
                    fromInterfaceAddress: incentivesMessage.sourceApplicationAddress,
                    fromIncentivesAddress: ambMessageMetadata.sourceEscrow,
                    toChainId: ambMessageMetadata.destinationChain
                },
                `'fromChannelId' for the given swap not found. Skipping.`
            );
            return;
        }

        const blockNumber = ambMessageMetadata.blockNumber;
        const blockTimestamp = await this.getBlockTimestamp(blockNumber);
        if (blockTimestamp == null) {
            this.logger.warn(
                { 
                    blockNumber,
                },
                `Dropping swap. No timestamp for the block number found.`
            );
            return;
        }

        const swapState: SwapState = {
            fromChainId: this.chainId,
            fromVault: assetSwapPayload.fromVault,
            swapId,
            status: SwapStatus.Pending,
            ambMessageSendAssetDetails: {
                txHash: ambMessageMetadata.transactionHash,
                blockHash: ambMessageMetadata.blockHash,
                blockNumber,
        
                amb: ambMessageMetadata.amb,
                toChainId: ambMessageMetadata.destinationChain,
                messageIdentifier: ambMessageMetadata.messageIdentifier,

                toIncentivesAddress: "", // TODO: is this wanted/needed?
                toApplication: incentivesMessage.toApplication,
                deadline: incentivesMessage.deadline,
                maxGasDelivery: incentivesMessage.maxGasLimit,

                fromChannelId,
        
                fromVault: assetSwapPayload.fromVault,
                toVault: assetSwapPayload.toVault,
                toAccount: assetSwapPayload.toAccount,
                units: assetSwapPayload.units,
                toAssetIndex: BigInt(assetSwapPayload.toAssetIndex),
                minOut: assetSwapPayload.minOut,
                swapAmount: assetSwapPayload.fromAmount,
                fromAsset: assetSwapPayload.fromAsset,
                blockNumberMod: BigInt(assetSwapPayload.blockNumber),
                underwriteIncentiveX16: BigInt(assetSwapPayload.underwritingIncentive),
                calldata: assetSwapPayload.cdata,

                blockTimestamp,
                observedAtBlockNumber: this.currentStatus!.blockNumber,
            },
        }
    
        await this.store.saveSwapState(swapState);
    }
}

void new ListenerWorker().run();
